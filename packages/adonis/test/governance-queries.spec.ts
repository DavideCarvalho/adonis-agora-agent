import { describe, expect, it } from 'vitest';
import {
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  type InMemoryModelPrice,
} from '../src/testing/index.js';

// Records against a live InMemoryAgentStore, exactly as the agent loop would, then asserts the
// read-model aggregations. A priced model (`gpt-x`) + an unpriced model (`free-y`) exercise the
// unpriced → 0-cost path. All rows land on the current UTC day (the store stamps `new Date()`).

async function seed(): Promise<{ store: InMemoryAgentStore; today: string }> {
  const store = new InMemoryAgentStore();
  const today = new Date().toISOString().slice(0, 10);

  const aliceThread = await store.createThread({
    actor: { id: 'alice' },
    persona: 'default',
    title: 'Alice chat',
  });
  const aliceMessage = await store.appendMessage({
    threadId: aliceThread.id,
    role: 'assistant',
    content: 'looking that up',
  });
  // alice/gpt-x → cost 1*3 + 0.5*15 = 10.5
  await store.recordUsage({
    threadId: aliceThread.id,
    actorRef: 'alice',
    modelId: 'gpt-x',
    purpose: 'chat',
    usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
  });
  // alice/free-y (unpriced) → cost 0
  await store.recordUsage({
    threadId: aliceThread.id,
    actorRef: 'alice',
    modelId: 'free-y',
    purpose: 'chat',
    usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
  });
  await store.recordToolCall({
    toolCallId: 'tc-search',
    messageId: aliceMessage.id,
    toolName: 'search',
    toolType: 'read',
    input: {},
    status: 'executed',
  });

  const bobThread = await store.createThread({
    actor: { id: 'bob' },
    persona: 'default',
    title: 'Bob chat',
  });
  const bobMessage = await store.appendMessage({
    threadId: bobThread.id,
    role: 'assistant',
    content: 'on it',
  });
  // bob/gpt-x → cost 0.5*3 + 0.1*15 = 3.0
  await store.recordUsage({
    threadId: bobThread.id,
    actorRef: 'bob',
    modelId: 'gpt-x',
    purpose: 'chat',
    usage: { inputTokens: 500_000, outputTokens: 100_000 },
  });
  await store.recordToolCall({
    toolCallId: 'tc-deploy',
    messageId: bobMessage.id,
    toolName: 'deploy',
    toolType: 'action',
    input: {},
    status: 'pending_approval',
  });

  return { store, today };
}

const pricing: ReadonlyMap<string, InMemoryModelPrice> = new Map([
  ['gpt-x', { inputPricePer1m: 3, outputPricePer1m: 15 }],
]);

describe('InMemoryGovernanceQueries', () => {
  it('spendByModel aggregates tokens + cost, unpriced model costs 0, priced sorts first', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows).toHaveLength(2);

    const [priced, unpriced] = rows;
    expect(priced?.modelId).toBe('gpt-x');
    expect(priced?.requests).toBe(2);
    expect(priced?.inputTokens).toBe(1_500_000);
    expect(priced?.outputTokens).toBe(600_000);
    expect(priced?.costUsd).toBeCloseTo(13.5, 6);

    expect(unpriced?.modelId).toBe('free-y');
    expect(unpriced?.requests).toBe(1);
    expect(unpriced?.costUsd).toBe(0);
  });

  it('spendByActor rolls up per-actor tokens + cost across models', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByActor({ fromDay: today, toDay: today });
    expect(rows).toHaveLength(2);

    const alice = rows.find((row) => row.actorRef === 'alice');
    expect(alice?.requests).toBe(2);
    expect(alice?.totalTokens).toBe(4_500_000);
    expect(alice?.costUsd).toBeCloseTo(10.5, 6);

    const bob = rows.find((row) => row.actorRef === 'bob');
    expect(bob?.requests).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
    expect(bob?.costUsd).toBeCloseTo(3.0, 6);
  });

  it('usageTrend buckets tokens + cost by UTC day', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const points = await queries.usageTrend({ fromDay: today, toDay: today });
    expect(points).toHaveLength(1);
    expect(points[0]?.day).toBe(today);
    expect(points[0]?.totalTokens).toBe(5_100_000);
    expect(points[0]?.costUsd).toBeCloseTo(13.5, 6);
  });

  it('an out-of-range window yields no spend', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    expect(await queries.spendByModel({ fromDay: '1999-01-01', toDay: '1999-12-31' })).toEqual([]);
  });

  it('defaults to zero cost when no pricing map is supplied', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows.every((row) => row.costUsd === 0)).toBe(true);
    // tokens still counted even with no pricing
    expect(rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)).toBe(5_100_000);
  });

  it('prefers the provider-reported cost over the pricing estimate, per row', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      persona: 'default',
      title: 'Gateway chat',
    });
    // gpt-x would estimate 1*3 + 0.5*15 = 10.5, but the gateway reported 4.2 — the report wins.
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      costUsd: 4.2,
    });
    // an unpriced model that still reports a real cost — no longer collapses to 0.
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'free-y',
      purpose: 'chat',
      usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      costUsd: 1.3,
    });
    const queries = new InMemoryGovernanceQueries(store, pricing);

    const byModel = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(byModel.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(4.2, 6);
    expect(byModel.find((row) => row.modelId === 'free-y')?.costUsd).toBeCloseTo(1.3, 6);

    const byActor = await queries.spendByActor({ fromDay: today, toDay: today });
    expect(byActor.find((row) => row.actorRef === 'alice')?.costUsd).toBeCloseTo(5.5, 6);

    const trend = await queries.usageTrend({ fromDay: today, toDay: today });
    expect(trend[0]?.costUsd).toBeCloseTo(5.5, 6);
  });

  it('prices cache-write and cache-read tokens at their own rates, uncached remainder at input rate', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      persona: 'default',
      title: 'Cached chat',
    });
    // Of 1M input tokens, 200k were cache writes and 300k cache reads → 500k uncached.
    // cost = 0.5*3 + 0.2*3.75 + 0.3*0.3 + 0.5*15 = 1.5 + 0.75 + 0.09 + 7.5 = 9.84
    // (naive input*inputPrice would have charged 10.5).
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
      },
    });
    const cachePricing: ReadonlyMap<string, InMemoryModelPrice> = new Map([
      [
        'gpt-x',
        {
          inputPricePer1m: 3,
          outputPricePer1m: 15,
          cacheWritePricePer1m: 3.75,
          cacheReadPricePer1m: 0.3,
        },
      ],
    ]);
    const queries = new InMemoryGovernanceQueries(store, cachePricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows[0]?.costUsd).toBeCloseTo(9.84, 6);
    // input/output token columns are unchanged — cache tokens are a subset of inputTokens
    expect(rows[0]?.inputTokens).toBe(1_000_000);
    expect(rows[0]?.outputTokens).toBe(500_000);
  });

  it('falls back to the input rate for cache tokens when no cache price is configured', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      persona: 'default',
      title: 'Cached chat',
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
      },
    });
    // no cache prices on gpt-x → all input-side tokens at 3 → 1*3 + 0.5*15 = 10.5
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows[0]?.costUsd).toBeCloseTo(10.5, 6);
  });

  it('recentToolCalls resolves the thread id and caps at the limit', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.recentToolCalls(10);
    expect(rows).toHaveLength(2);

    const search = rows.find((row) => row.toolCallId === 'tc-search');
    expect(search?.toolName).toBe('search');
    expect(search?.toolType).toBe('read');
    expect(search?.threadId).toBeTruthy();

    const deploy = rows.find((row) => row.toolCallId === 'tc-deploy');
    expect(deploy?.status).toBe('pending_approval');
    expect(deploy?.threadId).not.toBe(search?.threadId);

    expect(await queries.recentToolCalls(1)).toHaveLength(1);
  });

  it('recentThreads rolls up message count + tokens per thread', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.recentThreads(10);
    expect(rows).toHaveLength(2);

    const alice = rows.find((row) => row.title === 'Alice chat');
    expect(alice?.actorRef).toBe('alice');
    expect(alice?.messageCount).toBe(1);
    expect(alice?.totalTokens).toBe(4_500_000);

    const bob = rows.find((row) => row.title === 'Bob chat');
    expect(bob?.messageCount).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
  });
});
