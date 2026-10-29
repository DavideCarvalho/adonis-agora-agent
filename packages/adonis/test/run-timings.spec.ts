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
  rollupRunTimings,
  ToolRegistry,
  toolsWallClockMs,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

function readTool(registry: ToolRegistry, name: string, ms: number): void {
  registry.register(
    {
      name,
      kind: 'read',
      description: `reads for ${ms}ms`,
      inputSchema: z.object({ q: z.string() }),
      roles: ['ADMIN'],
    },
    {
      execute: async () => {
        await sleep(ms);
        return { ok: true };
      },
    },
  );
}

describe('toolsWallClockMs', () => {
  it('counts overlapping calls once and sequential ones in full', () => {
    expect(
      toolsWallClockMs([
        { at: 0, ms: 100 },
        { at: 10, ms: 50 },
        { at: 200, ms: 30 },
      ]),
    ).toBe(130);
  });

  it('adds a call with no start in full', () => {
    expect(toolsWallClockMs([{ at: 0, ms: 10 }, { ms: 5 }])).toBe(15);
  });

  it('rolls steps up into totals and counts', () => {
    expect(
      rollupRunTimings([
        { step: 0, modelMs: 10.4, tools: [{ toolCallId: 'a', toolName: 't', ms: 5 }], toolsMs: 5 },
        { step: 1, tools: [], toolsMs: 0 },
      ]),
    ).toMatchObject({ modelMs: 10, toolsMs: 5, modelCalls: 1, toolCalls: 1 });
  });
});

describe('run timings — inline runner (Lucid)', () => {
  let db: Database;
  let store: LucidAgentStore;
  let gov: LucidGovernanceQueries;

  function build(script: FakeScript): { service: AgentService; registry: ToolRegistry } {
    const registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    return {
      service: new AgentService(new InlineAgentRunner(factory, store), store, factory),
      registry,
    };
  }

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
    gov = new LucidGovernanceQueries(asStoreDb(db));
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('persists queue, model and tool time, and the per-step list', async () => {
    const { service, registry } = build((_args, turn) =>
      turn === 0
        ? { text: 'looking', toolCall: { name: 'lookup', input: { q: 'x' } } }
        : { text: 'answer' },
    );
    readTool(registry, 'lookup', 30);
    const { runId } = await service.chat({ actor, message: 'hi' });
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'completed');

    const detail = await gov.runDetail(runId);
    expect(detail?.run.queueMs).toBeTypeOf('number');
    expect(detail?.run.queueMs as number).toBeGreaterThanOrEqual(0);
    expect(detail?.run.modelCalls).toBe(2);
    expect(detail?.run.toolCalls).toBe(1);
    expect(detail?.run.modelMs).toBeTypeOf('number');
    expect(detail?.run.toolsMs as number).toBeGreaterThanOrEqual(25);
    expect(detail?.timings?.steps).toHaveLength(2);
    expect(detail?.timings?.steps[0]?.tools).toEqual([
      { toolCallId: 'call-0-lookup', toolName: 'lookup', ms: expect.any(Number) },
    ]);
    expect(detail?.timings?.steps[1]?.tools).toEqual([]);
    // The per-call figure is the one the tool-call row carries.
    const executionMs = detail?.toolCalls.find((call) => call.toolName === 'lookup')?.executionMs;
    expect(detail?.timings?.steps[0]?.tools[0]?.ms).toBe(executionMs);
  });

  it('counts tools that ran in parallel once', async () => {
    const { service, registry } = build((_args, turn) =>
      turn === 0
        ? {
            text: '',
            toolCalls: [
              { name: 'slow_a', input: { q: 'a' } },
              { name: 'slow_b', input: { q: 'b' } },
            ],
          }
        : { text: 'both' },
    );
    readTool(registry, 'slow_a', 60);
    readTool(registry, 'slow_b', 60);
    const { runId } = await service.chat({ actor, message: 'hi' });
    await waitFor(async () => (await gov.runDetail(runId))?.run.status === 'completed');

    const detail = await gov.runDetail(runId);
    const step = detail?.timings?.steps[0];
    expect(step?.tools.map((tool) => tool.toolName)).toEqual(['slow_a', 'slow_b']);
    const sum = (step?.tools ?? []).reduce((total, tool) => total + tool.ms, 0);
    expect(step?.toolsMs as number).toBeGreaterThanOrEqual(55);
    expect(step?.toolsMs as number).toBeLessThan(sum);
    expect(detail?.run.toolsMs).toBe(step?.toolsMs);
  });
});

describe('run timings — durable runner', () => {
  let store: InMemoryAgentStore;
  let engine: WorkflowEngine;
  let service: AgentService;
  let registry: ToolRegistry;

  function build(script: FakeScript): void {
    store = new InMemoryAgentStore();
    registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(script),
      store,
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    setDurableAgentContext({ factory, store });
    registerAgentWorkflow(engine);
    service = new AgentService(new DurableAgentRunner(engine, store), store, factory);
  }

  afterEach(() => setDurableAgentContext(undefined));

  it('reads queue time off the engine and counts a resumed run’s steps once', async () => {
    build((_args, turn) => {
      if (turn === 0) return { text: 'reading', toolCall: { name: 'lookup', input: { q: 'x' } } };
      if (turn === 1) return { text: 'acting', toolCall: { name: 'danger', input: { q: 'y' } } };
      return { text: 'done' };
    });
    readTool(registry, 'lookup', 30);
    registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'acts',
        inputSchema: z.object({ q: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ acted: true }) },
    );
    const { runId } = await service.chat({ actor, message: 'go' });
    await waitFor(async () => (await engine.getRun(runId))?.status === 'suspended');
    // Parked on the approval for a while: that wait is no one's time.
    await sleep(80);
    await service.approve(runId, 'call-1-danger');
    await waitFor(() =>
      store.governanceRuns().some((run) => run.runId === runId && run.status === 'completed'),
    );

    const run = store.governanceRuns().find((each) => each.runId === runId);
    expect(run?.queueMs).toBeTypeOf('number');
    expect(run?.queueMs as number).toBeGreaterThanOrEqual(0);
    // The resumed body replayed steps 0 and 1 from the journal: each is counted once.
    expect(run?.timings?.modelCalls).toBe(3);
    expect(run?.timings?.toolCalls).toBe(2);
    expect(run?.timings?.steps.map((step) => step.tools.map((tool) => tool.toolName))).toEqual([
      ['lookup'],
      ['danger'],
      [],
    ]);
    // The read ran in the first slice; its time came back from the journal on the resume.
    expect(run?.timings?.steps[0]?.toolsMs as number).toBeGreaterThanOrEqual(25);
    // The approval wait is in neither total.
    expect(run?.timings?.toolsMs as number).toBeLessThan(80);

    const detail = await new InMemoryGovernanceQueries(store).runDetail(runId);
    expect(detail?.run.toolCalls).toBe(2);
    expect(detail?.timings?.steps).toHaveLength(3);
  });
});
