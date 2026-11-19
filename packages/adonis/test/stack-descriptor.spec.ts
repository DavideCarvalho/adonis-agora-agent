import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { Database } from '@adonisjs/lucid/database';
import type { LanguageModel } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { aiSdkModel, aiSdkModels } from '../src/ai-sdk/ai-sdk-model.js';
import { openAiEmbeddings } from '../src/rag/openai-embeddings.js';
import type { ModelProvider } from '../src/spi/model-provider.js';
import { modelFamily, STACK_DESCRIPTOR, stackUsesOf } from '../src/stack.js';
import type { StoreContext } from '../src/stores/factory.js';
import {
  governanceQueries,
  pricingStores,
  retrievers,
  stores,
  tokenSinks,
} from '../src/stores/factory.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { makeMemoryDb } from './helpers/make-db.js';

const fakeModel = (provider: string, modelId: string) =>
  ({ provider, modelId, specificationVersion: 'v3' }) as unknown as LanguageModel;

describe('stack descriptors on the config factories', () => {
  it('uses the global symbol, non-enumerable', () => {
    const factory = stores.lucid({ connection: 'pg' });
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    expect(Object.getOwnPropertyDescriptor(factory, STACK_DESCRIPTOR)?.enumerable).toBe(false);
  });

  it('stores.lucid names its connection, for chat history', () => {
    expect(stackUsesOf(stores.lucid({ connection: 'pg' }))).toEqual([
      { tech: 'sql', connection: 'pg', purpose: 'chat history' },
    ]);
    expect(stackUsesOf(stores.lucid())).toEqual([{ tech: 'sql', purpose: 'chat history' }]);
    expect(stackUsesOf(stores.memory())).toEqual([]);
  });

  it('pricing, governance and the Lucid sink name their connection', () => {
    expect(stackUsesOf(pricingStores.lucid({ connection: 'pg' }))).toEqual([
      { tech: 'sql', connection: 'pg', purpose: 'model pricing' },
    ]);
    expect(stackUsesOf(governanceQueries.lucid({ connection: 'pg' }))).toEqual([
      { tech: 'sql', connection: 'pg', purpose: 'governance' },
    ]);
    expect(stackUsesOf(tokenSinks.lucid({ connection: 'pg' }))).toEqual([
      { tech: 'sql', connection: 'pg', purpose: 'token stream' },
    ]);
  });

  it('tokenSinks.redis is redis, on its connection', () => {
    expect(stackUsesOf(tokenSinks.redis({ connection: 'main' }))).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'token stream' },
    ]);
    expect(stackUsesOf(tokenSinks.redis())).toEqual([{ tech: 'redis', purpose: 'token stream' }]);
  });

  it('retrievers carry the vector store and the embedder, never the url', () => {
    const embedder = openAiEmbeddings({ model: 'text-embedding-3-small', apiKey: 'sk-secret' });
    expect(stackUsesOf(embedder)).toEqual([
      { tech: 'openai', label: 'text-embedding-3-small', purpose: 'embeddings' },
    ]);
    expect(stackUsesOf(retrievers.pgvector({ embedder, connection: 'pg' }))).toEqual([
      { tech: 'sql', connection: 'pg', purpose: 'vector store' },
      { tech: 'openai', label: 'text-embedding-3-small', purpose: 'embeddings' },
    ]);
    const qdrant = stackUsesOf(
      retrievers.qdrant({
        embedder,
        url: 'https://user:pw@qdrant.example.com:6333',
        apiKey: 'k',
        collection: 'docs',
      }),
    );
    expect(qdrant[0]).toEqual({
      tech: 'qdrant',
      label: 'docs',
      purpose: 'vector store',
      host: 'qdrant.example.com:6333',
    });
    expect(JSON.stringify(qdrant)).not.toMatch(/pw|sk-secret/);

    const local = openAiEmbeddings({ model: 'bge-m3', baseUrl: 'http://localhost:11434/v1' });
    expect(stackUsesOf(local)).toEqual([
      {
        tech: 'openai-compatible',
        label: 'bge-m3',
        purpose: 'embeddings',
        host: 'localhost:11434',
      },
    ]);
  });
});

describe('Lucid factories complete their use at boot', () => {
  let db: Database;
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('names the default connection and its engine once the Database resolves', async () => {
    db = makeMemoryDb();
    const ctx = {
      app: { container: { make: async () => db } },
    } as unknown as StoreContext;
    const factory = stores.lucid();
    await factory(ctx);
    expect(stackUsesOf(factory)).toEqual([
      { tech: 'sqlite', connection: db.primaryConnectionName, purpose: 'chat history' },
    ]);
  });
});

describe('LLM descriptors', () => {
  it('modelFamily drops vendor prefixes, dates and Bedrock suffixes', () => {
    expect(modelFamily('us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      'claude-sonnet-4-5',
    );
    expect(modelFamily('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(modelFamily('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(modelFamily('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('aiSdkModel carries its provider and model family', () => {
    const provider = aiSdkModel(fakeModel('anthropic.messages', 'claude-sonnet-4-5-20250929'));
    expect(stackUsesOf(provider)).toEqual([
      { tech: 'anthropic', label: 'claude-sonnet-4-5', purpose: 'LLM' },
    ]);
  });

  it('aiSdkModels carries one use per provider/family', () => {
    const provider = aiSdkModels({
      a: fakeModel('openai.responses', 'gpt-4o-mini'),
      b: fakeModel('openai.chat', 'gpt-4o-mini'),
      c: fakeModel('google.generative-ai', 'gemini-2.5-flash'),
    });
    expect(stackUsesOf(provider)).toEqual([
      { tech: 'openai', label: 'gpt-4o-mini', purpose: 'LLM' },
      { tech: 'google', label: 'gemini-2.5-flash', purpose: 'LLM' },
    ]);
  });

  it('the provider describes a lazy `model` thunk once it resolves it at boot', async () => {
    const model: ModelProvider = {
      async runTurn() {
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
      describeModels: () => [{ modelId: 'gpt-4o-mini', provider: 'openai', reportsCost: false }],
    };
    const thunk = () => model;
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
        config: {
          agent: {
            model: thunk,
            store: 'fake',
            stores: { fake: async () => new InMemoryAgentStore() },
            pricingStore: false,
            governanceQueries: false,
            priceCatalog: false,
            actorResolver: { resolve: async () => ({ id: 'u1', roles: [] }) },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('test');
    await app.init();
    await app.boot();
    const configured = app.config.get<{ model: unknown }>('agent').model;
    expect(stackUsesOf(configured)).toEqual([
      { tech: 'openai', label: 'gpt-4o-mini', purpose: 'LLM' },
    ]);
    await app.terminate();
  }, 30_000);
});
