import { describe, expect, it, vi } from 'vitest';
import { builtinBedrockPrice, ModelPriceResolver, resolveUsageCost } from '../src/index.js';
import { InMemoryPricingStore } from '../src/testing/index.js';

const GOV_SONNET = 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0';

function catalogFetch(catalog: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
}

describe('resolveUsageCost', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const price = { modelId: 'm', inputPricePer1m: 1, outputPricePer1m: 2 };

  it('takes the reported figure as the provider cost', () => {
    expect(resolveUsageCost(usage, 0.5, price)).toEqual({ costUsd: 0.5, costSource: 'provider' });
  });

  it('estimates off the price when nothing was reported', () => {
    expect(resolveUsageCost(usage, undefined, price)).toEqual({
      costUsd: 3,
      costSource: 'estimate',
    });
  });

  it('records no cost when there is neither', () => {
    expect(resolveUsageCost(usage, undefined, undefined)).toEqual({});
  });
});

describe('ModelPriceResolver', () => {
  it("reads the store's row, by a Bedrock candidate of the id too", async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({
      modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      inputPricePer1m: 9,
      outputPricePer1m: 9,
    });
    const resolver = new ModelPriceResolver({ pricingStore: store, catalog: false });
    expect(
      await resolver.priceFor({ modelId: 'amazon-bedrock/x', aliases: [GOV_SONNET] }),
    ).toMatchObject({ inputPricePer1m: 9 });
  });

  it('seeds a missing GovCloud Bedrock row from the built-in table, never models.dev', async () => {
    const store = new InMemoryPricingStore();
    const fetch = catalogFetch({});
    const resolver = new ModelPriceResolver({ pricingStore: store, catalog: { fetch } });
    const price = await resolver.priceFor({
      modelId: `amazon-bedrock/${GOV_SONNET}`,
      provider: 'amazon-bedrock',
      aliases: [GOV_SONNET],
    });
    expect(price).toMatchObject({
      inputPricePer1m: 3.6,
      outputPricePer1m: 18,
      cacheReadPricePer1m: 0.36,
      cacheWritePricePer1m: 4.5,
    });
    expect(fetch).not.toHaveBeenCalled();
    // Written as a row, so the dashboard and the next run read the same price.
    expect((await store.listCurrentPrices()).map((row) => row.modelId)).toContain(GOV_SONNET);
  });

  it("prefers the app's priceCatalog.prices, and seeds only once per model", async () => {
    const store = new InMemoryPricingStore();
    const list = vi.spyOn(store, 'listCurrentPrices');
    const resolver = new ModelPriceResolver({
      pricingStore: store,
      catalog: { modelsDev: false, prices: [{ model: 'acme/m1', input: 1, output: 2 }] },
      cacheMs: 60_000,
    });
    expect(await resolver.priceFor({ modelId: 'acme/m1' })).toMatchObject({
      inputPricePer1m: 1,
    });
    const reads = list.mock.calls.length;
    await resolver.priceFor({ modelId: 'acme/m1' });
    expect(list.mock.calls.length).toBe(reads);
  });

  it('warns once, and only when no id got a price', async () => {
    const warn = vi.fn();
    const resolver = new ModelPriceResolver({
      pricingStore: new InMemoryPricingStore(),
      catalog: { modelsDev: false },
      log: { info: () => undefined, warn },
    });
    expect(await resolver.priceFor({ modelId: 'acme/unknown' })).toBeUndefined();
    expect(await resolver.priceFor({ modelId: 'acme/unknown' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('acme/unknown');
  });

  describe('without a pricing store', () => {
    it('uses the app prices', async () => {
      const resolver = new ModelPriceResolver({
        catalog: {
          modelsDev: false,
          prices: [{ model: 'm', input: 2, output: 4, unit: '1K tokens' }],
        },
      });
      expect(await resolver.priceFor({ modelId: 'p/m', aliases: ['m'] })).toMatchObject({
        inputPricePer1m: 2000,
        outputPricePer1m: 4000,
      });
    });

    it('uses the built-in table for a Bedrock model in a GovCloud region', async () => {
      const resolver = new ModelPriceResolver({
        catalog: { modelsDev: false, region: 'us-gov-west-1' },
      });
      expect(
        await resolver.priceFor({
          modelId: 'amazon-bedrock/meta.llama3-8b-instruct-v1:0',
          provider: 'amazon-bedrock',
          aliases: ['meta.llama3-8b-instruct-v1:0'],
        }),
      ).toMatchObject({ inputPricePer1m: 0.3, outputPricePer1m: 0.6 });
    });

    it('looks a commercial model up on models.dev', async () => {
      const fetch = catalogFetch({
        openai: { models: { 'gpt-4o-mini': { cost: { input: 0.15, output: 0.6 } } } },
      });
      const resolver = new ModelPriceResolver({ catalog: { fetch } });
      expect(
        await resolver.priceFor({
          modelId: 'openai/gpt-4o-mini',
          provider: 'openai',
          aliases: ['gpt-4o-mini'],
        }),
      ).toMatchObject({ modelId: 'openai/gpt-4o-mini', inputPricePer1m: 0.15 });
    });

    it('never throws: an unreachable catalog is no price', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('offline');
      });
      const resolver = new ModelPriceResolver({ catalog: { fetch } });
      expect(
        await resolver.priceFor({ modelId: 'openai/gpt-4o-mini', provider: 'openai' }),
      ).toBeUndefined();
    });
  });
});

describe('the built-in GovCloud table', () => {
  it.each([
    ['us-gov.openai.gpt-oss-120b-1:0', 0.18, 0.72, undefined],
    ['amazon.nova-pro-v1:0', 0.96, 3.84, 0.24],
    ['amazon.nova-lite-v1:0', 0.072, 0.288, 0.018],
    ['amazon.nova-micro-v1:0', 0.042, 0.168, 0.0105],
    ['meta.llama3-70b-instruct-v1:0', 2.65, 3.5, undefined],
    ['us-gov.nvidia.nemotron-super-3-120b', 0.18, 0.78, undefined],
    ['us-gov.xai.grok-4.6', 2.64, 7.92, 0.66],
  ])('prices %s at the published us-gov-west-1 rate', (id, input, output, cacheRead) => {
    const price = builtinBedrockPrice(id, 'aws-us-gov');
    expect(price).toMatchObject({ inputPricePer1m: input, outputPricePer1m: output });
    expect(price?.cacheReadPricePer1m).toBe(cacheRead);
  });
});
