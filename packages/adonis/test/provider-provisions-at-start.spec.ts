import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { describe, expect, it } from 'vitest';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

/**
 * The provider provisions the schema ONCE as the app starts, not on the first agent call — which ran
 * inside whatever transaction that caller had open. A store says it manages a schema by exposing
 * `ensureSchema()`; the three Lucid stores do.
 */
async function startApp(environment: 'web' | 'test' | 'console', store: object) {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: { generate: async () => ({ content: 'ok' }) },
          store: 'fake',
          stores: { fake: async () => store },
          pricingStore: false,
          governanceQueries: false,
        },
      },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp(environment);
  await app.init();
  await app.boot();
  let provisionedBeforeReady = false;
  await app.start(async () => {
    provisionedBeforeReady = (store as { calls: number }).calls > 0;
  });
  return { provisionedBeforeReady };
}

class SchemaOwningStore extends InMemoryAgentStore {
  calls = 0;
  failure: Error | null = null;
  async ensureSchema(): Promise<void> {
    this.calls += 1;
    if (this.failure !== null) throw this.failure;
  }
}

// Booting a real app: the first one pays for importing the framework.
describe('the agent provider provisions the schema at start', { timeout: 30_000 }, () => {
  it('calls ensureSchema() once, before the app runs anything (web)', async () => {
    const store = new SchemaOwningStore();
    const { provisionedBeforeReady } = await startApp('web', store);
    expect(store.calls).toBe(1);
    expect(provisionedBeforeReady).toBe(true);
  });

  it('does so in the test environment too — before a suite opens its global transaction', async () => {
    const store = new SchemaOwningStore();
    await startApp('test', store);
    expect(store.calls).toBe(1);
  });

  it('leaves ace commands alone: migration:run must not find the tables already there', async () => {
    const store = new SchemaOwningStore();
    await startApp('console', store);
    expect(store.calls).toBe(0);
  });

  it('a failure is reported, not fatal — first use retries', async () => {
    const store = new SchemaOwningStore();
    store.failure = new Error('database is not up yet');
    await expect(startApp('web', store)).resolves.toBeDefined();
    expect(store.calls).toBe(1);
  });

  it('a store with no schema of its own starts as before', async () => {
    await expect(startApp('web', new InMemoryAgentStore())).resolves.toBeDefined();
  });
});
