import {
  BaseWorkflow,
  InMemoryStateStore,
  setWorkflowEngineResolver,
  type WorkflowCtx,
  WorkflowEngine,
} from '@adonis-agora/durable';
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
  DefaultToolAuthorizer,
  registerDelegateTools,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

/**
 * A detached delegation under the durable runner, with the engine REPLAYING between every signal.
 *
 * Each approval resumes a run, and a resume replays its whole journal: every position the first pass
 * took has to be asked for again, in order, under the same name. The parent parks before AND after
 * the `detach:` it records (the step that starts the child as a run of its own); the child parks twice, once right after a tool that starts a workflow of
 * the app's own from inside its body (the shape that once failed in production with "non-determinism"
 * when that start landed in the agent run's journal). Decisions arrive interleaved across the two
 * runs, in both orders.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ingested: string[] = [];
class IngestWorkflow extends BaseWorkflow {
  static override workflow = { name: 'test.detached.ingest', version: '1' };

  async run(ctx: WorkflowCtx, input: { key: string }): Promise<{ ok: true }> {
    await ctx.localStep('ingest', async () => {
      ingested.push(input.key);
    });
    return { ok: true };
  }
}

/**
 * Parent (orch): one step asking for an action AND the detached delegation, then a second action in
 * a later step, then an answer. Child (research): a read that starts an app workflow plus an action
 * in one step, a second action in the next, then its answer.
 */
const script: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    if (turnIndex === 0) {
      return {
        text: 'digging',
        toolCalls: [
          { name: 'reingest', input: { key: 'k1' } },
          { name: 'purge_cache', input: { key: 'c1' } },
        ],
      };
    }
    return turnIndex === 1
      ? { text: 'one more', toolCall: { name: 'purge_cache', input: { key: 'c2' } } }
      : { text: 'RESEARCH ANSWER' };
  }
  if (turnIndex === 0) {
    return {
      text: 'starting',
      toolCalls: [
        { name: 'record_measure', input: { key: 'm1' } },
        { name: 'start_research', input: { task: 'dig into it' } },
      ],
    };
  }
  return turnIndex === 1
    ? { text: 'and this', toolCall: { name: 'record_measure', input: { key: 'm2' } } }
    : { text: 'ORCH DONE' };
};

interface Graph {
  service: AgentService;
  store: InMemoryAgentStore;
  engine: WorkflowEngine;
  executions: Record<string, number>;
}

function buildGraph(): Graph {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const executions: Record<string, number> = {};
  const count = (key: string) => {
    executions[key] = (executions[key] ?? 0) + 1;
  };
  for (const name of ['record_measure', 'purge_cache']) {
    registry.register(
      {
        name,
        kind: 'action',
        description: name,
        inputSchema: z.object({ key: z.string() }),
        roles: ['ADMIN'],
      },
      {
        execute: async (input: { key: string }) => {
          count(`${name}:${input.key}`);
          return { ok: input.key };
        },
      },
    );
  }
  registry.register(
    {
      name: 'reingest',
      kind: 'read',
      description: 'a read that also starts a workflow of the app',
      inputSchema: z.object({ key: z.string() }),
      roles: ['ADMIN'],
    },
    {
      execute: async (input: { key: string }) => {
        count(`reingest:${input.key}`);
        await IngestWorkflow.dispatch({ key: input.key }, { runId: `ingest-${input.key}` });
        return { queued: true };
      },
    },
  );
  const agents = new AgentRegistry();
  agents.register({
    name: 'research',
    systemPrompt: 'research worker',
    tools: ['reingest', 'purge_cache'],
  });
  agents.register({
    name: 'orch',
    systemPrompt: 'orchestrator',
    tools: ['record_measure'],
    delegatesTo: [{ agent: 'research', detached: true, roles: ['ADMIN'] }],
  });
  registerDelegateTools(registry, agents);
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
    defaultAgentName: 'orch',
  });
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const meta = IngestWorkflow.workflow;
  engine.register(meta.name, meta.version, (ctx, input) =>
    new IngestWorkflow().run(ctx, input as { key: string }),
  );
  setWorkflowEngineResolver(() => engine);
  const service = new AgentService(new DurableAgentRunner(engine, store), store, factory);
  return { service, store, engine, executions };
}

afterEach(() => {
  setDurableAgentContext(undefined);
  ingested.length = 0;
});

/** The pending call of `runId` named `toolName` with `key`, once the run is parked on it. */
async function parkedOn(g: Graph, runId: string, callId: string): Promise<void> {
  await eventually(
    async () =>
      g.store
        .toolCallRows()
        .some((row) => row.toolCallId === callId && row.status === 'pending_approval')
        ? true
        : undefined,
    `${callId} to be pending`,
  );
  await eventually(
    async () => ((await g.engine.getRun(runId))?.status === 'suspended' ? true : undefined),
    `${runId} to suspend`,
  );
}

async function settled(g: Graph, runId: string): Promise<{ status?: string; error?: string }> {
  return eventually(async () => {
    const run = await g.engine.getRun(runId);
    if (run === null || !['completed', 'failed', 'cancelled', 'dead'].includes(run.status)) {
      return undefined;
    }
    return {
      status: run.status,
      ...(run.error?.message !== undefined ? { error: run.error.message } : {}),
    };
  }, `${runId} to settle`);
}

const names = async (g: Graph, runId: string) =>
  (await g.engine.listCheckpoints(runId)).map((checkpoint) => checkpoint.name);

/** The run a `detach:` step of `runId` started — read off the journal, where the parent keeps it. */
async function detachedChildOf(g: Graph, runId: string): Promise<string | undefined> {
  const detach = (await g.engine.listCheckpoints(runId)).find(
    (checkpoint) => checkpoint.name.startsWith('detach:') && checkpoint.status === 'completed',
  );
  return typeof detach?.output === 'string' ? detach.output : undefined;
}

async function startAndPark(g: Graph): Promise<{ runId: string; threadId: string; child: string }> {
  const { runId, threadId } = await g.service.chat({ actor, message: 'go' });
  // Signal #1's wait: the parent's first action, BEFORE it reaches the detached delegation.
  await parkedOn(g, runId, 'call-0-record_measure');
  await g.service.approve(runId, 'call-0-record_measure');
  // The resume replays the claims, runs the action, spawns the child and parks on the next action.
  await parkedOn(g, runId, 'call-1-record_measure');
  const child = await eventually(
    async () => detachedChildOf(g, runId),
    'the detached child to be started',
  );
  await parkedOn(g, child, 'call-0-purge_cache');
  return { runId, threadId, child };
}

async function expectAllSettledOnce(
  g: Graph,
  ids: { runId: string; threadId: string; child: string },
): Promise<void> {
  expect(await settled(g, ids.runId)).toEqual({ status: 'completed' });
  expect(await settled(g, ids.child)).toEqual({ status: 'completed' });
  expect(g.executions).toEqual({
    'record_measure:m1': 1,
    'record_measure:m2': 1,
    'reingest:k1': 1,
    'purge_cache:c1': 1,
    'purge_cache:c2': 1,
  });
  await eventually(
    async () => ((await g.engine.getRun('ingest-k1'))?.status === 'completed' ? true : undefined),
    'the app workflow to run',
  );
  expect(ingested).toEqual(['k1']);

  // One child, started once, recorded at one position of the parent's journal — as a run of its
  // own, not an engine child, so a Stop on the parent cannot reach it. Nothing the child's tools did
  // took a position in either agent run's journal.
  expect(await g.engine.getRunChildren(ids.runId)).toEqual([]);
  const parent = await names(g, ids.runId);
  expect(parent.filter((name) => name.startsWith('spawn:'))).toEqual([]);
  expect(parent.filter((name) => name.startsWith('detach:'))).toEqual([
    'detach:call-0-start_research',
  ]);
  expect(parent).toContain('patch:agent:detached-unlinked');
  expect((await g.engine.getRun(ids.child))?.input).toMatchObject({ parentRunId: ids.runId });
  const child = await names(g, ids.child);
  expect(child.filter((name) => name.startsWith('spawn:'))).toEqual([]);
  expect(child.filter((name) => name.startsWith('deliver:'))).toEqual(['deliver:detached']);

  const thread = await g.store.getThread(ids.threadId);
  const contents = thread?.messages.map((message) => message.content) ?? [];
  expect(contents).toContain('ORCH DONE');
  expect(contents.filter((content) => content === 'RESEARCH ANSWER')).toHaveLength(1);
  expect(thread?.messages.find((message) => message.content === 'RESEARCH ANSWER')).toMatchObject({
    runId: ids.child,
    agentName: 'research',
  });
}

describe('a detached delegation, replayed between every signal (durable runner)', () => {
  it('parent, child, parent, child', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);

    await g.service.approve(ids.child, 'call-0-purge_cache');
    await parkedOn(g, ids.child, 'call-1-purge_cache');
    await g.service.approve(ids.runId, 'call-1-record_measure');
    expect(await settled(g, ids.runId)).toEqual({ status: 'completed' });
    await g.service.approve(ids.child, 'call-1-purge_cache');

    await expectAllSettledOnce(g, ids);
  });

  it('parent finishes first, then the child twice', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);

    await g.service.approve(ids.runId, 'call-1-record_measure');
    expect(await settled(g, ids.runId)).toEqual({ status: 'completed' });
    await g.service.approve(ids.child, 'call-0-purge_cache');
    await parkedOn(g, ids.child, 'call-1-purge_cache');
    await g.service.approve(ids.child, 'call-1-purge_cache');

    await expectAllSettledOnce(g, ids);
  });

  it('the child finishes first, while the parent is still parked after its spawn', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);

    await g.service.approve(ids.child, 'call-0-purge_cache');
    await parkedOn(g, ids.child, 'call-1-purge_cache');
    await g.service.approve(ids.child, 'call-1-purge_cache');
    expect(await settled(g, ids.child)).toEqual({ status: 'completed' });
    // The answer is in the thread before the turn that asked for it has even finished.
    expect(
      (await g.store.getThread(ids.threadId))?.messages.some(
        (message) => message.content === 'RESEARCH ANSWER',
      ),
    ).toBe(true);
    await g.service.approve(ids.runId, 'call-1-record_measure');

    await expectAllSettledOnce(g, ids);
  });

  it('decisions delivered at the same time', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);

    await Promise.all([
      g.service.approve(ids.child, 'call-0-purge_cache'),
      g.service.approve(ids.runId, 'call-1-record_measure'),
    ]);
    await parkedOn(g, ids.child, 'call-1-purge_cache');
    await g.service.approve(ids.child, 'call-1-purge_cache');

    await expectAllSettledOnce(g, ids);
  });
});

describe('stopping the turn that started a detached delegation (durable runner)', () => {
  it('leaves the detached run working, and its card follows it to delivered', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);

    await g.service.cancel(ids.runId);
    expect((await settled(g, ids.runId)).status).toBe('cancelled');
    // The Stop was for the turn the person was watching; the background run was never part of it.
    expect((await g.engine.getRun(ids.child))?.status).toBe('suspended');
    expect(
      g.store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
    ).toMatchObject({ detached: true, status: 'started' });

    await g.service.approve(ids.child, 'call-0-purge_cache');
    await parkedOn(g, ids.child, 'call-1-purge_cache');
    await g.service.approve(ids.child, 'call-1-purge_cache');
    expect(await settled(g, ids.child)).toEqual({ status: 'completed' });

    const messages = (await g.store.getThread(ids.threadId))?.messages ?? [];
    expect(messages.filter((message) => message.content === 'RESEARCH ANSWER')).toHaveLength(1);
    expect(
      g.store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
    ).toMatchObject({ detached: true, status: 'delivered', runId: ids.child });
    expect(g.executions).toEqual({
      'record_measure:m1': 1,
      'reingest:k1': 1,
      'purge_cache:c1': 1,
      'purge_cache:c2': 1,
    });
  });

  it('still stops the detached run on its own id, and says so once', async () => {
    const g = buildGraph();
    const ids = await startAndPark(g);
    await g.service.cancel(ids.runId);

    await g.service.cancel(ids.child);
    expect((await settled(g, ids.child)).status).toBe('cancelled');
    expect(
      g.store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
    ).toMatchObject({ detached: true, status: 'cancelled', runId: ids.child });
    const told = ((await g.store.getThread(ids.threadId))?.messages ?? []).filter((message) =>
      message.content.includes('was stopped before it could answer'),
    );
    expect(told).toHaveLength(1);
  });
});
