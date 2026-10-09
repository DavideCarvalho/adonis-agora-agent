import { describe, expect, it, vi } from 'vitest';
import { ensureModelPricing } from '../src/pricing/boot-pricing.js';
import { modelsDevRefsFor } from '../src/pricing/models-dev.js';
import type { DescribedModel } from '../src/spi/model-provider.js';
import { InMemoryPricingStore } from '../src/testing/index.js';

const CATALOG = {
  openai: {
    models: { 'gpt-4o-mini': { cost: { input: 0.15, output: 0.6, cache_read: 0.075 } } },
  },
  openrouter: {
    models: {
      'deepseek/deepseek-v4.1-flash': { cost: { input: 0.3, output: 1.2, cache_read: 0.006 } },
    },
  },
};

function fakeFetch(body: unknown = CATALOG, ok = true) {
  return vi.fn(
    async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as unknown as Response,
  );
}

function log() {
  return { info: vi.fn(), warn: vi.fn() };
}

const openRouter: DescribedModel = {
  modelId: 'deepseek/deepseek-v4.1-flash',
  provider: 'openrouter',
  reportsCost: true,
};
const openAi: DescribedModel = { modelId: 'gpt-4o-mini', provider: 'openai', reportsCost: false };
const unknown: DescribedModel = { modelId: 'secret-1', provider: 'acme', reportsCost: false };

describe('modelsDevRefsFor', () => {
  it('tries <provider>/<id>, then the OpenRouter list price for an OpenRouter-style id', () => {
    expect(modelsDevRefsFor('gpt-4o-mini', 'openai')).toEqual(['openai/gpt-4o-mini']);
    expect(modelsDevRefsFor('deepseek/deepseek-v4.1-flash', 'openrouter')).toEqual([
      'openrouter/deepseek/deepseek-v4.1-flash',
    ]);
    // OpenRouter reached through `@ai-sdk/openai` with a custom baseURL.
    // A Vercel AI Gateway id carries its own provider.
    expect(modelsDevRefsFor('openai/gpt-4o-mini', 'vercel')).toEqual([
      'vercel/openai/gpt-4o-mini',
      'openai/gpt-4o-mini',
      'openrouter/openai/gpt-4o-mini',
    ]);
    expect(modelsDevRefsFor('deepseek/deepseek-v4.1-flash', 'openai')).toEqual([
      'openai/deepseek/deepseek-v4.1-flash',
      'openrouter/deepseek/deepseek-v4.1-flash',
    ]);
  });
});

describe('ensureModelPricing', () => {
  it('seeds a missing row from models.dev, keyed so the ledger id resolves to it', async () => {
    const store = new InMemoryPricingStore();
    const l = log();
    const result = await ensureModelPricing({
      models: [openRouter, openAi],
      pricingStore: store,
      catalog: { fetch: fakeFetch() },
      log: l,
    });
    expect(result).toEqual({
      seeded: ['deepseek/deepseek-v4.1-flash', 'gpt-4o-mini'],
      unpriced: [],
    });
    const rows = await store.listCurrentPrices();
    expect(rows.map((r) => [r.modelId, r.inputPricePer1m, r.outputPricePer1m])).toEqual([
      ['deepseek/deepseek-v4.1-flash', 0.3, 1.2],
      ['gpt-4o-mini', 0.15, 0.6],
    ]);
    expect(l.info).toHaveBeenCalledTimes(1);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('never overwrites a price the operator set', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({
      modelId: 'gpt-4o-mini',
      inputPricePer1m: 9,
      outputPricePer1m: 9,
    });
    const fetch = fakeFetch();
    const result = await ensureModelPricing({
      models: [openAi],
      pricingStore: store,
      catalog: { fetch },
      log: log(),
    });
    expect(result.seeded).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect((await store.listCurrentPrices())[0]?.inputPricePer1m).toBe(9);
  });

  it('warns once, naming the models that will record a NULL cost', async () => {
    const l = log();
    const result = await ensureModelPricing({
      models: [openRouter, openAi, unknown],
      pricingStore: new InMemoryPricingStore(),
      catalog: { fetch: fakeFetch({}) },
      log: l,
    });
    // The OpenRouter model reports its own cost, so it is not unpriced even without a row.
    expect(result.unpriced).toEqual(['gpt-4o-mini', 'secret-1']);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(String(l.warn.mock.calls[0]?.[0])).toContain('gpt-4o-mini, secret-1');
  });

  it('warns when no pricing store is bound at all', async () => {
    const l = log();
    const result = await ensureModelPricing({
      models: [openAi],
      pricingStore: undefined,
      catalog: { fetch: fakeFetch() },
      log: l,
    });
    expect(result.unpriced).toEqual(['gpt-4o-mini']);
    expect(String(l.warn.mock.calls[0]?.[0])).toContain('no `pricingStore`');
  });

  it('survives an unreachable catalog: says so, then warns about the unpriced model', async () => {
    const l = log();
    const result = await ensureModelPricing({
      models: [openAi],
      pricingStore: new InMemoryPricingStore(),
      catalog: { fetch: fakeFetch(CATALOG, false) },
      log: l,
    });
    expect(result).toEqual({ seeded: [], unpriced: ['gpt-4o-mini'] });
    expect(l.warn).toHaveBeenCalledTimes(2);
  });

  it('bounds the catalog fetch with a timeout signal when none is given', async () => {
    const fetch = fakeFetch();
    await ensureModelPricing({
      models: [openAi],
      pricingStore: new InMemoryPricingStore(),
      catalog: { fetch },
      log: log(),
    });
    const init = (fetch.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('with `catalog: false` fetches nothing and still warns', async () => {
    const l = log();
    const result = await ensureModelPricing({
      models: [openAi],
      pricingStore: new InMemoryPricingStore(),
      catalog: false,
      log: l,
    });
    expect(result.unpriced).toEqual(['gpt-4o-mini']);
    expect(l.warn).toHaveBeenCalledTimes(1);
  });

  it('is silent when every model is a gateway model or already priced', async () => {
    const l = log();
    await ensureModelPricing({
      models: [openRouter],
      pricingStore: new InMemoryPricingStore(),
      catalog: { fetch: fakeFetch({}) },
      log: l,
    });
    expect(l.warn).not.toHaveBeenCalled();
  });
});
