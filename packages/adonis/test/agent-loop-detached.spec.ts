import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentStore,
  DefaultRolesPolicy,
  type RecordRunStartInput,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * Detached delegation in the loop: the branch is settled inside `persist:toolcall`, the turn's
 * result is a receipt, and the child's answer is delivered by the child's own `deliver:detached`
 * checkpoint. After `nestjs-agent`'s `core/src/agent-loop.detached.spec.ts`.
 */

/** Two delegate tools onto the same target agent, differing only in `detached`. */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'ask_research',
      kind: 'agent',
      targetAgent: 'research',
      description: 'delegate and wait',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({}) },
  );
  registry.register(
    {
      name: 'start_research',
      kind: 'agent',
      targetAgent: 'research',
      detached: true,
      description: 'delegate and keep talking',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({}) },
  );
  return registry;
}

interface RunArgs {
  script: FakeScript;
  input?: Partial<AgentRunInput>;
  startAgent?: AgentLoopHooks['startAgent'];
  runAgent?: AgentLoopHooks['runAgent'];
  /** Pre-seeded `hooks.step` results, keyed by checkpoint name — a replay against a journal. */
  journal?: Record<string, unknown>;
  store?: InMemoryAgentStore;
  runId?: string;
  maxDelegationDepth?: number;
}

async function run(args: RunArgs) {
  const store = args.store ?? new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const runId = args.runId ?? 'run-parent';
  const actor = { id: 'u1', roles: ['ADMIN'] };
  const threadId = (await store.createThread({ actor, persona: 'default' })).id;
  const stepNames: string[] = [];
  const stepResults: Record<string, unknown> = {};
  const runStarts: RecordRunStartInput[] = [];
  const recordRunStart = store.recordRunStart.bind(store);
  (store as AgentStore).recordRunStart = async (input) => {
    runStarts.push(input);
    await recordRunStart(input);
  };

  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(args.script),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(['ADMIN']),
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(args.maxDelegationDepth !== undefined
      ? { maxDelegationDepth: args.maxDelegationDepth }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: async (name, fn) => {
      stepNames.push(name);
      if (args.journal !== undefined && name in args.journal) {
        return JSON.parse(JSON.stringify(args.journal[name])) as never;
      }
      const value = await fn();
      stepResults[name] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      return value;
    },
    ...(args.startAgent !== undefined ? { startAgent: args.startAgent } : {}),
    ...(args.runAgent !== undefined ? { runAgent: args.runAgent } : {}),
  };

  const result = await runAgentLoop(
    deps,
    { threadId, actor, userText: 'hi', ...args.input },
    hooks,
  );
  return { result, store, stepNames, stepResults, runStarts, threadId, sink, runId };
}

/** Turn 0 calls `name`; turn 1 answers, quoting whatever the tool handed back. */
function delegateThenAnswer(name: string): FakeScript {
  return (args, turnIndex) =>
    turnIndex === 0
      ? { text: 'on it', toolCall: { name, input: { task: 'summarize the incident' } } }
      : {
          text: `saw: ${JSON.stringify((args.messages.at(-1)?.toolResults ?? []).map((r) => r.error ?? r.output))}`,
        };
}

describe('detached delegation', () => {
  it('ends the turn with a receipt instead of the sub-agent answer', async () => {
    const started: { agentName: string; task: string; toolCallId: string }[] = [];
    const awaited: string[] = [];
    const { result, store } = await run({
      script: delegateThenAnswer('start_research'),
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
      runAgent: async (agentName) => {
        awaited.push(agentName);
        return { text: 'THE ANSWER' };
      },
    });

    expect(started).toEqual([
      {
        agentName: 'research',
        task: 'summarize the incident',
        toolCallId: 'call-0-start_research',
      },
    ]);
    // The awaiting hook is the one that would have blocked the turn — it must not be reached.
    expect(awaited).toEqual([]);
    // The model is told the work STARTED, and never handed a result it does not have.
    expect(result.text).toContain('"status":"started"');
    expect(result.text).toContain('"runId":"run-child"');
    expect(result.text).not.toContain('THE ANSWER');
    const row = store.toolCallRows().find((each) => each.toolName === 'start_research');
    expect(row).toMatchObject({ status: 'executed' });
    expect(row?.output).toMatchObject({ detached: true, status: 'started', agent: 'research' });
  });

  it('puts the receipt on the delegating message, where a reloaded thread finds it', async () => {
    const { store, threadId } = await run({
      script: delegateThenAnswer('start_research'),
      startAgent: async () => ({ runId: 'run-child' }),
    });
    const detail = await store.getThread(threadId);
    const results = detail?.messages.flatMap((message) => message.toolResults ?? []) ?? [];
    expect(results).toEqual([
      expect.objectContaining({
        id: 'call-0-start_research',
        name: 'start_research',
        output: expect.objectContaining({ detached: true, status: 'started', runId: 'run-child' }),
      }),
    ]);
  });

  it('still awaits a delegation the registry does not declare detached', async () => {
    const started: unknown[] = [];
    const { result } = await run({
      script: delegateThenAnswer('ask_research'),
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
      runAgent: async () => ({ text: 'THE ANSWER' }),
    });
    expect(started).toEqual([]);
    expect(result.text).toContain('THE ANSWER');
  });

  it('awaits rather than fails when the runner cannot detach', async () => {
    const { result } = await run({
      script: delegateThenAnswer('start_research'),
      runAgent: async () => ({ text: 'THE ANSWER' }),
    });
    expect(result.text).toContain('THE ANSWER');
  });

  it('writes the same checkpoint names whether or not the delegation detaches', async () => {
    const detached = await run({
      script: delegateThenAnswer('start_research'),
      startAgent: async () => ({ runId: 'run-child' }),
    });
    const awaited = await run({
      script: delegateThenAnswer('ask_research'),
      runAgent: async () => ({ text: 'THE ANSWER' }),
    });
    expect(detached.stepNames).toEqual(
      awaited.stepNames.map((name) => name.replace('ask_research', 'start_research')),
    );
  });

  it('replays the awaited branch for a call whose journal predates the flag', async () => {
    const started: unknown[] = [];
    const awaited: string[] = [];
    const { result } = await run({
      script: delegateThenAnswer('start_research'),
      // What a release before detached delegation journaled for this very call.
      journal: {
        'persist:toolcall:call-0-start_research': {
          kind: 'agent',
          delegation: { targetAgent: 'research', task: 'summarize the incident' },
        },
      },
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
      runAgent: async (agentName) => {
        awaited.push(agentName);
        return { text: 'THE ANSWER' };
      },
    });
    expect(started).toEqual([]);
    expect(awaited).toEqual(['research']);
    expect(result.text).toContain('THE ANSWER');
  });

  it('replays the detached branch from the journal even if the registry no longer says so', async () => {
    const started: unknown[] = [];
    const { result } = await run({
      script: delegateThenAnswer('ask_research'),
      journal: {
        'persist:toolcall:call-0-ask_research': {
          kind: 'agent',
          delegation: { targetAgent: 'research', task: 'summarize the incident', detached: true },
        },
      },
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
      runAgent: async () => ({ text: 'THE ANSWER' }),
    });
    expect(started).toHaveLength(1);
    expect(result.text).toContain('"status":"started"');
  });

  it('refuses to detach past the delegation depth limit', async () => {
    const started: unknown[] = [];
    const { result } = await run({
      script: delegateThenAnswer('start_research'),
      input: { delegationDepth: 5 },
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
    });
    expect(started).toEqual([]);
    expect(result.text).toContain('depth limit');
  });

  it('nests as deep as the HOST said, not as deep as the library ships with', async () => {
    const started: unknown[] = [];
    const { result } = await run({
      script: delegateThenAnswer('start_research'),
      input: { delegationDepth: 5 },
      maxDelegationDepth: 8,
      startAgent: async (call) => {
        started.push(call);
        return { runId: 'run-child' };
      },
    });
    expect(started).toHaveLength(1);
    expect(result.text).not.toContain('depth limit');
  });
});

describe('a detached run delivering its answer', () => {
  it('posts into the thread that delegated it, stamped with its own run and agent', async () => {
    const store = new InMemoryAgentStore();
    const parent = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    const message = await store.appendMessage({
      threadId: parent.id,
      role: 'assistant',
      content: 'starting',
    });
    await store.recordToolCall({
      toolCallId: 'call-0-start_research',
      messageId: message.id,
      toolName: 'start_research',
      toolType: 'read',
      input: { task: 't' },
      status: 'auto_executed',
      runId: 'run-parent',
    });

    const { stepNames } = await run({
      script: () => ({ text: 'the incident was a bad deploy' }),
      store,
      runId: 'run-child',
      input: {
        agentName: 'research',
        deliverTo: { threadId: parent.id, toolCallId: 'call-0-start_research' },
      },
    });

    const detail = await store.getThread(parent.id);
    expect(detail?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'the incident was a bad deploy',
      runId: 'run-child',
      agentName: 'research',
    });
    const row = store.toolCallRows().find((each) => each.toolCallId === 'call-0-start_research');
    expect(row?.output).toMatchObject({
      detached: true,
      status: 'delivered',
      runId: 'run-child',
      agent: 'research',
      text: 'the incident was a bad deploy',
    });
    // One position, after the answer and before the run settles.
    expect(stepNames.slice(-2)).toEqual(['deliver:detached', 'persist:run:end']);
  });

  it('delivers nothing when the thread was deleted while it worked', async () => {
    const store = new InMemoryAgentStore();
    const parent = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    await store.softDeleteThread(parent.id);

    const { result } = await run({
      script: () => ({ text: 'too late' }),
      store,
      runId: 'run-child',
      input: {
        agentName: 'research',
        deliverTo: { threadId: parent.id, toolCallId: 'call-0-start_research' },
      },
    });

    expect(result.text).toBe('too late');
    expect(await store.getThread(parent.id)).toBeNull();
  });

  it('records the run that started it, so a delegation is not an orphan row', async () => {
    const { runStarts } = await run({
      script: () => ({ text: 'done' }),
      input: { agentName: 'research', parentRunId: 'run-parent' },
    });
    expect(runStarts[0]).toMatchObject({ parentRunId: 'run-parent' });
  });

  it('takes no delivery checkpoint at all for an ordinary turn', async () => {
    const { stepNames } = await run({ script: () => ({ text: 'done' }) });
    expect(stepNames.filter((name) => name.startsWith('deliver:'))).toEqual([]);
  });
});

describe('what a detached delegation costs a deployment that declares none', () => {
  it('writes nothing new into the checkpoint that settles an ordinary delegation', async () => {
    const { stepResults } = await run({
      script: delegateThenAnswer('ask_research'),
      runAgent: async () => ({ text: 'THE ANSWER' }),
    });
    // Byte-identical to what this checkpoint has always held.
    expect(stepResults['persist:toolcall:call-0-ask_research']).toEqual({
      kind: 'agent',
      delegation: { targetAgent: 'research', task: 'summarize the incident' },
    });
  });

  it('settles the branch INSIDE that checkpoint for a detached one, not from the registry', async () => {
    const { stepResults } = await run({
      script: delegateThenAnswer('start_research'),
      startAgent: async () => ({ runId: 'run-child' }),
    });
    expect(stepResults['persist:toolcall:call-0-start_research']).toEqual({
      kind: 'agent',
      delegation: { targetAgent: 'research', task: 'summarize the incident', detached: true },
    });
  });
});

describe('what the model is told', () => {
  it('says in prose that the answer is not part of this turn', async () => {
    const { store } = await run({
      script: delegateThenAnswer('start_research'),
      startAgent: async () => ({ runId: 'run-child' }),
    });
    const output = store.toolCallRows().find((row) => row.toolName === 'start_research')?.output;
    const note = (output as { note?: string }).note ?? '';
    expect(note).toContain('NOT part of this turn');
    expect(note).toContain('separate message');
    expect(note).toContain('do not state or guess');
  });

  it('announces the delegation as detached on the diagnostics channel', async () => {
    const seen: { toAgent: string; detached?: boolean }[] = [];
    const slot = Symbol.for('@agora/diagnostics:emit');
    (globalThis as Record<symbol, unknown>)[slot] = (
      _scope: string,
      event: string,
      payload: { toAgent: string; detached?: boolean },
    ) => {
      if (event === 'delegated') seen.push(payload);
    };
    try {
      await run({
        script: delegateThenAnswer('start_research'),
        startAgent: async () => ({ runId: 'run-child' }),
      });
      await run({
        script: delegateThenAnswer('ask_research'),
        runAgent: async () => ({ text: 'THE ANSWER' }),
      });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[slot];
    }
    expect(seen).toMatchObject([{ toAgent: 'research', detached: true }, { toAgent: 'research' }]);
    expect(seen[1]?.detached).toBeUndefined();
  });
});
