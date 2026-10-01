import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  type AgentStore,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  type RecordRunStartInput,
  registerDelegateTools,
  type StoredMessage,
  ToolRegistry,
} from '../src/index.js';
import { backgroundRunsFromThread } from '../src/react/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * Detached delegation end to end, on both runners: the delegating turn ends with a receipt while the
 * delegate is still parked on a person, the delegate's approval routes to its OWN run, and its answer
 * (or its failure, or its Stop) arrives afterwards as a message in the thread that asked. After
 * `nestjs-agent`'s `runner/inline-detached.spec.ts` and `durable/agent-detached.spec.ts`.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The run's status once the engine has settled it (the stream ends a moment before the run does). */
async function settledStatus(engine: WorkflowEngine, runId: string): Promise<string | undefined> {
  return eventually(async () => {
    const status = (await engine.getRun(runId))?.status;
    return status === 'running' || status === 'pending' ? undefined : status;
  }, `run ${runId} to settle`);
}

/** The research agent's one tool — an action, so it parks on a person. */
function registerTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string() }),
      roles: ['ADMIN'],
    },
    { execute: async (input: { key: string }) => ({ purged: input.key }) },
  );
}

/**
 * The orchestrator delegates on its first turn and then answers from whatever came back; the
 * research agent calls its action tool and then answers. `system` tells them apart.
 */
const script: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    return turnIndex === 0
      ? { text: 'digging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
      : { text: 'RESEARCH ANSWER' };
  }
  return turnIndex === 0
    ? { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig into it' } } }
    : { text: 'started it' };
};

interface Graph {
  service: AgentService;
  store: InMemoryAgentStore;
  engine?: WorkflowEngine;
  parents: Record<string, string | undefined>;
}

function buildGraph(kind: 'inline' | 'durable', chosen: FakeScript = script): Graph {
  const store = new InMemoryAgentStore();
  const parents: Record<string, string | undefined> = {};
  const recordRunStart = store.recordRunStart.bind(store);
  (store as AgentStore).recordRunStart = async (run: RecordRunStartInput) => {
    parents[run.runId] = run.parentRunId;
    await recordRunStart(run);
  };
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  registerTools(registry);
  const agents = new AgentRegistry();
  agents.register({ name: 'research', systemPrompt: 'research worker', tools: ['purgeCache'] });
  agents.register({
    name: 'orch',
    systemPrompt: 'orchestrator',
    delegatesTo: [{ agent: 'research', detached: true, roles: ['ADMIN'] }],
  });
  registerDelegateTools(registry, agents);
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(chosen),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
    defaultAgentName: 'orch',
  });
  if (kind === 'inline') {
    const runner = new InlineAgentRunner(factory, store);
    return { service: new AgentService(runner, store, factory), store, parents };
  }
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const runner = new DurableAgentRunner(engine, store, undefined, sink);
  return { service: new AgentService(runner, store, factory), store, engine, parents };
}

async function collect(g: Graph, runId: string): Promise<string> {
  let out = '';
  for await (const frame of g.service.subscribe(runId)) {
    out += JSON.stringify(frame);
  }
  return out;
}

const pendingPurge = (g: Graph) =>
  eventually(
    async () =>
      g.store
        .toolCallRows()
        .find((row) => row.toolName === 'purgeCache' && row.status === 'pending_approval'),
    'the sub-agent to park on its action tool',
  );

const messageIn = (g: Graph, threadId: string, match: (message: StoredMessage) => boolean) =>
  eventually(
    async () => (await g.store.getThread(threadId))?.messages.find(match),
    'a message in the delegating thread',
  );

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe.each(['inline', 'durable'] as const)('a detached delegation (%s runner)', (kind) => {
  it('ends the turn while the sub-agent is still parked, then delivers its answer into the thread', async () => {
    const g = buildGraph(kind);
    const { runId, threadId } = await g.service.chat({ actor, message: 'look into this' });
    const streamed = await collect(g, runId);

    // THE TURN ENDS WITHOUT THE ANSWER.
    expect(streamed).toContain('"status":"started"');
    expect(streamed).toContain('started it');
    expect(streamed).not.toContain('RESEARCH ANSWER');
    // The sub-agent's pending approval did NOT hijack the finished turn's stream.
    expect(streamed).not.toContain('purgeCache');
    if (g.engine !== undefined) {
      expect(await settledStatus(g.engine, runId)).toBe('completed');
    }

    // It is waiting on a person, on its OWN run — which is what routes the decision back to it.
    const pending = await pendingPurge(g);
    const childRunId = pending.runId ?? '';
    expect(childRunId).not.toBe('');
    expect(childRunId).not.toBe(runId);
    expect(await g.service.toolCallRun(pending.toolCallId)).toBe(childRunId);
    expect(g.parents[childRunId]).toBe(runId);
    expect(g.parents[runId]).toBeUndefined();
    // Its own stream is readable by its owner, under its own id.
    expect(await g.service.runOwner(childRunId)).toBe('u1');

    await g.service.approve(childRunId, pending.toolCallId);

    // THE RESULT ARRIVES AFTERWARDS, IN THE RIGHT THREAD, UNDER ITS OWN NAME.
    const delivered = await messageIn(
      g,
      threadId,
      (message) => message.content === 'RESEARCH ANSWER',
    );
    expect(delivered).toMatchObject({
      role: 'assistant',
      runId: childRunId,
      agentName: 'research',
    });
    const receipt = g.store.toolCallRows().find((row) => row.toolName === 'start_research');
    expect(receipt?.output).toMatchObject({
      detached: true,
      status: 'delivered',
      agent: 'research',
      runId: childRunId,
      text: 'RESEARCH ANSWER',
    });
    // The receipt the reloaded thread shows still names the run, which is how a client pairs them.
    const detail = await g.service.getThread(threadId, actor);
    const results = detail?.messages.flatMap((message) => message.toolResults ?? []) ?? [];
    expect(results.find((result) => result.name === 'start_research')?.output).toMatchObject({
      status: 'started',
      runId: childRunId,
    });
  });

  it('reads as a background run to the shared React client: running, then delivered', async () => {
    const g = buildGraph(kind);
    const { runId, threadId } = await g.service.chat({ actor, message: 'look into this' });
    await collect(g, runId);
    const pending = await pendingPurge(g);
    // What `useAgentChat({ background: true })` derives from `GET <path>/threads/:id`.
    const read = async () =>
      backgroundRunsFromThread(
        ((await g.service.getThread(threadId, actor))?.messages ?? []) as never,
      );

    expect(await read()).toEqual([
      {
        runId: pending.runId,
        agent: 'research',
        toolCallId: 'call-0-start_research',
        toolName: 'start_research',
        status: 'running',
      },
    ]);

    await g.service.approve(pending.runId ?? '', pending.toolCallId);
    const [run] = await eventually(async () => {
      const runs = await read();
      return runs[0]?.status === 'delivered' ? runs : undefined;
    }, 'the run to read as delivered');
    expect(run?.message).toMatchObject({ content: 'RESEARCH ANSWER', agentName: 'research' });
  });

  it('tells the thread when someone stops the background agent', async () => {
    const g = buildGraph(kind);
    const { runId, threadId } = await g.service.chat({ actor, message: 'look into this' });
    await collect(g, runId);
    const pending = await pendingPurge(g);

    // A background run nobody ever approves is stoppable on its own id — which the receipt carries.
    await g.service.cancel(pending.runId ?? '');

    const told = await messageIn(g, threadId, (message) =>
      message.content.includes('was stopped before it could answer'),
    );
    expect(told.agentName).toBe('research');
    expect(
      g.store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
    ).toMatchObject({ detached: true, status: 'cancelled' });
    // Told once, however many paths noticed the Stop.
    await sleep(50);
    const told2 = (await g.store.getThread(threadId))?.messages.filter((message) =>
      message.content.includes('was stopped'),
    );
    expect(told2).toHaveLength(1);
  });

  it('tells the thread when the detached run dies instead of leaving it "started" for ever', async () => {
    const dying: FakeScript = (args, turnIndex) => {
      if (args.system.includes('research worker')) {
        throw new Error('model unavailable');
      }
      return turnIndex === 0
        ? { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig' } } }
        : { text: 'started it' };
    };
    const g = buildGraph(kind, dying);
    const { runId, threadId } = await g.service.chat({ actor, message: 'look into this' });
    await collect(g, runId);
    if (g.engine !== undefined) {
      // The delegating turn is unaffected by its delegate's death — it never waited for it.
      expect(await settledStatus(g.engine, runId)).toBe('completed');
    }

    const told = await messageIn(g, threadId, (message) =>
      message.content.includes('stopped before it could answer'),
    );
    expect(told.agentName).toBe('research');
    expect(told.content).toContain('model unavailable');
    expect(
      g.store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
    ).toMatchObject({ detached: true, status: 'failed', agent: 'research' });
  });
});
