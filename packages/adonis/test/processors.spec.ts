import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type InputProcessor,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  OutputRejectedError,
  ProcessorFailedError,
  runAgentLoop,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import {
  echoScript,
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** A provider that streams its answer one character at a time — what an incremental gate rules on. */
class ChunkedModel implements ModelProvider {
  constructor(private readonly answers: string[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = this.answers[turnIndex] ?? '';
    for (const char of text) {
      await args.sink.write({ t: 'text', v: char });
    }
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: text.length } };
  }
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'ping', kind: 'read', description: 'ping', inputSchema: z.object({}) },
    { execute: async () => ({ pong: true }) },
  );
  return registry;
}

interface RunOptions {
  script?: FakeScript;
  model?: ModelProvider;
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
  journal?: Journal;
}

async function run(options: RunOptions = {}) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  const runId = 'run-1';
  const journal = options.journal;

  const deps: AgentLoopDeps = {
    model: options.model ?? new FakeModelProvider(options.script ?? echoScript('hello world')),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'base prompt',
    ...(options.inputProcessors !== undefined ? { inputProcessors: options.inputProcessors } : {}),
    ...(options.outputProcessors !== undefined
      ? { outputProcessors: options.outputProcessors }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: journal === undefined ? (_name, fn) => fn() : (name, fn) => journal.at(name, fn),
  };

  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'hi' },
    hooks,
  );
  const frames: StreamFrame[] = [];
  for await (const frame of sink.subscribe(runId)) {
    frames.push(frame);
  }
  return { result, frames, store, detail: await store.getThread(thread.id) };
}

/** Every text frame a subscriber saw, in order — the reader's view of how the turn arrived. */
function textFrames(frames: StreamFrame[]): string[] {
  return frames.filter((frame) => frame.t === 'text').map((frame) => frame.v);
}

const upperCase: InputProcessor = {
  name: 'upper',
  process: (prompt) => ({
    system: prompt.system.toUpperCase(),
    messages: prompt.messages.map((message) => ({
      ...message,
      content: message.content.toUpperCase(),
    })),
  }),
};

describe('input processors', () => {
  it('rewrites the prompt the model is handed', async () => {
    const seen: string[] = [];
    const model: ModelProvider = {
      runTurn: async (args) => {
        seen.push(args.system, ...args.messages.map((message) => message.content));
        await args.sink.write({ t: 'text', v: 'ok' });
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await run({ model, inputProcessors: [upperCase] });
    expect(seen).toEqual(['BASE PROMPT', 'HI']);
  });

  it('leaves the thread’s own memory of what was said untouched', async () => {
    const { detail } = await run({ inputProcessors: [upperCase] });
    expect(detail?.messages[0]?.content).toBe('hi');
  });

  it('runs on every model call of the turn, not once per run', async () => {
    const steps: number[] = [];
    const counting: InputProcessor = {
      name: 'counting',
      process: (prompt, ctx) => {
        steps.push(ctx.step);
        return prompt;
      },
    };
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'ping', input: {} } }
        : { text: 'done' };
    await run({ script, inputProcessors: [counting] });
    expect(steps).toEqual([0, 1]);
  });

  it('rewrites a derived prompt, so redactions never compound across steps', async () => {
    const seen: string[] = [];
    const stamping: InputProcessor = {
      name: 'stamping',
      process: (prompt) => {
        seen.push(prompt.system);
        return { ...prompt, system: `${prompt.system} [stamped]` };
      },
    };
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'ping', input: {} } }
        : { text: 'done' };
    await run({ script, inputProcessors: [stamping] });
    // The second step saw the ORIGINAL prompt again, not the first step's stamped one.
    expect(seen).toEqual(['base prompt', 'base prompt']);
  });

  it('names the processor and the phase when one throws', async () => {
    const boom: InputProcessor = {
      name: 'boom',
      process: () => {
        throw new Error('redactor is down');
      },
    };
    await expect(run({ inputProcessors: [boom] })).rejects.toThrow(ProcessorFailedError);
    await expect(run({ inputProcessors: [boom] })).rejects.toThrow(
      'input processor "boom" failed: redactor is down',
    );
  });

  it('spends a checkpoint only when one is configured', async () => {
    const bare = new Journal();
    await run({ journal: bare });
    expect(bare.names()).not.toContain('process:input:0');

    const gated = new Journal();
    await run({ journal: gated, inputProcessors: [upperCase] });
    expect(gated.names()).toContain('process:input:0');
  });
});

const redactEmails: OutputProcessor = {
  name: 'redact-emails',
  process: (answer) => ({
    action: 'replace',
    text: answer.text.replace(/[\w.]+@[\w.]+/g, '[email]'),
  }),
};

const refuseSecrets: OutputProcessor = {
  name: 'refuse-secrets',
  process: (answer) =>
    answer.text.includes('secret')
      ? { action: 'reject', reason: 'the answer named a secret' }
      : { action: 'pass' },
};

describe('output processors (whole-answer gate)', () => {
  it('streams and persists the replacement, never the model’s own text', async () => {
    const { result, frames, detail } = await run({
      script: echoScript('write to a@b.com'),
      outputProcessors: [redactEmails],
    });
    expect(result.text).toBe('write to [email]');
    expect(textFrames(frames)).toEqual(['write to [email]']);
    expect(detail?.messages[1]?.content).toBe('write to [email]');
  });

  it('holds the model’s own frames back, releasing the answer as one frame', async () => {
    const { frames } = await run({
      model: new ChunkedModel(['abcdef']),
      outputProcessors: [redactEmails],
    });
    expect(textFrames(frames)).toEqual(['abcdef']);
  });

  it('streams token by token when nothing is registered', async () => {
    const { frames } = await run({ model: new ChunkedModel(['abcdef']) });
    expect(textFrames(frames)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('fails the run on a refusal, streams nothing, and still bills the tokens', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const deps: AgentLoopDeps = {
      model: new FakeModelProvider(echoScript('here is the secret')),
      store,
      registry: buildRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-06-30',
      systemPrompt: 'base',
      outputProcessors: [refuseSecrets],
    };
    await expect(
      runAgentLoop(
        deps,
        { threadId: thread.id, actor: ACTOR, userText: 'hi' },
        {
          runId: 'run-1',
          openSink: () => sink.open('run-1'),
          awaitApproval: async () => ({ approved: true }),
          step: (_name, fn) => fn(),
        },
      ),
    ).rejects.toThrow(OutputRejectedError);
    sink.open('run-1').end();
    const frames: StreamFrame[] = [];
    for await (const frame of sink.subscribe('run-1')) frames.push(frame);
    expect(textFrames(frames)).toEqual([]);
    // Those tokens were genuinely spent: a gate that hid its own cost would burn a budget invisibly.
    expect(store.usageRows().map((row) => row.purpose)).toEqual(['chat']);
    // The refused answer never became the thread's memory of what was said.
    expect((await store.getThread(thread.id))?.messages.map((message) => message.role)).toEqual([
      'user',
    ]);
  });

  it('stops the chain at the first refusal', async () => {
    const later: OutputProcessor = {
      name: 'later',
      process: () => {
        throw new Error('should never run');
      },
    };
    await expect(
      run({ script: echoScript('the secret'), outputProcessors: [refuseSecrets, later] }),
    ).rejects.toThrow(OutputRejectedError);
  });

  it('spends a checkpoint only when one is configured', async () => {
    const bare = new Journal();
    await run({ journal: bare });
    expect(bare.names()).not.toContain('process:output:0');

    const gated = new Journal();
    await run({ journal: gated, outputProcessors: [redactEmails] });
    expect(gated.names()).toContain('process:output:0');
  });
});

const incrementalRedact: OutputProcessor = {
  name: 'incremental-redact',
  incremental: { lookbackChars: 4 },
  process: (answer) => ({ action: 'replace', text: answer.text.replace(/xxxx/g, '####') }),
};

describe('output processors (incremental gate)', () => {
  it('keeps streaming a lookback-bounded prefix', async () => {
    const { frames, result } = await run({
      model: new ChunkedModel(['abcdefghij']),
      outputProcessors: [incrementalRedact],
    });
    expect(result.text).toBe('abcdefghij');
    // Every character but the last `lookbackChars` arrives live; the tail comes with the gate.
    expect(textFrames(frames).length).toBeGreaterThan(1);
    expect(textFrames(frames).join('')).toBe('abcdefghij');
  });

  it('still redacts a pattern that only completes inside the window', async () => {
    const { result, frames } = await run({
      model: new ChunkedModel(['ab xxxx cd']),
      outputProcessors: [incrementalRedact],
    });
    expect(result.text).toBe('ab #### cd');
    expect(textFrames(frames).join('')).toBe('ab #### cd');
  });

  it('downgrades the whole chain when one member declares nothing', async () => {
    const { frames } = await run({
      model: new ChunkedModel(['abcdefghij']),
      outputProcessors: [incrementalRedact, redactEmails],
    });
    expect(textFrames(frames)).toEqual(['abcdefghij']);
  });

  it('fails loudly when a declared processor breaks its prefix promise', async () => {
    const unstable: OutputProcessor = {
      name: 'unstable',
      incremental: { lookbackChars: 0 },
      // Rewrites from the FRONT once the answer is long enough, so what it released stops being a
      // prefix of what it finally says.
      process: (answer) => ({
        action: 'replace',
        text: answer.text.length > 5 ? `!${answer.text.slice(1)}` : answer.text,
      }),
    };
    await expect(
      run({ model: new ChunkedModel(['abcdefghij']), outputProcessors: [unstable] }),
    ).rejects.toThrow(ProcessorFailedError);
  });

  it('carries a prefix refusal out of the model checkpoint instead of re-deciding it', async () => {
    const seen: string[] = [];
    const refuseOnPrefix: OutputProcessor = {
      name: 'refuse-on-prefix',
      incremental: { lookbackChars: 0 },
      process: (answer) => {
        seen.push(answer.text);
        return answer.text.includes('bad')
          ? { action: 'reject', reason: 'said bad' }
          : { action: 'pass' };
      },
    };
    await expect(
      run({ model: new ChunkedModel(['a bad thing']), outputProcessors: [refuseOnPrefix] }),
    ).rejects.toThrow('Output rejected by "refuse-on-prefix": said bad');
    // The gate step returned the journaled refusal: the chain never saw the finished answer, so a
    // moderation call would not have been billed a second time for a verdict already reached.
    expect(seen).not.toContain('a bad thing');
    expect(seen.at(-1)).toBe('a bad');
  });

  it('owes only the tail when a run resumes between the model call and the gate', async () => {
    let failTheGate = true;
    const flaky: OutputProcessor = {
      name: 'flaky',
      incremental: { lookbackChars: 4 },
      process: (answer) => {
        if (failTheGate && answer.text === 'abcdefghij') {
          throw new Error('moderation call timed out');
        }
        return { action: 'pass' };
      },
    };
    const journal = new Journal();
    const attempt = () =>
      run({ journal, model: new ChunkedModel(['abcdefghij']), outputProcessors: [flaky] });

    // The first attempt released the lookback-bounded prefix, then died in the gate.
    await expect(attempt()).rejects.toThrow(ProcessorFailedError);
    journal.rewind();
    failTheGate = false;

    // The resume never saw that stream. What it still owes comes off the journaled model result,
    // so the reader gets the tail rather than the answer a second time.
    const resumed = await attempt();
    expect(resumed.result.text).toBe('abcdefghij');
    expect(textFrames(resumed.frames)).toEqual(['fghij']);
  });
});
