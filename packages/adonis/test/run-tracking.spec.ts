import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'], tenantRef: 't-9' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

// ── Inline runner over a real SQLite-backed Lucid store ──────────────────────

describe('run tracking — inline runner (Lucid)', () => {
  let db: Database;
  let store: LucidAgentStore;
  let gov: LucidGovernanceQueries;

  function buildService(script: FakeScript): { service: AgentService; registry: ToolRegistry } {
    const sink = new InProcessTokenStreamSink();
    const registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    const runner = new InlineAgentRunner(factory, store);
    return { service: new AgentService(runner, store, factory), registry };
  }

  async function collect(service: AgentService, runId: string): Promise<void> {
    for await (const _frame of service.subscribe(runId)) {
      /* drain to completion */
    }
  }

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
    gov = new LucidGovernanceQueries(asStoreDb(db));
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('creates a run at start and finalizes it completed with the rollup', async () => {
    const { service } = buildService(() => ({ text: 'done' }));
    const { runId } = await service.chat({ actor, message: 'hi', agentName: 'default' });
    await collect(service, runId);
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'completed');

    const detail = await gov.runDetail(runId);
    const run = detail?.run;
    expect(run?.status).toBe('completed');
    expect(run?.actorRef).toBe('u1');
    expect(run?.tenantRef).toBe('t-9');
    expect(run?.agentName).toBe('default');
    expect(run?.durable).toBe(false);
    expect(run?.stepCount).toBe(1);
    // one llm turn: inputTokens = message count seen, outputTokens = 'done'.length = 4
    expect(run?.outputTokens).toBe(4);
    expect(run?.inputTokens).toBeGreaterThan(0);
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.durationMs).not.toBeNull();
  });

  it("stamps run_id on the run's messages, tool calls and usage", async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'looking', toolCall: { name: 'lookup', input: { q: 'x' } } }
        : { text: 'answer' };
    const { service, registry } = buildService(script);
    registry.register(
      {
        name: 'lookup',
        kind: 'read',
        description: 'reads',
        inputSchema: z.object({ q: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ found: true }) },
    );
    const { runId } = await service.chat({ actor, message: 'hi' });
    await collect(service, runId);
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'completed');

    const detail = await gov.runDetail(runId);
    // user + 2 assistant turns all carry the run id (runDetail filters by run_id)
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(detail?.toolCalls.map((c) => c.toolName)).toEqual(['lookup']);
    expect(detail?.toolCalls[0]?.status).toBe('executed');
    expect(detail?.usage.length).toBe(2); // one usage row per llm turn
    expect(detail?.usage.every((u) => u.purpose === 'chat')).toBe(true);
  });

  it('finalizes a run failed when the loop throws (quota exceeded)', async () => {
    const sink = new InProcessTokenStreamSink();
    const registry = new ToolRegistry();
    const { InMemoryQuotaStore } = await import('../src/testing/index.js');
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(() => ({ text: 'never' })),
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
      quota: new InMemoryQuotaStore(0),
    });
    const runner = new InlineAgentRunner(factory, store);
    const service = new AgentService(runner, store, factory);
    const { runId } = await service.chat({ actor, message: 'hi' });
    await collect(service, runId);
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'failed');

    const detail = await gov.runDetail(runId);
    expect(detail?.run.status).toBe('failed');
    expect(detail?.run.error).toContain('quota');
    expect(detail?.run.finishedAt).not.toBeNull();
  });

  it('lists a run and returns it in listRuns', async () => {
    const { service } = buildService(() => ({ text: 'done' }));
    const { runId } = await service.chat({ actor, message: 'hi' });
    await collect(service, runId);
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'completed');

    const page = await gov.listRuns({ actor: 'u1' });
    expect(page.runs.map((r) => r.runId)).toContain(runId);
    expect(page.nextCursor).toBeNull();
    // filtering by a different actor excludes it
    expect((await gov.listRuns({ actor: 'someone-else' })).runs).toEqual([]);
  });
});

// ── Durable runner over the in-memory engine + store ─────────────────────────

describe('run tracking — durable runner (replay-safe)', () => {
  let store: InMemoryAgentStore;
  let engine: WorkflowEngine;
  let service: AgentService;
  let registry: ToolRegistry;

  function build(script: FakeScript): void {
    store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink,
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    setDurableAgentContext({ factory, store });
    registerAgentWorkflow(engine);
    service = new AgentService(new DurableAgentRunner(engine, store), store, factory);
  }

  async function collect(runId: string): Promise<void> {
    for await (const _frame of service.subscribe(runId)) {
      /* drain to completion */
    }
  }

  afterEach(() => setDurableAgentContext(undefined));

  it('records a durable run as completed (durable flag set)', async () => {
    build(() => ({ text: 'done' }));
    const { runId } = await service.chat({ actor, message: 'hi' });
    await collect(runId);
    await waitFor(() =>
      store.governanceRuns().some((r) => r.runId === runId && r.status === 'completed'),
    );

    const runs = store.governanceRuns().filter((r) => r.runId === runId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.durable).toBe(true);
    expect(runs[0]?.status).toBe('completed');
  });

  it('a suspend/resume replay creates EXACTLY ONE run row', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'acting', toolCall: { name: 'danger', input: { k: 'v' } } }
        : { text: 'done' };
    build(script);
    registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({ k: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ acted: true }) },
    );
    const { runId } = await service.chat({ actor, message: 'do it' });

    // Suspends on the pending action (the workflow body has run once so far).
    await waitFor(() =>
      store.toolCallRows().some((r) => r.status === 'pending_approval' && r.toolName === 'danger'),
    );
    await waitFor(async () => (await engine.getRun(runId))?.status === 'suspended');
    // Even mid-suspend there is a single 'running' row.
    expect(store.governanceRuns().filter((r) => r.runId === runId)).toHaveLength(1);

    // Approve → the workflow REPLAYS from the checkpoint (recordRunStart re-executes on replay).
    await service.approve(runId, 'call-0-danger');
    await waitFor(() =>
      store.governanceRuns().some((r) => r.runId === runId && r.status === 'completed'),
    );

    // The memoized `persist:run:start` step means replay did NOT insert a second run.
    const runs = store.governanceRuns().filter((r) => r.runId === runId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
  });
});
