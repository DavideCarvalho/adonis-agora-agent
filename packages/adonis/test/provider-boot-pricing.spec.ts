import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelsDevOptions } from '../src/pricing/models-dev.js';
import type { ModelProvider } from '../src/spi/model-provider.js';
import { InMemoryAgentStore, InMemoryPricingStore } from '../src/testing/index.js';

const CATALOG = {
  openai: { models: { 'gpt-4o-mini': { cost: { input: 0.15, output: 0.6 } } } },
};

function fakeFetch() {
  return vi.fn(
    async () => ({ ok: true, status: 200, json: async () => CATALOG }) as unknown as Response,
  );
}

const model: ModelProvider = {
  async runTurn() {
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  },
  describeModels: () => [
    { modelId: 'gpt-4o-mini', provider: 'openai', reportsCost: false },
    { modelId: 'secret-1', provider: 'acme', reportsCost: false },
  ],
};

async function boot(
  environment: 'web' | 'test',
  pricingStore: InMemoryPricingStore,
  priceCatalog?: ModelsDevOptions | false,
) {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model,
          store: 'fake',
          stores: { fake: async () => new InMemoryAgentStore() },
          pricingStore,
          governanceQueries: false,
          actorResolver: { resolve: async () => ({ id: 'u1', roles: [] }) },
          ...(priceCatalog !== undefined ? { priceCatalog } : {}),
        },
      },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp(environment);
  await app.init();
  await app.boot();
  await app.start(async () => {});
  // `shutdown` awaits the background pricing check, so the assertions see its result.
  await app.terminate();
}

afterEach(() => vi.restoreAllMocks());

describe('boot pricing in the provider', { timeout: 30_000 }, () => {
  it('seeds missing prices from the catalog and warns about the model it could not price', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pricing = new InMemoryPricingStore();
    const fetch = fakeFetch();
    await boot('web', pricing, { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pricing.listCurrentPrices()).map((row) => row.modelId)).toEqual(['gpt-4o-mini']);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(
      lines.filter((line) => line.includes('No cost will be recorded for secret-1')),
    ).toHaveLength(1);
  });

  it('stays off the network under NODE_ENV=test unless priceCatalog is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pricing = new InMemoryPricingStore();
    await boot('test', pricing);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await pricing.listCurrentPrices()).toEqual([]);
  });
});
