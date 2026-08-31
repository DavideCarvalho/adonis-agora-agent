import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCost, LucidPricingStore, seedModelPrices } from '../src/index.js';
import { InMemoryPricingStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

describe('estimateCost', () => {
  it('prices uncached input + output at their per-1M rates', () => {
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15, effectiveFrom: '' },
    );
    // 1M input @ $3 + 0.5M output @ $15 = 3 + 7.5
    expect(cost).toBeCloseTo(10.5, 9);
  });

  it('prices cache-write / cache-read tokens at their own rates (falling back to input rate)', () => {
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheWriteTokens: 400_000,
        cacheReadTokens: 100_000,
      },
      {
        modelId: 'm',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
        cacheWritePricePer1m: 3.75,
        cacheReadPricePer1m: 0.3,
        effectiveFrom: '',
      },
    );
    // uncached 0.5M @ $3 + 0.4M cache-write @ $3.75 + 0.1M cache-read @ $0.3 = 1.5 + 1.5 + 0.03
    expect(cost).toBeCloseTo(3.03, 9);
    // Without cache rates, cache tokens fall back to the input rate → whole 1M input @ $3.
    const fallback = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheWriteTokens: 400_000,
        cacheReadTokens: 100_000,
      },
      { modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15, effectiveFrom: '' },
    );
    expect(fallback).toBeCloseTo(3, 9);
  });
});

describe('InMemoryPricingStore', () => {
  it('supersedes a model price on re-upsert and lists exactly one current row per model', async () => {
    const store = new InMemoryPricingStore();
    await seedModelPrices(store, [
      { modelId: 'a', inputPricePer1m: 3, outputPricePer1m: 15 },
      { modelId: 'b', inputPricePer1m: 1, outputPricePer1m: 2, cacheReadPricePer1m: 0.1 },
    ]);
    await store.upsertModelPrice({ modelId: 'a', inputPricePer1m: 5, outputPricePer1m: 20 });

    const prices = await store.listCurrentPrices();
    expect(prices).toHaveLength(2);
    const a = prices.find((p) => p.modelId === 'a');
    expect(a).toMatchObject({ inputPricePer1m: 5, outputPricePer1m: 20 });
    const b = prices.find((p) => p.modelId === 'b');
    expect(b).toMatchObject({ inputPricePer1m: 1, cacheReadPricePer1m: 0.1 });
  });
});

describe('LucidPricingStore', () => {
  let db: Database;
  let store: LucidPricingStore;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidPricingStore(asStoreDb(db));
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('atomically supersedes: only one is_current row survives per model', async () => {
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 5, outputPricePer1m: 20 });

    const current = await store.listCurrentPrices();
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ modelId: 'm', inputPricePer1m: 5, outputPricePer1m: 20 });
    expect(typeof current[0]?.effectiveFrom).toBe('string');

    // Two physical rows exist, but only one is_current.
    const all = await db.from('agent_model_pricing').where('model_id', 'm').select('*');
    expect(all).toHaveLength(2);
    const live = all.filter((r) => Number(r.is_current) === 1);
    expect(live).toHaveLength(1);
  });

  it('round-trips cache rates and omits them when unset', async () => {
    await store.upsertModelPrice({
      modelId: 'cached',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      cacheWritePricePer1m: 3.75,
      cacheReadPricePer1m: 0.3,
    });
    await store.upsertModelPrice({ modelId: 'plain', inputPricePer1m: 1, outputPricePer1m: 2 });

    const prices = await store.listCurrentPrices();
    const cached = prices.find((p) => p.modelId === 'cached');
    expect(cached).toMatchObject({ cacheWritePricePer1m: 3.75, cacheReadPricePer1m: 0.3 });
    const plain = prices.find((p) => p.modelId === 'plain');
    expect(plain?.cacheWritePricePer1m).toBeUndefined();
    expect(plain?.cacheReadPricePer1m).toBeUndefined();
  });
});
