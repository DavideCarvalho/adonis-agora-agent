import { describe, expect, it } from 'vitest';
import { LedgerQuotaProvider } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';

const actor = { id: 'u1', roles: [] as string[] };

/** One estimated row (a Bedrock turn priced off the table) and one provider-reported row. */
async function ledger() {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor, persona: 'default' });
  await store.recordUsage({
    threadId: thread.id,
    actorRef: 'u1',
    modelId: 'bedrock-model',
    purpose: 'chat',
    usage: { inputTokens: 10_605, outputTokens: 5 },
    costUsd: 0.038268,
    costSource: 'estimate',
  });
  await store.recordUsage({
    threadId: thread.id,
    actorRef: 'u1',
    modelId: 'gateway-model',
    purpose: 'chat',
    usage: { inputTokens: 10, outputTokens: 10 },
    costUsd: 0.01,
    costSource: 'provider',
  });
  return store;
}

describe('LedgerQuotaProvider USD windows', () => {
  it('count estimated cost by default, so a USD ceiling binds on a provider that reports none', async () => {
    const provider = new LedgerQuotaProvider(await ledger(), undefined, { day: { usd: 0.04 } });
    const report = await provider.report({ actor });
    const day = report.windows.find((window) => window.period === 'day');
    expect(day?.usedUsd).toBeCloseTo(0.048268, 9);
    expect(report.blocked).toMatchObject({ period: 'day' });
  });

  it('with countEstimatedCost: false count provider-reported cost only', async () => {
    const provider = new LedgerQuotaProvider(
      await ledger(),
      undefined,
      { day: { usd: 0.04 } },
      { countEstimatedCost: false },
    );
    const report = await provider.report({ actor });
    const day = report.windows.find((window) => window.period === 'day');
    expect(day?.usedUsd).toBeCloseTo(0.01, 9);
    expect(report.blocked).toBeUndefined();
  });
});
