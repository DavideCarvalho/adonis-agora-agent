import type { BrandedFunctionalTool } from './ai-tool-ref.js';
import type { AgentDashboardConfig } from './dashboard/define_config.js';
import type { AgentGovernanceAuthorize } from './governance-gate.js';
import type { ActorDirectory } from './spi/actor-directory.js';
import type { ActorResolver } from './spi/actor-resolver.js';
import type { AttachmentStagingStore } from './spi/attachment-staging.js';
import type { AgentGovernanceQueries } from './spi/governance-queries.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import {
  actorDirectories,
  attachmentStores,
  governanceQueries,
  pricingStores,
  quotas,
  retrievers,
  stores,
  streamTransports,
  tokenSinks,
} from './stores/factory.js';
import type {
  ActorDirectoryFactory,
  AttachmentStagingContext,
  AttachmentStagingFactory,
  EmbeddingFactory,
  GovernanceQueriesContext,
  GovernanceQueriesFactory,
  LucidGovernanceConfig,
  LucidPricingConfig,
  LucidStoreConfig,
  MemoryActorDirectoryConfig,
  MemoryRetrieverConfig,
  MemoryStoreConfig,
  PgVectorRetrieverConfig,
  PricingContext,
  PricingFactory,
  QuotaConfig,
  QuotaContext,
  QuotaFactory,
  RedisTokenSinkConfig,
  RetrieverContext,
  RetrieverFactory,
  StoreContext,
  StoreFactory,
  TokenSinkFactory,
} from './stores/factory.js';
import type { ToolTransientRetrySetting } from './tool-retry.js';
import type { Actor, AgentDefinition } from './types.js';

/** A lazy factory thunk, so the peer (`ai`/a provider SDK) is imported only when the config loads. */
export type ModelFactory = () => ModelProvider | Promise<ModelProvider>;
/** A lazy {@link TokenStreamSink} factory, receiving the app context (for container access). Omit to use the in-process sink. */
export type SinkFactory = (ctx: StoreContext) => TokenStreamSink | Promise<TokenStreamSink>;

/** The implicit default agent, configured inline — an {@link AgentDefinition} with `name` optional. */
export type DefaultAgentOptions = Omit<AgentDefinition, 'name'> & { name?: string };

/**
 * Shape of `config/agent.ts`. Only `model` is required. Pick a `store` by name from the `stores` map
 * (built with the {@link stores} factory so each peer is imported lazily); omit it for the in-memory
 * store. The default runner is in-process (`durable: false`); the actor resolver defaults to one that
 * THROWS — an identity is never fabricated.
 *
 * ```ts
 * import { defineConfig, stores } from '@adonis-agora/agent'
 * import { aiSdkModel } from '@adonis-agora/agent/ai-sdk'
 *
 * export default defineConfig({
 *   model: () => aiSdkModel({ model: '...' }),
 *   store: 'lucid',
 *   stores: { lucid: stores.lucid(), memory: stores.memory() },
 *   actorResolver: new AuthActorResolver(),
 * })
 * ```
 */
export interface AgentConfig {
  /** The LLM provider, or a lazy factory thunk so the provider SDK peer loads lazily. Required. */
  model: ModelProvider | ModelFactory;
  /** Name of the store (a key of `stores`). Omit for the in-memory store (single-process). */
  store?: string;
  /** Named stores, built with the {@link stores} factory. Provide `lucid` and/or `memory`. */
  stores?: Record<string, StoreFactory>;
  /**
   * Live token transport ("data plane"), or a lazy factory. Defaults to the in-process sink (single
   * replica). Use `tokenSinks.redis({...})` (a.k.a. `streamTransports.redis`) for the multi-replica
   * Redis sink so any pod can serve any run's SSE stream — the SSE envelope is unchanged either way.
   */
  sink?: TokenStreamSink | SinkFactory;
  /**
   * Daily token budget, or a lazy factory. Omit to disable quotas (fail-open on budget). Use
   * `quotas.ledger({ limitTokens })` to enforce off the persisted token-usage ledger, or
   * `quotas.memory({ limitTokens })` for a single-process budget.
   */
  quota?: QuotaStore | QuotaFactory;
  /**
   * Prices each turn's tokens into the assistant message's `usage.costUsd`. A provider-reported cost
   * (a gateway) always wins; otherwise the loop estimates from this store's current price rows (fetched
   * once per run).
   *
   * Defaults to mirroring the main {@link store}: when `store` is a `stores.lucid()` store, pricing is
   * a Lucid store on the SAME connection (table auto-created) with no config needed. Pass a factory /
   * instance to override (e.g. a different connection or `pricingStores.memory()` for tests), or
   * `false` to disable — with no pricing store, `costUsd` is always `null` (never a fabricated `0`).
   * When the main store is not Lucid, pricing is off unless set explicitly.
   */
  pricingStore?: AgentPricingStore | PricingFactory | false;
  /**
   * The governance read-model the `/agent/governance/*` read routes serve from — per-model / per-actor
   * cost & usage rollups, the daily usage trend, and recent tool-call / thread activity over the
   * persisted agent tables.
   *
   * Defaults to mirroring the main {@link store}: when `store` is a `stores.lucid()` store, this is a
   * Lucid read-model on the SAME connection (and the routes are mounted) with no config needed. Pass a
   * factory / instance to override, or `false` to disable — with it off, the `/agent/governance/*`
   * routes are not mounted. When the main store is not Lucid, governance is off unless set explicitly.
   * Read-only.
   */
  governanceQueries?: AgentGovernanceQueries | GovernanceQueriesFactory | false;
  /**
   * Authorization gate for the cross-actor `/agent/governance/*` read routes. It runs after the actor
   * is resolved (the caller is authenticated) and decides whether THIS actor may read the platform-wide
   * governance read-model — every actor's spend, usage, threads, and pending HITL approvals. Return
   * `false` to deny (the route replies `403`).
   *
   * **The routes mount only when this gate exists.** Omit it and `/agent/governance/*` is NOT mounted
   * at all (every route answers `404`), because an ungated cross-actor read-model exposes every
   * actor's spend/usage/threads/approvals to any authenticated caller. Set it — typically an ADMIN
   * check — to mount the routes gated, or set `governanceAuthorize: () => true` to deliberately
   * restore the old behaviour of letting ANY authenticated actor read them. The provider logs a boot
   * warning naming both paths when the read-model resolved but no gate is configured.
   *
   * This does NOT gate the per-actor `GET /agent/approvals/mine` route, which is unaffected: it stays
   * mounted whenever the governance read-model resolves, and is always scoped to the calling actor's
   * OWN pending approvals — so a non-admin surface (e.g. a coordinator's chat) can poll its own
   * approvals even while the cross-actor governance read-model is ADMIN-only.
   *
   * `@adonis-agora/agent-dashboard`'s console reads these routes from the browser, so it mounts only
   * when this gate exists too; its `dashboard.authorize` hook takes the same shape, so the JSON routes
   * and the console SPA can be gated with the same predicate.
   */
  governanceAuthorize?: AgentGovernanceAuthorize;
  /**
   * Enables always-on ("inject") RAG: before each turn the loop retrieves passages for the user message
   * and folds them into the system prompt (replay-safe under durable). Pass a {@link Retriever} directly
   * or a lazy factory — `retrievers.pgvector({ embedder, table, dimension })` for the production pgvector
   * store, or `retrievers.memory({ embedder, documents })` for the in-memory cosine store. Omit → no injection.
   */
  retriever?: Retriever | RetrieverFactory;
  /** How many passages inject-mode retrieval requests per run. Default 5. */
  retrievalTopK?: number;
  /**
   * Derives the metadata filter applied to inject-mode RAG retrieval, from the run's actor.
   * Without it, retrieval is UNSCOPED: every passage in the corpus is eligible for every
   * actor's system prompt. Any deployment sharing one corpus across tenants must set this.
   * The returned object is passed verbatim as `RetrieveOptions.filter` and is interpreted by
   * the store (see the `audience` ACL pattern in docs/retrieval/rag.mdx).
   */
  retrievalFilter?: (actor: Actor) => Record<string, unknown>;
  /**
   * Upload-side seam for message attachments (image/PDF). When set, the provider mounts the optional
   * `POST /agent/attachments` route, which stages an uploaded file through this store and returns a
   * {@link import('./spi/attachment-staging.js').MessageAttachment} the client sends with the next
   * chat message. Pass a store instance, or a lazy `attachmentStores.*()` factory
   * (`attachmentStores.memory()` encodes bytes into a `data:` URL for tests/dev). Omit → no upload
   * route; a client sends already-staged attachment references directly on `chat`.
   */
  attachmentStaging?: AttachmentStagingStore | AttachmentStagingFactory;
  /** Per-file byte cap the upload route enforces. Default 20 MiB. */
  attachmentMaxBytes?: number;
  /**
   * Allowed upload content types, matched EXACTLY (no wildcards, no `text/*` prefix rule). Default:
   * `['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
   * 'text/csv']` — what multimodal providers commonly accept as native image/file parts. Anything
   * else, `text/markdown` included, is rejected with `415`. Passing this REPLACES the default list
   * rather than extending it, so spread the types you still want.
   */
  attachmentAllowedContentTypes?: string[];
  /**
   * Tool authorization gate. Defaults to `DefaultToolAuthorizer` (fail-closed, ADMIN-only; role-set
   * intersection). `authorizer` and `rolesPolicy` are aliases — pass either.
   */
  authorizer?: RolesPolicy;
  /** Alias of {@link AgentConfig.authorizer}. */
  rolesPolicy?: RolesPolicy;
  /** Roles a tool requires when it declares none. Defaults to `['ADMIN']`. */
  defaultRoles?: string[];
  /**
   * Resolves the acting actor per request (the identity seam). Defaults to a resolver that THROWS on
   * every request — the agent never fabricates a caller. Wire `AuthActorResolver` / `HeaderActorResolver`.
   */
  actorResolver?: ActorResolver;
  /**
   * Read-side lookup from opaque persisted `actorRef`s to human display labels for governance/dashboard
   * surfaces (the read-side dual of {@link AgentConfig.actorResolver}). Pass an {@link ActorDirectory}
   * instance, or a lazy `actorDirectories.memory({ labels })` factory. Omit → surfaces render raw refs.
   */
  actorDirectory?: ActorDirectory | ActorDirectoryFactory;
  /** Route prefix the `/agent/*` routes mount under. Defaults to `'agent'`. */
  path?: string;
  /**
   * Run each turn as a replay-safe durable workflow (over `@adonis-agora/durable`) instead of
   * in-process: LLM turns / tool executions become memoized durable steps, HITL approval suspends the
   * run on a signal (resuming across a restart), and sub-agent delegation is a tracked child run. Opt
   * in with `true` — requires `@adonis-agora/durable` installed and configured (`config/durable.ts`).
   * If the durable peer can't be wired, the provider logs a warning and falls back to the in-process
   * (inline) runner, so setting it is always safe.
   */
  durable?: boolean;
  /** Additional named agents (an orchestrator delegates to them via `delegatesTo`). */
  agents?: AgentDefinition[];
  /** The implicit single agent's config (base prompt, personas, tool allow-list). Omit for a bare assistant. */
  defaultAgent?: DefaultAgentOptions;
  /** Static functional tools (`defineTool(...)`) to register at boot, in addition to discovery. */
  tools?: BrandedFunctionalTool[];
  /** Cap on model↔tool iterations per turn. Default 8. */
  maxSteps?: number;
  /**
   * Retries a tool's own invocation, in place, when it throws a classified-transient error (a DB
   * deadlock, a lock-wait timeout, a serialization failure) — a bounded retry inside the tool's
   * durable step, so a replay reuses the memoized result and side effects run once. Default ON
   * (`{ attempts: 2, backoffMs: 150 }` with the default classifier); pass `{ classify }` to
   * widen/narrow which errors count as transient, or `false` to disable. Non-transient failures are
   * never retried — they stay a one-shot business outcome.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /** Emit `agora:agent:*` diagnostics events when `@adonis-agora/diagnostics` is installed. Default true. */
  emitDiagnostics?: boolean;
  /**
   * The bundled governance console (`@adonis-agora/agent/dashboard_provider`). Read at
   * `agent.dashboard`, so it belongs in this same `config/agent.ts` object rather than a file of its
   * own. Defaults to `{ enabled: true }`, mounting the SPA at `<path>/dashboard`.
   *
   * The console is NOT mounted unless {@link AgentConfig.governanceAuthorize} is set — it reads the
   * same cross-actor governance data those routes serve — and it refuses to mount when
   * `governanceQueries: false` explicitly turns the read-model off. Both refusals log a warning
   * naming the responsible knob.
   */
  dashboard?: AgentDashboardConfig;
}

/** Identity helper giving `config/agent.ts` full type-checking. */
export function defineConfig(config: AgentConfig): AgentConfig {
  return config;
}

export {
  stores,
  quotas,
  pricingStores,
  governanceQueries,
  retrievers,
  attachmentStores,
  tokenSinks,
  streamTransports,
  actorDirectories,
};
export type {
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  MemoryStoreConfig,
  QuotaContext,
  QuotaFactory,
  QuotaConfig,
  PricingContext,
  PricingFactory,
  LucidPricingConfig,
  GovernanceQueriesContext,
  GovernanceQueriesFactory,
  LucidGovernanceConfig,
  RetrieverContext,
  RetrieverFactory,
  MemoryRetrieverConfig,
  PgVectorRetrieverConfig,
  EmbeddingFactory,
  AttachmentStagingContext,
  AttachmentStagingFactory,
  TokenSinkFactory,
  RedisTokenSinkConfig,
  ActorDirectoryFactory,
  MemoryActorDirectoryConfig,
};
