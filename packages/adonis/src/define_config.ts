import type { ActionApprovalMode } from './action-proposal-receipt.js';
import type { TextActionProposalConfig } from './action-proposal-text.js';
import type { BrandedFunctionalTool } from './ai-tool-ref.js';
import type { AgentDashboardConfig } from './dashboard/define_config.js';
import type { GenuiFactory } from './genui/factory.js';
import type { AgentGovernanceAuthorize } from './governance-gate.js';
import type { McpServerConfig } from './mcp-client/options.js';
import type { MemoryConfig } from './memory.js';
import type { SkillsConfig } from './skills.js';
import type { ActionProposal } from './spi/action-proposal-store.js';
import type { ActorDirectory } from './spi/actor-directory.js';
import type { ActorResolver } from './spi/actor-resolver.js';
import type { ApprovalPolicy, ApprovalRules } from './spi/approval-policy.js';
import type { AttachmentStagingStore } from './spi/attachment-staging.js';
import type { BackgroundActorResolver } from './spi/background-actor-resolver.js';
import type { AgentGovernanceQueries } from './spi/governance-queries.js';
import type { HistoryWindow } from './spi/history-window.js';
import type { ModelCatalog, ModelCatalogView } from './spi/model-catalog.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore } from './spi/pricing-store.js';
import type { InputProcessor, OutputProcessor } from './spi/processors.js';
import type { ProtocolAdapter } from './spi/protocol-adapter.js';
import type { QuotaProvider } from './spi/quota-provider.js';
import type { Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { TokenStreamSink } from './spi/token-stream-sink.js';
import type { PresentationErrorHandler } from './spi/tool.js';
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
  LucidTokenSinkConfig,
  MemoryActorDirectoryConfig,
  MemoryRetrieverConfig,
  MemoryStoreConfig,
  PgVectorRetrieverConfig,
  PricingContext,
  PricingFactory,
  RedisTokenSinkConfig,
  RetrieverContext,
  RetrieverFactory,
  StoreContext,
  StoreFactory,
  TokenSinkFactory,
} from './stores/factory.js';
import {
  actorDirectories,
  attachmentStores,
  governanceQueries,
  pricingStores,
  retrievers,
  stores,
  streamTransports,
  tokenSinks,
} from './stores/factory.js';
import type { QuotaLimits } from './stores/ledger-quota-provider.js';
import type { EmptyRoles } from './tool-registry.js';
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
 * store. The default runner is in-process (`durable: false`); with no actor resolver every browser is
 * its own anonymous actor (the routes are public, and the provider logs a boot warning saying so).
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
  actionApprovalMode?: ActionApprovalMode;
  backgroundActorResolver?: BackgroundActorResolver;
  actionProposalWorker?: {
    pollIntervalMs?: number;
    leaseMs?: number;
    maxConcurrency?: number;
    /**
     * Called once a proposal's execution settles (`proposal.outcome?.executionStatus` says how), on the replica
     * that ran it — the push for a channel that is not the web chat (a WhatsApp bridge, a Slack
     * message) instead of polling. The outcome is still written to the thread as usual. A throw is
     * logged, never retried.
     */
    onSettled?(proposal: ActionProposal): void | Promise<void>;
  };
  /**
   * How a chat message decides an independent proposal (`actionApprovalMode: 'independent'`). A
   * message that is exactly an approve/reject word — optionally the remember phrase, an `#ID`, a
   * trailing `.`/`!` — decides instead of starting a turn. `vocabulary` replaces the word lists
   * (default: Portuguese and English — `sim`/`yes`, `não`/`no`, `sempre nesta conversa`/`always in
   * this conversation`, …); `replies` replaces the answers (default: Portuguese). Each field you
   * omit keeps its default.
   *
   * ```ts
   * actionProposalText: {
   *   replies: { approved: 'Approved — it will run shortly.', rejected: 'Rejected; nothing ran.' },
   * }
   * ```
   */
  actionProposalText?: TextActionProposalConfig;
  /**
   * Called when a tool's `present` fails after its `execute` succeeded — the action stays done and is
   * never retried; only its rendering is lost. `details` names the tool and, inside a turn or a
   * proposal execution, the call, run and thread. Omit → a warning on the app's logger.
   */
  onPresentationError?: PresentationErrorHandler;
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
   * With several replicas and no Redis, `tokenSinks.lucid()` keeps the frames in the app's SQL
   * database instead (polled; see `LucidTokenStreamSink`).
   */
  sink?: TokenStreamSink | SinkFactory;
  /**
   * The caller's budget. `{ limits: { day?: { tokens?, usd? }, month?: { tokens?, usd? } } }` puts
   * ceilings on the built-in ledger provider, and `warnAt` (`0..1`, e.g. `0.8`) a soft limit past
   * which the report carries a `warning`; a `QuotaProvider` of your own replaces it. Either way
   * `GET <path>/quota` reports it and a send whose report comes back `blocked` is refused with `429`
   * before the turn starts. Omit → reported (usage off the ledger), never enforced — for a public
   * (anonymous) deployment that means unbounded model spend, so set limits there; they apply per
   * actor, which is per browser in anonymous mode.
   */
  quota?: { limits: QuotaLimits; warnAt?: number } | QuotaProvider;
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
   * Where chat attachments are stored — the bring-your-own-storage seam. `attachmentStores.media()`
   * keeps them in `@adonis-agora/media` (any Drive disk: S3, GCS, R2, the filesystem);
   * `attachmentStores.memory()` inlines them for tests and demos; or pass your own
   * `AttachmentStagingStore`. When set, `POST <path>/attachments` accepts uploads (the store's
   * `describe()` sets the size cap and content types; default 20 MiB, images/PDF/text/CSV) and a send
   * names them as `attachments: [{ mediaId }]` — the url the model fetches is resolved by the store,
   * never taken from the request. Omit → attachments are off.
   */
  attachments?: AttachmentStagingStore | AttachmentStagingFactory;
  /**
   * Other wire protocols served over the same runs, each mounting its own routes under `path`.
   * `agUiAdapter()` from `@adonis-agora/agent/ag-ui` serves AG-UI 1.0 (`POST <path>/ag-ui`, see
   * `docs/ag-ui.mdx`); a `ProtocolAdapter` of your own works the same way. Omit → only the native
   * routes.
   */
  adapters?: ProtocolAdapter[];
  /**
   * Tool authorization gate. Defaults to `DefaultToolAuthorizer` (role-set intersection over each
   * tool's `roles`, else {@link AgentConfig.defaultRoles}; an empty list follows
   * {@link AgentConfig.emptyRoles}, unrestricted by default). `authorizer` and `rolesPolicy` are
   * aliases — pass either.
   */
  authorizer?: RolesPolicy;
  /** Alias of {@link AgentConfig.authorizer}. */
  rolesPolicy?: RolesPolicy;
  /**
   * Roles a tool requires when it declares none. Default `[]` — no restriction: every tool is
   * callable by whoever `actorResolver` resolved (an anonymous visitor included, when none is
   * configured). `action` tools still park on approval regardless. `['ADMIN']` restores the old
   * fail-closed default.
   */
  defaultRoles?: string[];
  /**
   * What an empty roles list means to the default authorizer: `'allow'` (default) — no restriction;
   * `'deny'` — nobody, so a tool needs `roles` (or a non-empty `defaultRoles`) to be reachable. Only
   * consulted when no `authorizer` is set.
   */
  emptyRoles?: EmptyRoles;
  /**
   * Resolves the acting actor per request (the identity seam). Defaults to `AnonymousActorResolver`:
   * the routes are PUBLIC and every browser is its own anonymous actor (the provider logs a boot
   * warning). Wire `AuthActorResolver` / `HeaderActorResolver` to require login.
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
   * Who has to approve an `action` tool call, and for how long the request stays open. Omit → the
   * person chatting approves, with no expiry (the behaviour before this option).
   *
   * The shorthand covers most deployments — `{ ttlMs: 15 * 60_000 }` expires every request after
   * 15 minutes; `{ tools: { refund: { approver: 'admin' } } }` routes refunds to holders of the
   * `admin` role. Pass a whole `ApprovalPolicy` to decide per actor, thread or agent, or to plug an
   * authz gate into `canDecide`. A non-requester approver is enforced on the approve/reject routes
   * (`403`), and a lapsed request answers `410`.
   */
  approvalPolicy?: ApprovalPolicy | ApprovalRules;
  /**
   * Which models a caller may pick — `GET <path>/models`, a send's `model`, a thread's pinned model
   * (`PATCH <path>/threads/:id { model }`). The picked id reaches the model provider as
   * `ModelTurnArgs.model` (`aiSdkModels` runs the turn on it).
   *
   * A fixed list is a literal — `{ default: 'gpt-4o-mini', providers: [{ id: 'openai', label:
   * 'OpenAI', models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', available: true }] }] }`; pass a
   * `ModelCatalog` (`list({ actor, agent })`) to decide per caller (plan, budget, provider health).
   * Omit → the catalog the model provider carries (`aiSdkModels({ … })`), else an empty one, and a
   * request naming a model is refused with `400`.
   */
  models?: ModelCatalog | ModelCatalogView;
  /**
   * Generative UI: `genui({ catalog, … })` from `@adonis-agora/agent/genui` (no extra peer). Registers
   * tools that let the model push catalog components into the conversation, and binds the catalog in the container as `AgentGenui`.
   */
  genui?: GenuiFactory;
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
  /**
   * Bounds how much of the persisted thread rides the model call each turn, applied once per run.
   * Without it the ENTIRE thread history is sent every turn — fine for short-lived threads, but
   * input tokens (cost + latency, and eventually the model's context limit) grow without bound as a
   * thread accumulates messages. This package ships
   * {@link import('./history-window.js').SlidingWindowHistory}: a message count, a token budget, or
   * both, optionally folding what it left out into a leading summary
   * ({@link import('./history-window.js').summarizeWithModel}). Pass any {@link HistoryWindow} impl
   * for a window it cannot express.
   */
  historyWindow?: HistoryWindow;
  /**
   * Authored procedures the model can pull in mid-turn, scoped by tokens a host resolver orders —
   * see `skills.ts`. The catalog costs one line per skill in the system prompt; a body arrives as a
   * tool result, on the transcript, under {@link AgentConfig.historyWindow}. Omit → no catalog block
   * and no `skill` tool.
   */
  skills?: SkillsConfig;
  /**
   * What the assistant has concluded about an actor and their organisation, carried across turns and
   * across threads — see `memory.ts`. Scoped by the SAME tokens and normally the same
   * {@link SkillsConfig.scopes} resolver, so one deployment has one answer to which scopes an actor
   * has. Omit → no memory block and no `remember` tool; `GET`/`DELETE <path>/memories` are still
   * mounted and answer as though nothing is on file.
   */
  memory?: MemoryConfig;
  /**
   * Rewrite the prompt before EVERY model call of a turn, for every agent — masking identifiers,
   * stamping a policy preamble. Each adds a `process:input:<step>` checkpoint. `createGuardrails`
   * (`@adonis-agora/agent/guardrails`) provides one. Omit → the prompt is sent as composed.
   */
  inputProcessors?: InputProcessor[];
  /**
   * Rule on each step's answer before anything downstream sees it — pass, rewrite or refuse. See
   * `AgentLoopDeps.outputProcessors` for what registering one costs the live stream.
   */
  outputProcessors?: OutputProcessor[];
  /**
   * External MCP servers whose tools this deployment imports into its own `ToolRegistry` — see
   * `src/mcp-client/`. Each is connected inside `app.booted()`, after the app's own tools are
   * discovered, so a remote tool claiming a name the app already owns is refused rather than
   * substituted.
   *
   * An imported tool defaults to `kind: 'action'`, so a remote tool of unknown effect waits for a
   * human before it runs; widening that per server is the host saying out loud that it trusts the
   * server. An unreachable server costs its own tools and not the app, unless it says
   * `required: true`.
   *
   * This is the OTHER direction to `config/mcp.ts`, which exposes THIS deployment's tools to an
   * external MCP client.
   */
  mcpServers?: McpServerConfig[];
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

export type {
  ActorDirectoryFactory,
  AttachmentStagingContext,
  AttachmentStagingFactory,
  EmbeddingFactory,
  GovernanceQueriesContext,
  GovernanceQueriesFactory,
  LucidGovernanceConfig,
  LucidPricingConfig,
  LucidStoreConfig,
  LucidTokenSinkConfig,
  MemoryActorDirectoryConfig,
  MemoryRetrieverConfig,
  MemoryStoreConfig,
  PgVectorRetrieverConfig,
  PricingContext,
  PricingFactory,
  RedisTokenSinkConfig,
  RetrieverContext,
  RetrieverFactory,
  StoreContext,
  StoreFactory,
  TokenSinkFactory,
};
export {
  actorDirectories,
  attachmentStores,
  governanceQueries,
  pricingStores,
  retrievers,
  stores,
  streamTransports,
  tokenSinks,
};
