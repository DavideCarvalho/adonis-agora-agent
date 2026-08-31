import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentPricingStore,
  DefaultRolesPolicy,
  type ModelProvider,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryPricingStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

interface Overrides {
  model?: ModelProvider;
  pricingStore?: AgentPricingStore;
}

async function run(script: FakeScript, overrides: Overrides = {}) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const runId = 'run-1';
  const deps: AgentLoopDeps = {
    model: overrides.model ?? new FakeModelProvider(script),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(overrides.pricingStore !== undefined ? { pricingStore: overrides.pricingStore } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
    hooks,
  );
  const detail = await store.getThread(thread.id);
  const assistant = detail?.messages.find((m) => m.role === 'assistant');
  return { store, assistant };
}

describe('agent-loop cost fold', () => {
  it('leaves costUsd null when no pricing store is bound', async () => {
    const { assistant } = await run(() => ({ text: 'hello' }));
    expect(assistant?.usage?.costUsd).toBeNull();
  });

  it('estimates costUsd from the bound pricing store for a priced model', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'fake-1',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const { assistant } = await run(() => ({ text: 'hello' }), { pricingStore });
    expect(typeof assistant?.usage?.costUsd).toBe('number');
    expect(assistant?.usage?.costUsd).toBeGreaterThan(0);
  });

  it('keeps costUsd null for an unpriced model even with a pricing store bound (never a fabricated 0)', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'some-other-model',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const { assistant } = await run(() => ({ text: 'hello' }), { pricingStore });
    expect(assistant?.usage?.costUsd).toBeNull();
  });

  it('lets a provider-reported costUsd win over the pricing-store estimate', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'fake-1',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const gatewayModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write({ t: 'text', v: 'done' });
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          modelId: 'fake-1',
          costUsd: 0.0042,
        };
      },
    };
    const { store, assistant } = await run(() => ({ text: 'unused' }), {
      model: gatewayModel,
      pricingStore,
    });
    // The gateway's real spend is stamped on the message and persisted verbatim on the usage row.
    expect(assistant?.usage?.costUsd).toBeCloseTo(0.0042, 9);
    expect(store.governanceUsage()[0]?.costUsd).toBeCloseTo(0.0042, 9);
  });

  it('fetches the price list exactly once per run (cached), across multiple steps', async () => {
    const inner = new InMemoryPricingStore();
    await inner.upsertModelPrice({ modelId: 'fake-1', inputPricePer1m: 3, outputPricePer1m: 15 });
    let listCalls = 0;
    const counting: AgentPricingStore = {
      upsertModelPrice: (input) => inner.upsertModelPrice(input),
      listCurrentPrices: () => {
        listCalls += 1;
        return inner.listCurrentPrices();
      },
    };
    const reg = new ToolRegistry();
    reg.register(
      { name: 'noop', kind: 'read', description: 'noop', inputSchema: trivialSchema },
      { execute: async () => ({ ok: true }) },
    );
    // A tool round-trip forces two model turns → two priced steps, one price fetch.
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'calling', toolCall: { name: 'noop', input: {} } }
        : { text: 'final' };
    await runAgentLoop(
      {
        model: new FakeModelProvider(script),
        store,
        registry: reg,
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'test',
        pricingStore: counting,
      },
      { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
      {
        runId: 'run-x',
        openSink: () => sink.open('run-x'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    expect(listCalls).toBe(1);
    const detail = await store.getThread(thread.id);
    const assistants = detail?.messages.filter((m) => m.role === 'assistant') ?? [];
    expect(assistants).toHaveLength(2);
    for (const m of assistants) {
      expect(typeof m.usage?.costUsd).toBe('number');
    }
  });
});

const trivialSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};
