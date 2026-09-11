import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  extractJson,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  OutputRejectedError,
  runAgentLoop,
  StructuredOutputError,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const SCHEMA = z.object({ city: z.string(), tempC: z.number() });

/** One entry of the script: what the model says, and whether it reports a parsed object. */
interface Reply {
  text: string;
  object?: unknown;
  toolCall?: { name: string; input: unknown };
}

/**
 * A provider that records every call it was given, so a test can tell the streamed turn apart from
 * the formatting pass and inspect exactly what each was shown.
 */
class ScriptedModel implements ModelProvider {
  readonly calls: ModelTurnArgs[] = [];

  constructor(private readonly replies: Reply[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.calls.push(args);
    const reply = this.replies[this.calls.length - 1] ?? { text: '' };
    await args.sink.write({ t: 'text', v: reply.text });
    return {
      text: reply.text,
      toolCalls:
        reply.toolCall !== undefined
          ? [{ id: `call-${this.calls.length}`, ...reply.toolCall }]
          : [],
      usage: { inputTokens: 1, outputTokens: reply.text.length },
      ...(reply.object !== undefined ? { object: reply.object } : {}),
    };
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
  model: ModelProvider;
  journal?: Journal;
  repairAttempts?: number;
  fromTranscript?: boolean;
  outputProcessors?: OutputProcessor[];
  schema?: AgentLoopDeps<{ city: string; tempC: number }>['outputSchema'];
}

async function run(options: RunOptions) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  const journal = options.journal;
  const deps: AgentLoopDeps<{ city: string; tempC: number }> = {
    model: options.model,
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'base prompt',
    outputSchema: options.schema ?? SCHEMA,
    ...(options.repairAttempts !== undefined
      ? { outputRepairAttempts: options.repairAttempts }
      : {}),
    ...(options.fromTranscript === true ? { outputFromTranscript: true } : {}),
    ...(options.outputProcessors !== undefined
      ? { outputProcessors: options.outputProcessors }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: journal === undefined ? (_name, fn) => fn() : (name, fn) => journal.at(name, fn),
  };
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'weather in Recife?' },
    hooks,
  );
  const streamed: string[] = [];
  for await (const frame of sink.subscribe('run-1')) {
    if (frame.t === 'text') streamed.push(frame.v);
  }
  return { result, store, streamed, detail: await store.getThread(thread.id) };
}

describe('extractJson', () => {
  it('reads plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON out of fences and lead-in prose', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads a top-level array', () => {
    expect(extractJson('here: [1,2]')).toEqual([1, 2]);
  });

  it('says nothing when there is no JSON at all, which a JSON null is not', () => {
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('null')).toBeNull();
  });
});

describe('structured output', () => {
  it('returns the validated value and leaves the prose as the answer', async () => {
    const model = new ScriptedModel([
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { result } = await run({ model });
    expect(result.text).toBe('It is 21C in Recife.');
    expect(result.object).toEqual({ city: 'Recife', tempC: 21 });
  });

  it('records the value as a synthetic tool call on the message it belongs to', async () => {
    const model = new ScriptedModel([
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { store, detail } = await run({ model });
    const row = store.toolCallRows().find((call) => call.toolName === 'structured_output');
    expect(row).toMatchObject({ status: 'executed' });
    expect(row?.output).toEqual({ city: 'Recife', tempC: 21 });
    // It hangs off the assistant message it belongs to, exactly as inject-mode retrieval does.
    expect(
      store.governanceToolCalls().find((call) => call.toolName === 'structured_output'),
    ).toMatchObject({ toolType: 'read', runId: 'run-1' });
    expect(detail?.messages.at(-1)?.role).toBe('assistant');
  });

  it('reaches a reader as an ordinary tool call: on the message, with its result paired', async () => {
    const model = new ScriptedModel([
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { detail } = await run({ model });
    const answer = detail?.messages.at(-1);
    // A client that renders tool calls renders this one with no change — the call is on the
    // message and its result is paired with it there, so nothing has to read the tool-call table.
    expect(answer?.toolCalls).toEqual([
      { id: 'structured-run-1', name: 'structured_output', input: {} },
    ]);
    expect(answer?.toolResults).toEqual([
      {
        id: 'structured-run-1',
        name: 'structured_output',
        output: { city: 'Recife', tempC: 21 },
      },
    ]);
  });

  it('bills the pass as its own usage row', async () => {
    const model = new ScriptedModel([
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { store } = await run({ model });
    expect(store.usageRows().map((row) => row.purpose)).toEqual(['chat', 'structured_output']);
  });

  it('never streams the formatting pass to the reader', async () => {
    const model = new ScriptedModel([
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { streamed } = await run({ model });
    expect(streamed).toEqual(['It is 21C in Recife.']);
  });

  it('shows the pass the question and the answer, not the whole transcript', async () => {
    const model = new ScriptedModel([
      { text: 'checking', toolCall: { name: 'ping', input: {} } },
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    await run({ model });
    const pass = model.calls[2];
    expect(pass?.tools).toEqual([]);
    expect(pass?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(pass?.messages[0]?.content).toBe('weather in Recife?');
    expect(pass?.messages[1]?.content).toBe('It is 21C in Recife.');
  });

  it('shows the pass the whole transcript when the agent asks for it', async () => {
    const model = new ScriptedModel([
      { text: 'checking', toolCall: { name: 'ping', input: {} } },
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    await run({ model, fromTranscript: true });
    expect((model.calls[2]?.messages.length ?? 0) > 2).toBe(true);
  });

  it('runs the pass after the tool iteration has finished, never alongside it', async () => {
    const model = new ScriptedModel([
      { text: 'checking', toolCall: { name: 'ping', input: {} } },
      { text: 'It is 21C in Recife.' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const journal = new Journal();
    await run({ model, journal });
    const names = journal.names();
    expect(names.filter((name) => name.startsWith('structured:'))).toEqual(['structured:1:0']);
    expect(names.indexOf('structured:1:0')).toBeGreaterThan(names.indexOf('tool:call-1'));
  });

  it('runs the pass even for an agent whose turn called no tool at all', async () => {
    const model = new ScriptedModel([{ text: 'plain' }, { text: '{"city":"R","tempC":1}' }]);
    const journal = new Journal();
    await run({ model, journal });
    expect(journal.names()).toContain('structured:0:0');
  });

  it('validates what the provider reported rather than trusting it', async () => {
    const model = new ScriptedModel([
      { text: 'answer' },
      { text: 'ignored', object: { city: 'Recife', tempC: 'twenty-one' } },
    ]);
    await expect(run({ model, repairAttempts: 0 })).rejects.toThrow(StructuredOutputError);
  });

  it('prefers the provider’s parsed object over re-reading the text', async () => {
    const model = new ScriptedModel([
      { text: 'answer' },
      { text: 'not json at all', object: { city: 'Recife', tempC: 21 } },
    ]);
    const { result } = await run({ model });
    expect(result.object).toEqual({ city: 'Recife', tempC: 21 });
  });

  it('repairs an invalid reply once by default, showing it what failed', async () => {
    const model = new ScriptedModel([
      { text: 'answer' },
      { text: '{"city":"Recife"}' },
      { text: '{"city":"Recife","tempC":21}' },
    ]);
    const { result } = await run({ model });
    expect(result.object).toEqual({ city: 'Recife', tempC: 21 });
    expect(model.calls[2]?.system).toContain('previous reply was rejected');
    expect(model.calls[2]?.system).toContain('tempC');
  });

  it('fails with the issues and the text once the repairs run out', async () => {
    const model = new ScriptedModel([
      { text: 'answer' },
      { text: '{"city":"Recife"}' },
      { text: '{"city":"Recife"}' },
    ]);
    await expect(run({ model })).rejects.toMatchObject({
      name: 'StructuredOutputError',
      attempts: 2,
      text: '{"city":"Recife"}',
    });
  });

  it('fails on the first invalid reply when repairs are turned off', async () => {
    const model = new ScriptedModel([{ text: 'answer' }, { text: 'not json' }]);
    await expect(run({ model, repairAttempts: 0 })).rejects.toMatchObject({ attempts: 1 });
    expect(model.calls).toHaveLength(2);
  });

  it('spends no checkpoint and no model call when no schema is declared', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const model = new ScriptedModel([{ text: 'plain answer' }]);
    const journal = new Journal();
    const result = await runAgentLoop(
      {
        model,
        store,
        registry: buildRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base prompt',
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: 'run-1',
        openSink: () => sink.open('run-1'),
        awaitApproval: async () => ({ approved: true }),
        step: (name, fn) => journal.at(name, fn),
      },
    );
    expect(result.object).toBeUndefined();
    expect(model.calls).toHaveLength(1);
    expect(journal.names().some((name) => name.startsWith('structured:'))).toBe(false);
  });
});

describe('structured output and the output gate', () => {
  const refuseSecrets: OutputProcessor = {
    name: 'refuse-secrets',
    process: (answer) =>
      answer.text.includes('secret')
        ? { action: 'reject', reason: 'the reply named a secret' }
        : { action: 'pass' },
  };

  it('rules on the formatting pass too, so nothing leaves through the schema', async () => {
    const model = new ScriptedModel([
      { text: 'clean answer' },
      { text: '{"city":"secret base","tempC":21}' },
    ]);
    await expect(run({ model, outputProcessors: [refuseSecrets] })).rejects.toThrow(
      OutputRejectedError,
    );
  });

  it('re-parses the gated text rather than the provider’s object once the chain rewrote it', async () => {
    const rewrite: OutputProcessor = {
      name: 'rewrite',
      process: () => ({ action: 'replace', text: '{"city":"Redacted","tempC":0}' }),
    };
    const model = new ScriptedModel([
      { text: 'answer' },
      { text: '{"city":"Recife","tempC":21}', object: { city: 'Recife', tempC: 21 } },
    ]);
    const { result } = await run({ model, outputProcessors: [rewrite] });
    expect(result.object).toEqual({ city: 'Redacted', tempC: 0 });
  });
});
