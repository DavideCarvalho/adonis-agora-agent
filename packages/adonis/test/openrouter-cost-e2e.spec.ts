import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  LedgerQuotaProvider,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  InMemoryPricingStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

// The whole cost path the MeuProntoo ledger came up NULL on, end to end: an OpenRouter model through
// the real `streamText` → the agent loop → the usage ledger → the quota and the governance read-model.

type StreamChunk =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>> extends {
    stream: ReadableStream<infer C>;
  }
    ? C
    : never;

function openRouterModel(cost: number | undefined): MockLanguageModelV3 {
  const chunks: StreamChunk[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', modelId: 'deepseek/deepseek-v4.1-flash' },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'olá' },
    { type: 'text-end', id: '1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
      providerMetadata: {
        openrouter: {
          usage: {
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100,
            ...(cost !== undefined ? { cost } : {}),
          },
        },
      },
    },
  ];
  return new MockLanguageModelV3({
    provider: 'openrouter.chat',
    modelId: 'deepseek/deepseek-v4.1-flash',
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

async function runOnce(model: MockLanguageModelV3, pricingStore = new InMemoryPricingStore()) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const actor = { id: 'u1', roles: ['ADMIN'] };
  const thread = await store.createThread({ actor, persona: 'default' });
  const deps: AgentLoopDeps = {
    model: aiSdkModel(model),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    systemPrompt: 'test',
    day: new Date().toISOString().slice(0, 10),
    pricingStore,
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  await runAgentLoop(deps, { threadId: thread.id, actor, userText: 'oi' }, hooks);
  const detail = await store.getThread(thread.id);
  const assistant = detail?.messages.find((m) => m.role === 'assistant');
  return { store, actor, assistant };
}

describe('OpenRouter cost, end to end', () => {
  it('records the routed cost OpenRouter reports, and every read-model uses it', async () => {
    const { store, actor, assistant } = await runOnce(openRouterModel(0.00131));

    expect(assistant?.usage?.costUsd).toBeCloseTo(0.00131, 9);
    const [row] = store.governanceUsage();
    expect(row?.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(row?.costUsd).toBeCloseTo(0.00131, 9);

    // Quota: a USD ceiling binds on the recorded spend.
    const quota = new LedgerQuotaProvider(store, undefined, { day: { usd: 1 } });
    const report = await quota.report({ actor });
    expect(report.windows[0]?.usedUsd).toBeCloseTo(0.00131, 9);

    // Governance read-model: the recorded cost wins over any list price.
    const queries = new InMemoryGovernanceQueries(
      store,
      new Map([['deepseek/deepseek-v4.1-flash', { inputPricePer1m: 100, outputPricePer1m: 100 }]]),
    );
    const day = row?.day ?? '';
    const [spend] = await queries.spendByModel({ fromDay: day, toDay: day });
    expect(spend?.costUsd).toBeCloseTo(0.00131, 9);
  });

  it('falls back to the price row (an estimate) when OpenRouter reports no cost', async () => {
    const pricing = new InMemoryPricingStore();
    await pricing.upsertModelPrice({
      modelId: 'deepseek/deepseek-v4.1-flash',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
    });
    const { assistant } = await runOnce(openRouterModel(undefined), pricing);
    // 1000 × 0.3/1e6 + 100 × 1.2/1e6
    expect(assistant?.usage?.costUsd).toBeCloseTo(0.00042, 9);
  });

  it('stays null — never 0 — when neither a gateway cost nor a price row exists', async () => {
    const { store, assistant } = await runOnce(openRouterModel(undefined));
    expect(assistant?.usage?.costUsd).toBeNull();
    expect(store.governanceUsage()[0]?.costUsd ?? null).toBeNull();
  });
});
