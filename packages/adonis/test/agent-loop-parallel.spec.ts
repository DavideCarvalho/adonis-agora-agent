import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgentLoopDeps,
  AgentLoopHooks,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
} from '../src/index.js';
import { DefaultRolesPolicy, runAgentLoop, settleAll, ToolRegistry } from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** Asks for every one of `calls` in ONE turn, then finishes — what a model routinely does. */
class MultiToolModel implements ModelProvider {
  constructor(private readonly calls: { id: string; name: string }[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'looking' : 'done';
    await args.sink.write({ t: 'text', v: text });
    return {
      text,
      toolCalls: turnIndex === 0 ? this.calls.map((call) => ({ ...call, input: {} })) : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function withDeadline<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 1000).unref?.();
    }),
  ]);
}

interface FakeTool {
  kind?: 'read' | 'action';
  execute: () => Promise<unknown>;
}

function registryOf(tools: Record<string, FakeTool>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, tool] of Object.entries(tools)) {
    registry.register(
      { name, kind: tool.kind ?? 'read', description: name, inputSchema: z.object({}) },
      { execute: tool.execute },
    );
  }
  return registry;
}

interface PassOptions {
  journal: Journal;
  tools: Record<string, FakeTool>;
  calls: { id: string; name: string }[];
  /** Off = the loop must run the turn's calls one at a time, exactly as it always has. */
  concurrent?: boolean;
}

interface PassResult {
  text: string;
  /** Every settled tool call, as the loop persisted it — the call id paired with its output. */
  settled: { id: string; status: string; output: unknown }[];
}

async function pass(options: PassOptions): Promise<PassResult> {
  const { journal, tools, calls } = options;
  const store = new InMemoryAgentStore();
  const settled: { id: string; status: string; output: unknown }[] = [];
  const record = store.updateToolCall.bind(store);
  store.updateToolCall = async (update) => {
    settled.push({ id: update.toolCallId, status: update.status, output: update.output });
    await record(update);
  };
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  const deps: AgentLoopDeps = {
    model: new MultiToolModel(calls),
    store,
    registry: registryOf(tools),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    step: (name, fn) => journal.at(name, () => fn()),
    ...(options.concurrent === true
      ? { parallel: settleAll, patched: (id) => journal.patched(id) }
      : {}),
  };
  journal.rewind();
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'hi' },
    hooks,
  );
  return { text: result.text, settled };
}

describe('agent loop — concurrent tool calls', () => {
  it('overlaps a turn whose calls are all reads', async () => {
    const alphaStarted = deferred();
    const betaStarted = deferred();
    await withDeadline(
      pass({
        journal: new Journal(),
        concurrent: true,
        calls: [
          { id: 'call-a', name: 'alpha' },
          { id: 'call-b', name: 'beta' },
        ],
        tools: {
          // Each tool blocks until the OTHER has started, so this turn can only finish if the two
          // invocations are in flight at the same time.
          alpha: {
            execute: async () => {
              alphaStarted.resolve();
              await betaStarted.promise;
              return { from: 'alpha' };
            },
          },
          beta: {
            execute: async () => {
              betaStarted.resolve();
              await alphaStarted.promise;
              return { from: 'beta' };
            },
          },
        },
      }),
      'the turn never finished — the two read tools did not overlap',
    );
  });

  it('keeps every checkpoint in call order: claims, then invocations, then persists', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        // The FIRST call is the slow one, so every position it holds — its invocation and its
        // persist — is one a completion-ordered scheme would have handed to `beta` instead.
        alpha: {
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { from: 'alpha' };
          },
        },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'tool:call-b',
      'persist:toolexec:call-a',
      'persist:toolexec:call-b',
    ]);
  });

  it('replays a turn a refused position unwound, onto the same positions and outputs', async () => {
    const journal = new Journal();
    let refuseOnce = true;
    const tools: Record<string, FakeTool> = {
      alpha: { execute: async () => ({ from: 'alpha' }) },
      // Refuses its position the first time it is reached — the engine handing the turn back — and
      // completes on the resume.
      beta: {
        execute: async () => {
          if (refuseOnce) {
            refuseOnce = false;
            const refusal = new Error(`non-determinism at ${RUN_ID}#9`);
            refusal.name = 'NonDeterminismError';
            throw refusal;
          }
          return { from: 'beta' };
        },
      },
    };
    const calls = [
      { id: 'call-a', name: 'alpha' },
      { id: 'call-b', name: 'beta' },
    ];

    await expect(pass({ journal, tools, calls, concurrent: true })).rejects.toThrow(
      'non-determinism',
    );
    // Nothing was persisted for the sibling that DID finish: its `persist:toolexec` would sit at
    // the position the resume computes for call-a's, and the two calls' outputs would swap.
    expect(journal.names()).not.toContain('persist:toolexec:call-a');

    const resumed = await pass({ journal, tools, calls, concurrent: true });
    expect(resumed.text).toBe('done');
    expect(resumed.settled).toEqual([
      { id: 'call-a', status: 'executed', output: { from: 'alpha' } },
      { id: 'call-b', status: 'executed', output: { from: 'beta' } },
    ]);
    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'tool:call-b',
      'persist:toolexec:call-a',
      'persist:toolexec:call-b',
    ]);
  });

  it('runs the calls one at a time when the runner offers no deterministic concurrency', async () => {
    const journal = new Journal();
    await pass({
      journal,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        alpha: { execute: async () => ({ from: 'alpha' }) },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(journal.toolNames().slice(0, 6)).toEqual([
      'persist:toolcall:call-a',
      'tool:call-a',
      'persist:toolexec:call-a',
      'persist:toolcall:call-b',
      'tool:call-b',
      'persist:toolexec:call-b',
    ]);
  });

  it('leaves a single-call turn on the checkpoint sequence it always had', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [{ id: 'call-a', name: 'alpha' }],
      tools: { alpha: { execute: async () => ({ from: 'alpha' }) } },
    });

    expect(journal.toolNames().slice(0, 3)).toEqual([
      'persist:toolcall:call-a',
      'tool:call-a',
      'persist:toolexec:call-a',
    ]);
  });

  it('runs a turn containing an action sequentially, approval and execution per call', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'purge' },
      ],
      tools: {
        alpha: { execute: async () => ({ from: 'alpha' }) },
        purge: { kind: 'action', execute: async () => ({ purged: true }) },
      },
    });

    expect(journal.toolNames().slice(0, 8)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'persist:toolexec:call-a',
      `signal:tool:${RUN_ID}:call-b`,
      'tool:call-b',
      'persist:toolexec:call-b',
    ]);
  });

  it('keeps replaying a run that recorded the sequential shape before the batched one existed', async () => {
    const journal = new Journal();
    const tools = {
      alpha: { execute: async () => ({ from: 'alpha' }) },
      beta: { execute: async () => ({ from: 'beta' }) },
    };
    const calls = [
      { id: 'call-a', name: 'alpha' },
      { id: 'call-b', name: 'beta' },
    ];

    // Recorded by a process that had no concurrency hooks at all.
    await pass({ journal, tools, calls });
    const recorded = journal.names();

    // Resumed by one that has them: the version gate must give the position back.
    const resumed = await pass({ journal, tools, calls, concurrent: true });
    expect(resumed.text).toBe('done');
    expect(journal.names()).toEqual(recorded);
  });

  it('records one call as failed without touching its concurrent sibling', async () => {
    const journal = new Journal();
    const run = await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        alpha: {
          execute: async () => {
            throw new Error('alpha blew up');
          },
        },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(run.text).toBe('done');
    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'tool:call-b',
      'persist:toolfail:call-a',
      'persist:toolexec:call-b',
    ]);
  });
});

describe('settleAll', () => {
  it('starts every task before awaiting any of them', async () => {
    const started: number[] = [];
    const outcomes = await settleAll([
      async () => {
        started.push(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'first';
      },
      async () => {
        started.push(1);
        return 'second';
      },
    ]);

    expect(started).toEqual([0, 1]);
    expect(outcomes).toEqual([
      { ok: true, value: 'first' },
      { ok: true, value: 'second' },
    ]);
  });

  it('reports a rejection instead of throwing, and still waits for the others', async () => {
    const boom = new Error('boom');
    let slowFinished = false;
    const outcomes = await settleAll([
      async () => {
        throw boom;
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        slowFinished = true;
        return 'slow';
      },
    ]);

    expect(slowFinished).toBe(true);
    expect(outcomes).toEqual([
      { ok: false, error: boom },
      { ok: true, value: 'slow' },
    ]);
  });
});
