import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor, Passage, RetrieveOptions, Retriever } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
  inMemoryRetriever,
} from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

interface FactoryExtra {
  retriever?: Retriever;
  retrievalTopK?: number;
  retrievalFilter?: (actor: Actor) => Record<string, unknown>;
}

function buildInline(script: FakeScript, extra: FactoryExtra) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
    ...extra,
  });
  const runner = new InlineAgentRunner(factory, store);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry };
}

function buildDurable(script: FakeScript, extra: FactoryExtra) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
    ...extra,
  });
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const runner = new DurableAgentRunner(engine);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry, engine };
}

async function collectStream(service: AgentService, runId: string): Promise<string> {
  let text = '';
  for await (const frame of service.subscribe(runId)) {
    if (frame.t === 'text') text += frame.v;
  }
  return text;
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('inject-mode retrieval (inline)', () => {
  it('folds retrieved context into the model system prompt', async () => {
    let systemSeen = '';
    const script: FakeScript = (args) => {
      systemSeen = args.system;
      return { text: 'answer' };
    };
    const retriever = await inMemoryRetriever({
      documents: [{ id: 'kb', text: 'The launch code is ORANGE-42.', source: 'ops' }],
    });
    const g = buildInline(script, { retriever, retrievalTopK: 3 });

    const { runId } = await g.service.chat({ actor, message: 'what is the launch code' });
    await collectStream(g.service, runId);

    expect(systemSeen).toContain('<retrieved_context>');
    expect(systemSeen).toContain('ORANGE-42');
    // The injected retrieval is recorded as a synthetic executed `retrieve` tool call for citations.
    const call = g.store.toolCallRows().find((r) => r.toolName === 'retrieve');
    expect(call?.status).toBe('executed');
  });

  it('leaves the system prompt unchanged when no retriever is configured', async () => {
    let systemSeen = '';
    const script: FakeScript = (args) => {
      systemSeen = args.system;
      return { text: 'answer' };
    };
    const g = buildInline(script, {});

    const { runId } = await g.service.chat({ actor, message: 'hi' });
    await collectStream(g.service, runId);

    expect(systemSeen).not.toContain('<retrieved_context>');
    expect(g.store.toolCallRows().some((r) => r.toolName === 'retrieve')).toBe(false);
  });
});

describe('inject-mode retrieval (durable replay)', () => {
  it('memoizes retrieval across a suspend/resume — retrieve runs exactly once', async () => {
    let retrieveCalls = 0;
    const retriever: Retriever = {
      retrieve: async () => {
        retrieveCalls += 1;
        return [{ id: 'kb#0', text: 'CTX', score: 1 }] satisfies Passage[];
      },
    };
    // Turn 0 requests an action tool → the run suspends on approval; the body replays on resume.
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'acting', toolCall: { name: 'danger', input: {} } }
        : { text: 'done' };
    const g = buildDurable(script, { retriever });
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ ok: true }) },
    );

    const { runId } = await g.service.chat({ actor, message: 'go' });
    await waitFor(() => g.store.toolCallRows().some((r) => r.status === 'pending_approval'));
    // Retrieval happened once, before the suspend.
    expect(retrieveCalls).toBe(1);

    await g.service.approve(runId, 'call-0-danger');
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    // The workflow body replayed after resume, but the `retrieve` step was checkpointed — not re-run.
    expect(retrieveCalls).toBe(1);
  });
});

describe('inject-mode retrieval filter (retrievalFilter)', () => {
  it('1. a configured hook reaches the retriever as `filter` (the regression)', async () => {
    const seenOptions: RetrieveOptions[] = [];
    const retriever: Retriever = {
      retrieve: async (_query, options) => {
        seenOptions.push(options ?? {});
        return [] satisfies Passage[];
      },
    };
    const script: FakeScript = () => ({ text: 'answer' });
    const g = buildInline(script, {
      retriever,
      retrievalFilter: (a) => ({ tenantRef: a.tenantRef }),
    });

    const tenantActor: Actor = { id: 'u-tenant', roles: ['ADMIN'], tenantRef: 'tenant-abc' };
    const { runId } = await g.service.chat({ actor: tenantActor, message: 'hi' });
    await collectStream(g.service, runId);

    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]!.filter).toEqual({ tenantRef: 'tenant-abc' });
  });

  it('2. with no hook configured, the retriever receives options with NO `filter` key at all', async () => {
    const seenOptions: RetrieveOptions[] = [];
    const retriever: Retriever = {
      retrieve: async (_query, options) => {
        seenOptions.push(options ?? {});
        return [] satisfies Passage[];
      },
    };
    const script: FakeScript = () => ({ text: 'answer' });
    const g = buildInline(script, { retriever });

    const { runId } = await g.service.chat({ actor, message: 'hi' });
    await collectStream(g.service, runId);

    expect(seenOptions).toHaveLength(1);
    // Assert on KEY PRESENCE, not value — `filter: undefined` would also fail `.filter` equality
    // checks but is NOT what existing single-tenant deployments must see: the key must be absent.
    expect(Object.hasOwn(seenOptions[0]!, 'filter')).toBe(false);
  });

  it("3. the filter is derived from the RUN's actor, not cached across runs", async () => {
    const seenFilters: Record<string, unknown>[] = [];
    const retriever: Retriever = {
      retrieve: async (_query, options) => {
        seenFilters.push(options?.filter ?? {});
        return [] satisfies Passage[];
      },
    };
    const script: FakeScript = () => ({ text: 'answer' });
    const g = buildInline(script, {
      retriever,
      retrievalFilter: (a) => ({ tenantRef: a.tenantRef }),
    });

    const actorA: Actor = { id: 'u-a', roles: ['ADMIN'], tenantRef: 'tenant-a' };
    const actorB: Actor = { id: 'u-b', roles: ['ADMIN'], tenantRef: 'tenant-b' };

    const runA = await g.service.chat({ actor: actorA, message: 'hi' });
    await collectStream(g.service, runA.runId);
    const runB = await g.service.chat({ actor: actorB, message: 'hi' });
    await collectStream(g.service, runB.runId);

    expect(seenFilters).toEqual([{ tenantRef: 'tenant-a' }, { tenantRef: 'tenant-b' }]);
  });

  it('4. durable replay: the filter hook is not re-invoked on a replayed step', async () => {
    let filterCalls = 0;
    let retrieveCalls = 0;
    const retriever: Retriever = {
      retrieve: async () => {
        retrieveCalls += 1;
        return [{ id: 'kb#0', text: 'CTX', score: 1 }] satisfies Passage[];
      },
    };
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'acting', toolCall: { name: 'danger', input: {} } }
        : { text: 'done' };
    const g = buildDurable(script, {
      retriever,
      retrievalFilter: (a) => {
        filterCalls += 1;
        return { tenantRef: a.tenantRef };
      },
    });
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ ok: true }) },
    );

    const tenantActor: Actor = { id: 'u-tenant', roles: ['ADMIN'], tenantRef: 'tenant-abc' };
    const { runId } = await g.service.chat({ actor: tenantActor, message: 'go' });
    await waitFor(() => g.store.toolCallRows().some((r) => r.status === 'pending_approval'));
    expect(retrieveCalls).toBe(1);
    expect(filterCalls).toBe(1);

    await g.service.approve(runId, 'call-0-danger');
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    // The workflow body replayed after resume, but the `retrieve` step (which computes the
    // filter INSIDE its own body) was checkpointed — neither the hook nor the retriever re-run.
    expect(retrieveCalls).toBe(1);
    expect(filterCalls).toBe(1);
  });

  it('5. a hook that throws fails the turn — it does NOT fall back to unfiltered retrieval', async () => {
    let retrieveCalls = 0;
    const retriever: Retriever = {
      retrieve: async () => {
        retrieveCalls += 1;
        return [] satisfies Passage[];
      },
    };
    const script: FakeScript = () => ({ text: 'should not be reached' });
    const g = buildInline(script, {
      retriever,
      retrievalFilter: () => {
        throw new Error('acl lookup failed');
      },
    });

    const { runId } = await g.service.chat({ actor, message: 'hi' });
    const streamed = await collectStream(g.service, runId);

    // The retriever must never have been called — a filter that fails open (falling back to
    // unfiltered retrieval) is worse than no filter at all.
    expect(retrieveCalls).toBe(0);
    expect(streamed).toContain('[error]');
    expect(streamed).toContain('acl lookup failed');
    const run = g.store.governanceRuns().find((r) => r.runId === runId);
    expect(run?.status).toBe('failed');
  });
});
