import type { ApplicationService } from '@adonisjs/core/types';
import type { IngestDocument } from '../rag/ingest.js';
import type { PgVectorColumns, PgVectorMetric } from '../rag/pg-vector-store.js';
import type { QdrantClientLike, QdrantMetric } from '../rag/qdrant-store.js';
import type { RedisStreamClient } from '../redis-stream-client.js';
import type { ActorDirectory } from '../spi/actor-directory.js';
import type { AgentStore } from '../spi/agent-store.js';
import type { AttachmentStagingStore } from '../spi/attachment-staging.js';
import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import type { AgentPricingStore } from '../spi/pricing-store.js';
import type { QuotaStore } from '../spi/quota-store.js';
import type { Retriever } from '../spi/retriever.js';
import type { TokenStreamSink } from '../spi/token-stream-sink.js';
import type { LucidDatabaseLike } from './lucid.js';

/**
 * Runtime context a {@link StoreFactory} thunk receives when the agent provider builds the configured
 * store at boot. Carries the booted application so a driver can resolve a peer's service if it needs to.
 */
export interface StoreContext {
  app: ApplicationService;
}

/**
 * A configured agent store: a thunk the agent provider calls at boot to build the {@link AgentStore}.
 * Each factory lazily imports its peer dependency (`@adonisjs/lucid`) inside the thunk, so the driver
 * is only loaded when it is actually selected — keeping that package optional.
 */
export type StoreFactory = (ctx: StoreContext) => Promise<AgentStore>;

/**
 * Resolve the Lucid `Database` from the IoC container instead of `@adonisjs/lucid/services/db`'s
 * default export.
 *
 * The agent provider builds these store thunks during its own `boot()`, but `services/db` assigns its
 * default only inside `await app.booted(...)` — which runs after every provider's `boot()`. So at the
 * moment a thunk runs, that default is still `undefined` and `db.connection(...)` throws a `TypeError`,
 * failing the whole app boot. The `'lucid.db'` alias is registered in the database provider's
 * `register()` (which runs before any `boot()`) and is the exact binding `services/db` itself resolves,
 * so it is available here. Resolved lazily by string alias, so `@adonisjs/lucid` stays an optional peer.
 */
/**
 * The Lucid connection manager the factories resolve: a {@link LucidDatabaseLike} (usable directly as
 * the default connection) that also exposes `.connection(name)` for a named one.
 */
interface LucidConnectionManagerLike extends LucidDatabaseLike {
  connection(name?: string): LucidDatabaseLike;
}

async function resolveLucidDatabase(app: ApplicationService): Promise<LucidConnectionManagerLike> {
  return (await app.container.make('lucid.db')) as unknown as LucidConnectionManagerLike;
}

/**
 * Marker carrying a `stores.lucid()` factory's configured connection, so the provider can default
 * `pricingStore`/`governanceQueries` to the SAME Lucid connection as the main store. `null` means the
 * app's default connection (no `connection` was passed).
 */
const LUCID_STORE_CONNECTION = Symbol.for('@adonis-agora/agent:lucid-store-connection');

function tagLucidStore(factory: StoreFactory, connection: string | undefined): StoreFactory {
  Object.defineProperty(factory, LUCID_STORE_CONNECTION, {
    value: connection ?? null,
    enumerable: false,
  });
  return factory;
}

/**
 * If `factory` is a `stores.lucid()` store factory, returns its connection (`null` = the app's default
 * connection); otherwise `undefined`. The provider uses this to mirror the main store's Lucid
 * connection when `pricingStore`/`governanceQueries` are left at their defaults.
 */
export function lucidStoreConnection(factory: unknown): string | null | undefined {
  if (typeof factory !== 'function') return undefined;
  const value = (factory as unknown as Record<symbol, unknown>)[LUCID_STORE_CONNECTION];
  return value === undefined ? undefined : (value as string | null);
}

/** Options for the Lucid-backed persistent store. */
export interface LucidStoreConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /**
   * Provision the agent tables on first use — the lib manages its own schema (the ecosystem
   * convention, mirroring durable/authz). Default `true`. Set `false` to run the published migration
   * instead. Governs the pricing store and governance read-model too, which share these tables.
   */
  autoCreateTables?: boolean;
}

/** Options for the in-memory store (single-process, non-durable). */
export type MemoryStoreConfig = Record<string, never>;

/**
 * The store factory namespace used in `config/agent.ts`:
 *
 * ```ts
 * import { defineConfig, stores } from '@adonis-agora/agent'
 *
 * export default defineConfig({
 *   store: 'lucid',
 *   stores: {
 *     memory: stores.memory(),
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link StoreFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds the selected store at boot.
 */
export const stores = {
  /** In-memory store — single-process, non-durable. Handy for tests and scratch/dev apps. */
  memory(_config: MemoryStoreConfig = {}): StoreFactory {
    return async () => {
      const { InMemoryAgentStore } = await import('../testing/in-memory-store.js');
      return new InMemoryAgentStore();
    };
  },

  /** Persist threads/messages/tool-calls/usage in SQL via `@adonisjs/lucid`. */
  lucid(config: LucidStoreConfig = {}): StoreFactory {
    const factory: StoreFactory = async (ctx) => {
      const db = await resolveLucidDatabase(ctx.app);
      const { LucidAgentStore } = await import('./lucid.js');
      const client = (config.connection !== undefined
        ? db.connection(config.connection)
        : db) as unknown as LucidDatabaseLike;
      return new LucidAgentStore(client, {
        ...(config.autoCreateTables !== undefined
          ? { autoCreateTables: config.autoCreateTables }
          : {}),
      });
    };
    // Tag with the connection so the provider can mirror it for pricing/governance defaults.
    return tagLucidStore(factory, config.connection);
  },
};

// ── Quota factories ──────────────────────────────────────────────────────────

/**
 * Runtime context a {@link QuotaFactory} thunk receives — the {@link StoreContext} plus the already
 * built {@link AgentStore}, so a ledger-backed quota store can read the run's own token-usage ledger
 * (no separate quota table). The provider builds the store first, then the quota, then passes it here.
 */
export interface QuotaContext extends StoreContext {
  store: AgentStore;
}

/**
 * A configured quota store: a lazy thunk the agent provider calls at boot. Omitting a quota disables
 * budgeting (fail-open). A plain `() => new InMemoryQuotaStore()` still satisfies this — the context
 * arg is optional to consume.
 */
export type QuotaFactory = (ctx: QuotaContext) => QuotaStore | Promise<QuotaStore>;

/** Options for both bundled quota stores — the daily per-actor token budget. */
export interface QuotaConfig {
  /** Daily token budget per actor. */
  limitTokens: number;
}

/**
 * The quota factory namespace used in `config/agent.ts`, mirroring {@link stores}:
 *
 * ```ts
 * export default defineConfig({
 *   store: 'lucid',
 *   stores: { lucid: stores.lucid() },
 *   quota: quotas.ledger({ limitTokens: 1_000_000 }),
 * })
 * ```
 */
export const quotas = {
  /** In-memory per-actor/day budget — single-process, non-durable. Handy for tests and dev apps. */
  memory(config: QuotaConfig): QuotaFactory {
    return async () => {
      const { InMemoryQuotaStore } = await import('../testing/in-memory-quota.js');
      return new InMemoryQuotaStore(config.limitTokens);
    };
  },

  /**
   * Enforce the budget off the persisted token-usage ledger (the selected `store`) — one source of
   * truth across replicas, with no double-counting. Pairs with any {@link AgentStore}.
   */
  ledger(config: QuotaConfig): QuotaFactory {
    return async ({ store }) => {
      const { LedgerQuotaStore } = await import('./ledger-quota.js');
      return new LedgerQuotaStore(store, config.limitTokens);
    };
  },
};

// ── Pricing factories ────────────────────────────────────────────────────────

/** Runtime context a {@link PricingFactory} thunk receives — the booted application. */
export type PricingContext = StoreContext;

/** A configured pricing store: a lazy thunk the agent provider calls at boot. */
export type PricingFactory = (
  ctx: PricingContext,
) => AgentPricingStore | Promise<AgentPricingStore>;

/** Options for the Lucid-backed pricing store. */
export interface LucidPricingConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /**
   * Provision the shared agent tables on first use. Default `true` (the ecosystem convention) — this
   * is what lets a pricing seed run before the first agent run. Set `false` to run the migration.
   */
  autoCreateTables?: boolean;
}

/**
 * The pricing factory namespace used in `config/agent.ts`, mirroring {@link stores}:
 *
 * ```ts
 * export default defineConfig({
 *   pricingStore: pricingStores.lucid(),
 * })
 * ```
 *
 * Seed model prices once (e.g. in a command) with `seedModelPrices(store, [...])`.
 */
export const pricingStores = {
  /** In-memory pricing table — for tests and the offline demo. */
  memory(): PricingFactory {
    return async () => {
      const { InMemoryPricingStore } = await import('../testing/in-memory-pricing.js');
      return new InMemoryPricingStore();
    };
  },

  /** Persist per-model prices in SQL (the `agent_model_pricing` table) via `@adonisjs/lucid`. */
  lucid(config: LucidPricingConfig = {}): PricingFactory {
    return async (ctx) => {
      const db = await resolveLucidDatabase(ctx.app);
      const { LucidPricingStore } = await import('./lucid-pricing.js');
      const client = (config.connection !== undefined
        ? db.connection(config.connection)
        : db) as unknown as LucidDatabaseLike;
      return new LucidPricingStore(client, {
        ...(config.autoCreateTables !== undefined
          ? { autoCreateTables: config.autoCreateTables }
          : {}),
      });
    };
  },
};

// ── Governance-queries factories ─────────────────────────────────────────────

/**
 * Runtime context a {@link GovernanceQueriesFactory} thunk receives — the {@link StoreContext} plus the
 * already-resolved {@link AgentPricingStore} (when the app configured one), so the read-model prices its
 * cost rollups against the SAME live prices the loop's cost fold uses. The provider resolves pricing
 * first, then the governance queries, then passes it here (mirroring how {@link QuotaContext} carries the
 * built store). `pricingStore` is absent when the app configured none → the read-model reports 0 cost.
 */
export interface GovernanceQueriesContext extends StoreContext {
  pricingStore?: AgentPricingStore;
}

/**
 * A configured governance read-model: a lazy thunk the agent provider calls at boot to build the
 * {@link AgentGovernanceQueries} the optional `/agent/governance/*` read routes serve from. Each factory
 * lazily imports its peer inside the thunk (like {@link stores}), so nothing loads until governance is
 * actually selected.
 */
export type GovernanceQueriesFactory = (
  ctx: GovernanceQueriesContext,
) => AgentGovernanceQueries | Promise<AgentGovernanceQueries>;

/** Options for the Lucid-backed governance read-model. */
export interface LucidGovernanceConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /**
   * Provision the shared agent tables on first use. Default `true` (the ecosystem convention) — lets
   * the governance routes / dashboard answer on a fresh deploy before the first agent run. Set
   * `false` to run the migration.
   */
  autoCreateTables?: boolean;
}

/**
 * The governance-queries factory namespace used in `config/agent.ts`, mirroring {@link pricingStores}:
 *
 * ```ts
 * export default defineConfig({
 *   pricingStore: pricingStores.lucid(),
 *   governanceQueries: governanceQueries.lucid(),
 * })
 * ```
 *
 * The Lucid read-model aggregates the same five agent tables the store writes and prices cost against
 * the configured `pricingStore`; wiring it mounts the `/agent/governance/*` read routes.
 */
export const governanceQueries = {
  /** Aggregate the five agent tables in SQL via `@adonisjs/lucid`, priced against the pricing store. */
  lucid(config: LucidGovernanceConfig = {}): GovernanceQueriesFactory {
    return async (ctx) => {
      const db = await resolveLucidDatabase(ctx.app);
      const { LucidGovernanceQueries } = await import('./lucid-governance-queries.js');
      const client = (config.connection !== undefined
        ? db.connection(config.connection)
        : db) as unknown as LucidDatabaseLike;
      return new LucidGovernanceQueries(client, ctx.pricingStore, {
        ...(config.autoCreateTables !== undefined
          ? { autoCreateTables: config.autoCreateTables }
          : {}),
      });
    };
  },
};

// ── Retriever factories ──────────────────────────────────────────────────────

/** Runtime context a {@link RetrieverFactory} thunk receives — the booted application. */
export type RetrieverContext = StoreContext;

/**
 * A configured retriever: a lazy thunk the agent provider calls at boot to build the {@link Retriever}
 * wired into inject-mode retrieval. Each factory imports the RAG stack inside the thunk, so nothing is
 * loaded until a retriever is actually selected — mirroring {@link stores}/{@link quotas}.
 */
export type RetrieverFactory = (ctx: RetrieverContext) => Retriever | Promise<Retriever>;

/** A lazy {@link EmbeddingProvider} factory, so an embedding SDK peer imports only when the config loads. */
export type EmbeddingFactory = () => EmbeddingProvider | Promise<EmbeddingProvider>;

/** Options for the in-memory embedding retriever (cosine over a Map, no infra). */
export interface MemoryRetrieverConfig {
  /** The embedding provider (query + ingestion), or a lazy factory so its SDK peer loads lazily. */
  embedder: EmbeddingProvider | EmbeddingFactory;
  /** Documents to ingest at boot (chunk → embed → index). Omit to ingest separately at runtime. */
  documents?: IngestDocument[];
  /** Target max characters per chunk. Default 800. */
  chunkSize?: number;
  /** Characters of overlap between chunks. Default 100. */
  overlap?: number;
}

/** Options for the pgvector-backed retriever (production RAG over `@adonisjs/lucid` + pgvector). */
export interface PgVectorRetrieverConfig {
  /** The embedding provider (query + ingestion), or a lazy factory so its SDK peer loads lazily. */
  embedder: EmbeddingProvider | EmbeddingFactory;
  /**
   * A structural Lucid DB handle (bring-your-own). Omit to resolve `@adonisjs/lucid`'s default `db`
   * service lazily inside the thunk (optionally on `connection`), keeping the peer optional.
   */
  db?: LucidDatabaseLike;
  /** Lucid connection name (used only when `db` is omitted). Defaults to the `Database` default. */
  connection?: string;
  /** Chunk table name. Default `agent_rag_chunks`. Validated against a strict identifier regex. */
  table?: string;
  /** Embedding width — must match the model (e.g. 1536 for text-embedding-3-small). Default 1536. */
  dimension?: number;
  /** Similarity metric / distance operator (`cosine` default, `l2`, `inner`). */
  metric?: PgVectorMetric;
  /** Override the physical column names (each validated). */
  columns?: PgVectorColumns;
  /**
   * Provision the `vector` extension, table, and index at boot (idempotent DDL). Handy for tests/scripts;
   * production should run the bundled migration instead. Default `false`.
   */
  ensureSchema?: boolean;
  /** Documents to ingest at boot (chunk → embed → upsert). Omit to ingest separately at runtime. */
  documents?: IngestDocument[];
  /** Target max characters per chunk. Default 800. */
  chunkSize?: number;
  /** Characters of overlap between chunks. Default 100. */
  overlap?: number;
}

/** Options for the Qdrant-backed retriever (production RAG over a managed vector DB, e.g. GuaraCloud). */
export interface QdrantRetrieverConfig {
  /** Embedder (or a lazy factory) — the same shape as `pgvector`/`memory`. */
  embedder: EmbeddingProvider | (() => Promise<EmbeddingProvider>);
  /** Qdrant URL, used when no `client` is passed. Default `http://localhost:6333`. */
  url?: string;
  /** Qdrant API key (optional). */
  apiKey?: string;
  /** A ready structural client — for programmatic use and tests; absent → built from `url`/`apiKey`. */
  client?: QdrantClientLike;
  /** Collection name. Default `agent_rag_chunks`. */
  collection?: string;
  /** Embedding width — must match the model. Default 1536. */
  dimension?: number;
  /** Similarity metric. Default `cosine`. */
  metric?: QdrantMetric;
  /** Provision the collection (dimension + metric) at boot — handy for tests and ingestion. */
  ensureCollection?: boolean;
  /** Documents to ingest at boot (optional, same shape as `pgvector`). */
  documents?: IngestDocument[];
  /** Target max characters per chunk. Default 800. */
  chunkSize?: number;
  /** Characters of overlap between chunks. Default 100. */
  overlap?: number;
}

/**
 * The retriever factory namespace used in `config/agent.ts`, mirroring {@link stores}:
 *
 * ```ts
 * export default defineConfig({
 *   model: () => aiSdkModel({ model: '...' }),
 *   retriever: retrievers.memory({ embedder: myEmbedder, documents: [...] }),
 *   retrievalTopK: 5,
 * })
 * ```
 *
 * Use `retrievers.pgvector({...})` for the production pgvector/Lucid store or `retrievers.qdrant({...})`
 * for a managed Qdrant collection; `retrievers.memory` covers tests and small/embedded corpora.
 */
export const retrievers = {
  /** In-memory embedding retriever — cosine over a Map, single-process. Handy for tests and dev apps. */
  memory(config: MemoryRetrieverConfig): RetrieverFactory {
    return async () => {
      const { MemoryVectorStore } = await import('../rag/memory-vector-store.js');
      const { EmbeddingRetriever } = await import('../rag/embedding-retriever.js');
      const { ingestDocuments } = await import('../rag/ingest.js');
      const embedder =
        typeof config.embedder === 'function' ? await config.embedder() : config.embedder;
      const store = new MemoryVectorStore();
      if (config.documents !== undefined && config.documents.length > 0) {
        await ingestDocuments(config.documents, {
          embedder,
          store,
          ...(config.chunkSize !== undefined ? { chunkSize: config.chunkSize } : {}),
          ...(config.overlap !== undefined ? { overlap: config.overlap } : {}),
        });
      }
      return new EmbeddingRetriever(embedder, store);
    };
  },

  /**
   * Production pgvector retriever — cosine/L2/inner similarity over a `vector(N)` column via
   * `@adonisjs/lucid` (raw SQL for the pgvector operators; the embedding is a `?::vector` binding). The
   * Lucid peer is imported lazily inside the thunk (unless a structural `db` is passed), so it stays
   * optional. Pass `ensureSchema: true` to provision the extension/table/index at boot for tests.
   */
  pgvector(config: PgVectorRetrieverConfig): RetrieverFactory {
    return async (ctx) => {
      const { PgVectorStore, PgVectorRetriever } = await import('../rag/pg-vector-store.js');
      const { ingestDocuments } = await import('../rag/ingest.js');
      const embedder =
        typeof config.embedder === 'function' ? await config.embedder() : config.embedder;
      const db =
        config.db ??
        (await (async () => {
          const dbService = await resolveLucidDatabase(ctx.app);
          return (config.connection !== undefined
            ? dbService.connection(config.connection)
            : dbService) as unknown as LucidDatabaseLike;
        })());
      const store = new PgVectorStore(db, {
        ...(config.table !== undefined ? { table: config.table } : {}),
        ...(config.dimension !== undefined ? { dimension: config.dimension } : {}),
        ...(config.metric !== undefined ? { metric: config.metric } : {}),
        ...(config.columns !== undefined ? { columns: config.columns } : {}),
      });
      if (config.ensureSchema === true) {
        await store.ensureSchema();
      }
      if (config.documents !== undefined && config.documents.length > 0) {
        await ingestDocuments(config.documents, {
          embedder,
          store,
          ...(config.chunkSize !== undefined ? { chunkSize: config.chunkSize } : {}),
          ...(config.overlap !== undefined ? { overlap: config.overlap } : {}),
        });
      }
      return new PgVectorRetriever(embedder, store);
    };
  },

  /**
   * Production Qdrant retriever — cosine/dot/euclid via `@qdrant/js-client-rest`. The client is
   * imported LAZILY inside the thunk (unless a structural `client` is passed), so the package stays an
   * OPTIONAL peer. Pass `ensureCollection: true` to provision the collection at boot.
   */
  qdrant(config: QdrantRetrieverConfig): RetrieverFactory {
    return async () => {
      const { QdrantStore, QdrantRetriever } = await import('../rag/qdrant-store.js');
      const { ingestDocuments } = await import('../rag/ingest.js');
      const embedder =
        typeof config.embedder === 'function' ? await config.embedder() : config.embedder;
      const client =
        config.client ??
        (await (async () => {
          const mod = await import('@qdrant/js-client-rest');
          return new mod.QdrantClient({
            url: config.url ?? 'http://localhost:6333',
            ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          }) as unknown as QdrantClientLike;
        })());
      const store = new QdrantStore(client, {
        ...(config.collection !== undefined ? { collection: config.collection } : {}),
        ...(config.dimension !== undefined ? { dimension: config.dimension } : {}),
        ...(config.metric !== undefined ? { metric: config.metric } : {}),
      });
      if (config.ensureCollection === true) {
        await store.ensureCollection();
      }
      if (config.documents !== undefined && config.documents.length > 0) {
        await ingestDocuments(config.documents, {
          embedder,
          store,
          ...(config.chunkSize !== undefined ? { chunkSize: config.chunkSize } : {}),
          ...(config.overlap !== undefined ? { overlap: config.overlap } : {}),
        });
      }
      return new QdrantRetriever(embedder, store);
    };
  },
};

// ── Attachment-staging factories ─────────────────────────────────────────────

/** Runtime context an {@link AttachmentStagingFactory} thunk receives — the booted application. */
export type AttachmentStagingContext = StoreContext;

/**
 * A configured attachment-staging store: a lazy thunk the agent provider calls at boot to build the
 * {@link AttachmentStagingStore} the optional `POST /agent/attachments` upload route stages through.
 * Each factory imports its impl inside the thunk (like {@link stores}), so nothing is loaded until a
 * staging store is actually selected.
 */
export type AttachmentStagingFactory = (
  ctx: AttachmentStagingContext,
) => AttachmentStagingStore | Promise<AttachmentStagingStore>;

/**
 * The attachment-staging factory namespace used in `config/agent.ts`, mirroring {@link stores}:
 *
 * ```ts
 * export default defineConfig({
 *   model: () => aiSdkModel({ model: '...' }),
 *   attachmentStaging: attachmentStores.memory(),
 * })
 * ```
 *
 * A real deployment binds its own staging store (presigning against S3/GCS or wrapping the host's
 * media pipeline) by passing an instance; `attachmentStores.memory` covers tests and the offline demo.
 */
export const attachmentStores = {
  /**
   * In-memory staging — encodes the uploaded bytes into a `data:` URL the model provider fetches
   * inline (no external object store, no presigning). Single-process; handy for tests and dev apps.
   */
  memory(): AttachmentStagingFactory {
    return async () => {
      const { InMemoryAttachmentStagingStore } = await import(
        '../testing/in-memory-attachment-staging.js'
      );
      return new InMemoryAttachmentStagingStore();
    };
  },
};

// ── Token-sink / stream-transport factories ──────────────────────────────────

/**
 * A configured {@link TokenStreamSink}: a lazy thunk the agent provider calls at boot to build the live
 * token transport (the "data plane"). Each factory imports its impl — and, for Redis, its optional
 * driver — inside the thunk, so nothing loads until the sink is actually selected. Assignable to the
 * `sink` field's `SinkFactory`.
 */
export type TokenSinkFactory = (ctx: StoreContext) => TokenStreamSink | Promise<TokenStreamSink>;

/** Options for the Redis multi-replica token-stream sink. */
export interface RedisTokenSinkConfig {
  /** `@adonisjs/redis` connection name. Omit for the default connection. */
  connection?: string;
  /** Key/channel namespace. Defaults to `agent:stream`. */
  keyPrefix?: string;
  /**
   * TTL (seconds) for a run's replay keys so they self-expire — the framework never calls the sink's
   * `close()`, so without a TTL the buffer would accumulate in Redis forever. Sliding window refreshed
   * on every write. Defaults to 3600 (1h). Set `0` to disable (retain until manual cleanup).
   */
  ttlSeconds?: number;
  /**
   * Bring-your-own {@link RedisStreamClient} adapter (over `ioredis`, `node-redis`, ...). When set, the
   * `@adonisjs/redis` peer is NOT imported — the factory uses this client directly. Handy for tests and
   * non-Adonis Redis drivers.
   */
  client?: RedisStreamClient;
}

/**
 * The token-sink factory namespace used in `config/agent.ts`, mirroring {@link stores}. Also exported as
 * `streamTransports` (an alias — pick whichever name reads better):
 *
 * ```ts
 * import { defineConfig, tokenSinks } from '@adonis-agora/agent'
 *
 * export default defineConfig({
 *   model: () => aiSdkModel({ model: '...' }),
 *   sink: tokenSinks.redis({ connection: 'main' }), // multi-replica; any pod serves any run's SSE
 * })
 * ```
 *
 * Omitting `sink` entirely keeps the in-process sink (single replica); `tokenSinks.memory()` selects it
 * explicitly. `tokenSinks.redis()` fans a run's tokens across replicas over Redis pub/sub + a replayable
 * list, keeping the SSE envelope byte-identical. The `@adonisjs/redis` peer is imported ONLY inside the
 * `redis` thunk, so it stays fully optional.
 */
export const tokenSinks = {
  /** The in-process sink — per-run in-memory buffers, single replica. The default when `sink` is omitted. */
  memory(): TokenSinkFactory {
    return async () => {
      const { InProcessTokenStreamSink } = await import('../in-process-sink.js');
      return new InProcessTokenStreamSink();
    };
  },

  /**
   * The Redis multi-replica sink: any pod can serve any run's SSE stream. Builds a
   * {@link RedisStreamClient} over `@adonisjs/redis` (imported lazily here), or uses `config.client` when
   * provided. Requires `@adonisjs/redis` installed + configured (`config/redis.ts`) unless a `client` is
   * passed.
   */
  redis(config: RedisTokenSinkConfig = {}): TokenSinkFactory {
    return async (ctx) => {
      const { RedisTokenStreamSink } = await import('../redis-token-stream-sink.js');
      const client = config.client ?? (await buildAdonisRedisClient(ctx.app, config.connection));
      return new RedisTokenStreamSink(client, {
        ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
        ...(config.ttlSeconds !== undefined ? { ttlSeconds: config.ttlSeconds } : {}),
      });
    };
  },
};

/** Alias of {@link tokenSinks}. */
export const streamTransports = tokenSinks;

/** The minimal `ioredis`-shaped surface the `@adonisjs/redis` adapter drives. Duck-typed (peer is optional). */
interface IoRedisLike {
  rpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  duplicate(): IoRedisLike;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

/** The `@adonisjs/redis` manager surface used to reach a connection's underlying `ioredis` client. */
interface RedisManagerLike {
  connection(name?: string): { ioConnection: IoRedisLike };
}

/**
 * Resolve `@adonisjs/redis` from the app container (`app.container.make('redis')`) and adapt its
 * connection to a {@link RedisStreamClient}. Uses the container — NOT `@adonisjs/redis/services/main` —
 * because that service singleton reads its own module-level `app`, which is `undefined` when the sink is
 * built during `AgentProvider.boot` (throws `Cannot read properties of undefined (reading 'booted')`).
 * The `app` handed in here is the live application, so it resolves correctly. The container binding is
 * only reached when the Redis sink is selected, so `@adonisjs/redis` stays a runtime-only peer (cast the
 * container access since the peer's `redis` binding type may be absent at build time). Uses a DEDICATED
 * duplicated connection per subscribe (a subscribed Redis connection can't run other commands).
 */
async function buildAdonisRedisClient(
  app: ApplicationService,
  connection?: string,
): Promise<RedisStreamClient> {
  const container = app.container as unknown as {
    make(binding: string): Promise<RedisManagerLike>;
  };
  const redis = await container.make('redis');
  const conn = connection !== undefined ? redis.connection(connection) : redis.connection();
  return adaptIoRedis(conn.ioConnection);
}

/** Adapt an `ioredis`-shaped client to {@link RedisStreamClient}, using a duplicated subscriber connection. */
function adaptIoRedis(io: IoRedisLike): RedisStreamClient {
  return {
    rpush: async (key, value) => {
      await io.rpush(key, value);
    },
    lrange: (key, start, stop) => io.lrange(key, start, stop),
    set: async (key, value) => {
      await io.set(key, value);
    },
    get: (key) => io.get(key),
    publish: async (channel, message) => {
      await io.publish(channel, message);
    },
    subscribe: async (channel, onMessage) => {
      const subscriber = io.duplicate();
      const listener = (incoming: string, message: string) => {
        if (incoming === channel) {
          onMessage(message);
        }
      };
      subscriber.on('message', listener);
      await subscriber.subscribe(channel);
      return async () => {
        subscriber.off('message', listener);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      };
    },
    del: async (...keys) => {
      await io.del(...keys);
    },
    expire: async (key, seconds) => {
      await io.expire(key, seconds);
    },
  };
}

// ── Actor-directory factories ────────────────────────────────────────────────

/**
 * A configured {@link ActorDirectory}: a lazy thunk the agent provider calls at boot to build the
 * read-side `actorRef → label` lookup governance/dashboard surfaces resolve display names through. Each
 * factory imports its impl inside the thunk (like {@link stores}).
 */
export type ActorDirectoryFactory = (ctx: StoreContext) => ActorDirectory | Promise<ActorDirectory>;

/** Options for the in-memory actor directory. */
export interface MemoryActorDirectoryConfig {
  /** Seed `actorRef → display label` mappings. */
  labels?: Record<string, string>;
}

/**
 * The actor-directory factory namespace used in `config/agent.ts`, mirroring {@link stores}:
 *
 * ```ts
 * export default defineConfig({
 *   actorDirectory: actorDirectories.memory({ labels: { u_1: 'Ada Lovelace' } }),
 * })
 * ```
 *
 * Omit `actorDirectory` → governance surfaces render raw opaque refs. A real deployment binds its own
 * directory over the host's user table by passing an instance; `actorDirectories.memory` covers tests,
 * the offline demo, and small fixed label tables.
 */
export const actorDirectories = {
  /** In-memory `actorRef → label` map — single-process. Handy for tests and dev apps. */
  memory(config: MemoryActorDirectoryConfig = {}): ActorDirectoryFactory {
    return async () => {
      const { InMemoryActorDirectory } = await import('../testing/in-memory-actor-directory.js');
      return new InMemoryActorDirectory(config.labels ?? {});
    };
  },
};
