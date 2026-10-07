import { pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { personalAgentGate, personalAgentScopes } from '../src/a2a/gate.js';
import { assertIndependentActionRuntime } from '../src/action-proposal-runtime.js';
import {
  ActionProposalService,
  ActionProposalServiceError,
} from '../src/action-proposal-service.js';
import { validateActionProposalListQuery } from '../src/action-proposal-transitions.js';
import {
  DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from '../src/attachment-limits.js';
import { type AgentEngine, assertRunnable, engineOnlyModel } from '../src/engine.js';
import type { Catalog } from '../src/genui/index.js';
import {
  ActionProposalExecutor,
  ActionProposalWorker,
  type Actor,
  type ActorDirectory,
  type ActorResolver,
  type AgentClientConfig,
  type AgentConfig,
  AgentDepsFactory,
  AgentGenui,
  type AgentGovernanceAuthorize,
  type AgentGovernanceQueries,
  type AgentPricingStore,
  AgentRegistry,
  type AgentRunner,
  AgentService,
  AgentSseEncoder,
  type AgentStore,
  ALL_AGENTS,
  AnonymousActorResolver,
  AttachmentInventoryError,
  AttachmentRefusedError,
  type AttachmentStagingStore,
  ChatQueueError,
  ChatQueueService,
  type ChatSendMode,
  type ChatSendResult,
  DefaultToolAuthorizer,
  discoverTools,
  evaluateGovernanceGate,
  evaluateOwnership,
  governanceQueries as governanceQueriesFactories,
  HumanReplyMismatchError,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  isQuotaProvider,
  LedgerQuotaProvider,
  lucidStoreConnection,
  type MemoryConfig,
  type ModelCatalog,
  ModelNotAllowedError,
  type ModelProvider,
  memoryForgetVerdict,
  offerMemories,
  offerSkills,
  type PageContext,
  PersonaNotFoundError,
  parseStreamCursor,
  pricingStores,
  QuotaBlockedError,
  REQUESTER_APPROVER,
  RegenerateNeedsThreadError,
  type Retriever,
  type RolesPolicy,
  RunNotActiveError,
  registerDelegateTools,
  registerFunctionalTool,
  registerToolsFromBarrel,
  resolveActorResolver,
  resolvePersonaAlias,
  type TokenStreamSink,
  ToolRegistry,
  type ToolsBarrel,
  toApprovalPolicy,
  toModelCatalog,
  UnknownAgentError,
  withActorLabel,
  withActorLabels,
} from '../src/index.js';
import { McpToolImporter } from '../src/mcp-client/index.js';
import type { ResolveToolUiCatalog } from '../src/negotiated-tool-ui.js';
import type { ListActionProposals } from '../src/spi/action-proposal-store.js';
import type { PresentationErrorHandler } from '../src/spi/tool.js';
import { setTelescopeGovernanceQueries } from '../src/telescope/governance-registry.js';
import type { UiCapabilities } from '../src/ui-capabilities.js';
import { validateUiCapabilities } from '../src/ui-capabilities.js';

interface ChatBody {
  message: string;
  threadId?: string;
  agent?: string;
  persona?: string;
  pageContext?: PageContext;
  uiCapabilities?: UiCapabilities;
  /** Uploads to attach, by id alone: `[{ mediaId }]` (anything else is refused with `400`). */
  attachments?: unknown;
  /**
   * Run THIS turn on a catalog model (see `GET models`) instead of the thread's pinned one. Never
   * stored on the thread: `PATCH threads/:id { model }` is the only pin.
   */
  model?: string;
  /**
   * `true` → answer the thread's last user message again: requires `threadId`, ignores `message`,
   * stores no user message, drops the answer(s) after it, starts a new run.
   */
  regenerate?: unknown;
  /**
   * What to do when the thread already has a turn running: `'auto'` (default — run now, else queue),
   * `'queue'` (always queue, answering `202`), `'interrupt'` (cancel the running turn, run this next).
   */
  mode?: unknown;
  /** Shorthand for `mode: 'interrupt'`. */
  interrupt?: unknown;
  /** Start a NEW thread transient (left out of `GET threads` until promoted). Ignored with `threadId`. */
  transient?: unknown;
}

/** A send's `mode`, or `null` when it names none of the three. `interrupt: true` is `'interrupt'`. */
function sendMode(body: ChatBody): ChatSendMode | null {
  if (body.mode === undefined) {
    return body.interrupt === true ? 'interrupt' : 'auto';
  }
  return body.mode === 'auto' || body.mode === 'queue' || body.mode === 'interrupt'
    ? body.mode
    : null;
}

/** The catalog a model provider carries (`aiSdkModels(…).catalog`), if it carries one. */
function catalogOf(model: unknown): ModelCatalog | undefined {
  const catalog = (model as { catalog?: unknown } | null)?.catalog;
  return typeof catalog === 'object' &&
    catalog !== null &&
    typeof (catalog as ModelCatalog).list === 'function'
    ? (catalog as ModelCatalog)
    : undefined;
}

/** A decision's `via` is provenance persisted on the call — bounded like any other stored label. */
const MAX_VIA_LENGTH = 64;

/** `remember` from a decision body: `false` when absent, `null` when malformed. */
function decisionRemember(claimed: unknown): boolean | null {
  if (claimed === undefined) return false;
  return typeof claimed === 'boolean' ? claimed : null;
}

/** `via` from a decision body: `'web'` when absent (an HTTP decision), `null` when malformed. */
function decisionVia(claimed: unknown): string | null {
  if (claimed === undefined) return 'web';
  return typeof claimed === 'string' && claimed.length > 0 && claimed.length <= MAX_VIA_LENGTH
    ? claimed
    : null;
}

/** How many attachments one message may name. */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * How many entries `GET <path>/attachments` returns. Fixed rather than caller-supplied: the route
 * exists so a composer can show the files someone uploaded; a host that needs real paging over a
 * large inventory has `AgentService.listAttachments` and its own store's `list`.
 */
const ATTACHMENT_PAGE_SIZE = 50;

/**
 * Reduce a send's `attachments` to `{ mediaId }` refs, or say why not. One shape: a ref names an
 * upload, nothing more — a full attachment (url, name, …) is refused rather than trimmed, so a client
 * that still sends one learns it instead of relying on it; the url is the store's to mint.
 */
function attachmentRefs(claimed: unknown): { mediaId: string }[] | string {
  if (claimed === undefined || claimed === null) return [];
  if (!Array.isArray(claimed)) return 'attachments must be an array of { mediaId }';
  if (claimed.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `a message may carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`;
  }
  const refs: { mediaId: string }[] = [];
  for (const entry of claimed) {
    if (typeof entry !== 'object' || entry === null || !('mediaId' in entry)) {
      return 'each attachment must be an object with a mediaId';
    }
    if (Object.keys(entry).some((key) => key !== 'mediaId')) {
      return 'attachments are { mediaId } refs — send nothing but the id';
    }
    const { mediaId } = entry as { mediaId: unknown };
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      return 'each attachment must carry a non-empty string mediaId';
    }
    refs.push({ mediaId });
  }
  return refs;
}

/**
 * Wires `@adonis-agora/agent` into the AdonisJS application from `config/agent.ts`:
 *
 * - `register()` binds the shared `ToolRegistry` + `AgentRegistry` singletons.
 * - `boot()` discovers tools (the generated `hooks/tools` barrel first, then an `app/agent_tools`
 *   readdir fallback), registers config-level functional tools and synthesizes `agent`-kind delegate
 *   tools for `delegatesTo` edges, builds the runtime graph (store/sink/quota/authorizer/actor-resolver
 *   → deps factory → the inline runner → the `AgentService` facade), and mounts the `/agent` routes
 *   under `config.path` — plus optional routes (`POST /agent/attachments` when `attachments` is
 *   configured; `/agent/approvals/mine` when `governanceQueries` is configured; the cross-actor
 *   `/agent/governance/*` read-model when `governanceQueries` is configured AND a `governanceAuthorize`
 *   gate exists).
 *
 * Every route resolves the acting actor (401 if it can't). Run/thread routes (stream re-attach,
 * cancel, tool-call approve/reject, `threads/:id` read/delete/fork) are additionally owner-scoped:
 * a caller may act only on runs/threads it owns, unless it is governance-privileged (`governanceAuthorize`).
 * The cross-actor `/agent/governance/*` read-model fails closed by omission: without a
 * `governanceAuthorize` gate it is not mounted at all (404). `approvals/mine` is always scoped to the
 * caller's own pending approvals and mounts regardless of the gate.
 *
 * The selected store (`lucid`/`memory`) is built lazily from the config so its peer (`@adonisjs/lucid`)
 * loads only when chosen. Agent lifecycle events are emitted structurally by core onto the
 * `agora:agent:*` diagnostics channel when `@adonis-agora/diagnostics` is installed — no bridge needed.
 */
export default class AgentProvider {
  #store: AgentStore | null = null;
  #actionProposalWorker: ActionProposalWorker | null = null;
  #sink: TokenStreamSink | null = null;
  #actorDirectory: ActorDirectory | null = null;
  #mcpTools: McpToolImporter | null = null;
  /** Whatever was built at boot that may own a schema: the store, the pricing store, the read-model. */
  #schemaOwners: unknown[] = [];
  /** The engine running the turns instead of the loop (`engine` in the config), when there is one. */
  #engine: AgentEngine | undefined;

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(ToolRegistry, () => new ToolRegistry());
    this.app.container.singleton(AgentRegistry, () => {
      const config = this.app.config.get<AgentConfig>('agent', {} as AgentConfig);
      const registry = new AgentRegistry();
      registry.register({
        name: config.defaultAgent?.name ?? 'default',
        ...config.defaultAgent,
      });
      for (const definition of config.agents ?? []) {
        registry.register(definition);
      }
      return registry;
    });
  }

  async boot() {
    const config = this.app.config.get<AgentConfig>('agent', {} as AgentConfig);
    const registry = await this.app.container.make(ToolRegistry);
    const agents = await this.app.container.make(AgentRegistry);
    const defaultRoles = config.defaultRoles ?? [];

    // ── Tool discovery: generated barrel first, else the app/agent_tools readdir fallback ──
    // Deferred to `app.booted()` because discovery IMPORTS each tool file, running its top-level
    // side effects. A tool that imports an Adonis service singleton at module top (e.g.
    // `@adonisjs/lucid/services/db`) evaluates it right here — and during `boot()` that singleton's
    // own `app` can still be uninitialized (notably in a pruned production build, surfacing as
    // `Cannot read properties of undefined (reading 'booted')`), so the import throws. The per-file
    // guard in `discoverTools` now turns that into a skipped tool rather than zero tools, but the
    // tool is still MISSING. Importing after the app is booted lets those top-level service
    // singletons resolve, so tools may use ordinary top-level imports. Safe to populate here: the
    // registry is a container singleton captured by the deps factory (built below) and read
    // per-request, and `booted` callbacks run before the HTTP server accepts traffic.
    const barrel = await this.#loadGeneratedToolsBarrel();
    this.app.booted(async () => {
      if (barrel) {
        await registerToolsFromBarrel(registry, barrel, defaultRoles, this.app);
      } else {
        await discoverTools(registry, this.app.makePath('app/agent_tools'), defaultRoles, this.app);
      }
      // AFTER the app's own tools: the registry is keyed by name and nothing else, so importing
      // first would let a remote server's `search` silently take the name the app's own `search`
      // holds — a substitution invisible from everywhere else. Ordered here, the collision is
      // detected and the remote tool is skipped with a warning naming both claimants.
      await this.#importMcpTools(config, registry);
    });
    // Config-level functional tools (defineTool), then synthesized delegate tools.
    for (const tool of config.tools ?? []) {
      registerFunctionalTool(registry, tool, defaultRoles);
    }
    registerDelegateTools(registry, agents);
    // Generative UI: the catalog's tools, registered like config-level functional tools, and the
    // boot-time catalog bound for injection.
    let resolveUiCatalog: ResolveToolUiCatalog | undefined;
    if (config.genui !== undefined) {
      const setup = await config.genui({
        make: (klass) => this.app.container.make(klass as never),
      });
      resolveUiCatalog = async (scope) => {
        const serverScope = {
          ...scope,
          ...(scope.actor.tenantRef !== undefined ? { tenant: scope.actor.tenantRef } : {}),
        };
        return (await (setup.resolveCatalog?.(serverScope) ?? setup.catalog)) as Catalog;
      };
      for (const tool of setup.tools) {
        registerFunctionalTool(registry, tool, defaultRoles);
      }
      this.app.container.bindValue(AgentGenui, new AgentGenui(setup.catalog, setup.resolveCatalog));
    }

    // ── Runtime graph ──
    // An engine (`engine` in the config) runs the turns instead of the loop: `model` is optional
    // then, and `durable: true` (the LOOP's durable runner) is refused unless the engine is durable.
    const engine = typeof config.engine === 'function' ? await config.engine() : config.engine;
    assertRunnable({ model: config.model, engine, durable: config.durable });
    this.#engine = engine;
    const model =
      config.model === undefined && engine !== undefined
        ? engineOnlyModel(engine)
        : await this.#resolveModel(config);
    const store = await this.#resolveStore(config);
    const sink = await this.#resolveSink(config);
    // One budget: `{ limits }` over the usage ledger, or a `QuotaProvider` of your own — reported by
    // `GET <path>/quota` and gating a send (`429`). Omitted → reported off the ledger, never gated.
    const quotaProvider =
      config.quota === undefined
        ? undefined
        : isQuotaProvider(config.quota)
          ? config.quota
          : new LedgerQuotaProvider(
              store,
              undefined,
              config.quota.limits,
              config.quota.warnAt !== undefined ? { warnAt: config.quota.warnAt } : {},
            );
    const pricingStore = await this.#resolvePricing(config);
    // Governance read-model is resolved after pricing so the Lucid read-model prices its rollups
    // against the same live prices the loop's cost fold uses.
    const governance = await this.#resolveGovernance(config, pricingStore);
    // Push it into the telescope extension's internal registry so its governance-backed data
    // providers can read the SAME authoritative read-model the `/agent/governance/*` routes use —
    // see `src/telescope/governance-registry.ts` for why this isn't a container binding. A no-op
    // import when the host never wires `agentTelescopeExtension()` into `config/telescope.ts`.
    setTelescopeGovernanceQueries(governance);
    const retriever = await this.#resolveRetriever(config);
    const attachmentStaging = await this.#resolveAttachmentStaging(config, store);
    const authorizer = this.#resolveAuthorizer(config, defaultRoles);
    // No resolver → the routes are PUBLIC and each browser is its own anonymous actor (an HttpOnly
    // cookie). Said at boot, with the one line that switches to authenticated mode.
    if (config.actorResolver === undefined) {
      console.warn(
        `[@adonis-agora/agent] No actorResolver configured: the /${(config.path ?? 'agent').replace(/^\/+|\/+$/g, '')}/* endpoints are PUBLIC and every browser is its own anonymous actor. ` +
          'To require login, set `actorResolver: new AuthActorResolver()` in config/agent.ts.',
      );
    }
    const actorResolver = config.actorResolver ?? new AnonymousActorResolver();
    // Read-side identity lookup for governance/dashboard surfaces (optional; renders raw refs if unset).
    const actorDirectory = await this.#resolveActorDirectory(config);
    this.#store = store;
    this.#sink = sink;
    this.#actorDirectory = actorDirectory;
    this.#schemaOwners = [store, pricingStore, governance, sink];
    const onPresentationError = config.onPresentationError ?? (await this.#logPresentationErrors());

    const factory = new AgentDepsFactory({
      ...(onPresentationError !== undefined ? { onPresentationError } : {}),
      model,
      store,
      sink,
      rolesPolicy: authorizer,
      registry,
      agents,
      ...(resolveUiCatalog !== undefined ? { resolveUiCatalog } : {}),
      ...(config.actionApprovalMode !== undefined
        ? { actionApprovalMode: config.actionApprovalMode }
        : {}),
      defaultAgentName: config.defaultAgent?.name ?? 'default',
      ...(config.approvalPolicy !== undefined
        ? { approvalPolicy: toApprovalPolicy(config.approvalPolicy) }
        : {}),
      ...(pricingStore !== undefined ? { pricingStore } : {}),
      ...(retriever !== undefined ? { retriever } : {}),
      ...(config.retrievalTopK !== undefined ? { retrievalTopK: config.retrievalTopK } : {}),
      ...(config.retrievalFilter !== undefined ? { retrievalFilter: config.retrievalFilter } : {}),
      ...(config.toolTransientRetry !== undefined
        ? { toolTransientRetry: config.toolTransientRetry }
        : {}),
      ...(config.historyWindow !== undefined ? { historyWindow: config.historyWindow } : {}),
      // Personal agents (A2A) resolve no memory or skill scope — see `personalAgentScopes`.
      ...(config.skills !== undefined
        ? { skills: { ...config.skills, scopes: personalAgentScopes(config.skills.scopes) } }
        : {}),
      ...(config.memory !== undefined
        ? { memory: { ...config.memory, scopes: personalAgentScopes(config.memory.scopes) } }
        : {}),
      ...(config.inputProcessors !== undefined ? { inputProcessors: config.inputProcessors } : {}),
      ...(config.outputProcessors !== undefined
        ? { outputProcessors: config.outputProcessors }
        : {}),
    });
    // `durable: true` runs each turn as a replay-safe `@adonis-agora/durable` workflow; it degrades
    // gracefully to the in-process runner when the durable peer isn't installed/configured.
    // The thread message queue: a send on a thread whose turn is still running waits here and
    // starts when that turn settles. One instance, shared by the service (which queues) and the
    // runner (which drains); inert on a store that is not a `ChatQueueStore`.
    const queue = new ChatQueueService(store, sink, {
      ...(quotaProvider !== undefined ? { quota: quotaProvider } : {}),
      ...(attachmentStaging !== undefined ? { attachments: attachmentStaging } : {}),
      resolveTarget: (message) => service.queuedTarget(message),
    });
    assertIndependentActionRuntime(
      config.actionApprovalMode,
      store,
      config.backgroundActorResolver,
      queue.supported,
    );
    if (config.actionApprovalMode === 'independent') {
      const executionStore = store;
      const executor = new ActionProposalExecutor({
        resolver: config.backgroundActorResolver!,
        resolveExecution: async (proposal) => {
          const name = proposal.executionContext?.agentName ?? factory.defaultAgentName();
          if (!factory.isAgent(name))
            throw new Error(`Action proposal agent no longer exists: ${name}`);
          const deps = factory.forAgent(name);
          const personaId = proposal.executionContext?.persona;
          if (personaId !== undefined && !deps.personas.has(personaId))
            throw new Error(`Action proposal persona no longer exists: ${personaId}`);
          const persona = personaId === undefined ? undefined : deps.personas.get(personaId);
          const allowedTools =
            persona?.allowedTools === undefined
              ? deps.toolAllowList
              : deps.toolAllowList === undefined
                ? persona.allowedTools
                : deps.toolAllowList.filter((tool) => persona.allowedTools!.includes(tool));
          return {
            registry: deps.registry,
            rolesPolicy: deps.rolesPolicy,
            ...(onPresentationError !== undefined ? { onPresentationError } : {}),
            ...(resolveUiCatalog !== undefined ? { resolveUiCatalog } : {}),
            ...(persona !== undefined ? { persona } : {}),
            ...(allowedTools !== undefined ? { allowedTools } : {}),
          };
        },
      });
      this.#actionProposalWorker = new ActionProposalWorker({
        store: executionStore,
        executor,
        workerId: `agora-${crypto.randomUUID()}`,
        ...config.actionProposalWorker,
        onError: (error) =>
          console.error('[@adonis-agora/agent] Action proposal worker failed', error),
      });
    }
    if (this.#actionProposalWorker)
      this.app.container.bindValue(ActionProposalWorker, this.#actionProposalWorker);
    const runner: AgentRunner =
      engine !== undefined
        ? await engine.createRunner({
            factory,
            store,
            sink,
            registry,
            queue,
            make: (binding) => this.app.container.make(binding as never),
            ...this.#appKey(),
          })
        : config.durable === true
          ? ((await this.#resolveDurableRunner(factory, store, queue, sink)) ??
            new InlineAgentRunner(factory, store, queue))
          : new InlineAgentRunner(factory, store, queue);
    const service: AgentService = new AgentService(runner, store, factory, {
      queue,
      ...(config.backgroundActorResolver !== undefined
        ? { backgroundActorResolver: config.backgroundActorResolver }
        : {}),
      ...(config.actionApprovalMode === 'independent'
        ? {
            actionProposals: new ActionProposalService(
              store,
              factory.forAgent().approvalPolicy,
              config.actionProposalText,
            ),
          }
        : {}),
      // No `models` → the catalog the model provider carries (`aiSdkModels`), else none.
      ...(config.models !== undefined
        ? { models: toModelCatalog(config.models) }
        : catalogOf(model) !== undefined
          ? { models: catalogOf(model) as ModelCatalog }
          : {}),
      ...(attachmentStaging !== undefined ? { attachments: attachmentStaging } : {}),
      quota:
        quotaProvider !== undefined
          ? { provider: quotaProvider, gated: true }
          : { provider: new LedgerQuotaProvider(store), gated: false },
    });
    this.app.container.bindValue(AgentService, service);

    await this.#registerRoutes(
      config,
      service,
      actorResolver,
      agents,
      attachmentStaging,
      governance,
      config.governanceAuthorize,
      pricingStore,
      actorDirectory,
    );
  }

  /**
   * Provision (or repair) the agent tables once, as the app starts — before the HTTP server takes a
   * request and before a test runner opens its first transaction. Left to first use, the DDL ran
   * inside whatever the first caller had open: a Japa suite's global transaction held the locks the
   * DDL needed and the run hung.
   *
   * Every store that manages its own schema exposes `ensureSchema()` (the three Lucid stores and the
   * Lucid token sink do, and it is a no-op under `autoCreateTables: false`); a custom store may too. Skipped for ace commands
   * (`console`): `migration:run` must not find the tables already made by the app it is booting, and
   * `list:routes` must not need a database. A command that does use the agent (a durable worker)
   * falls back to first use, which is the same idempotent call.
   *
   * A failure here is reported, not fatal: the app may be starting ahead of its database, and the
   * first use retries — and surfaces the error to the caller if it is still there.
   */
  async start() {
    const owners = this.#schemaOwners;
    this.#schemaOwners = [];
    if (this.app.getEnvironment() === 'console') return;
    for (const owner of owners) {
      const ensureSchema = (owner as { ensureSchema?: unknown } | null | undefined)?.ensureSchema;
      if (typeof ensureSchema !== 'function') continue;
      try {
        await ensureSchema.call(owner);
      } catch (error) {
        console.warn(
          '[@adonis-agora/agent] Could not provision the agent tables at startup; it will be retried on first use.',
          error,
        );
      }
    }
    this.#actionProposalWorker?.start();
  }

  async shutdown() {
    await this.#engine?.shutdown?.();
    this.#engine = undefined;
    await this.#actionProposalWorker?.stop();
    this.#actionProposalWorker = null;
    // The Lucid store shares the app's `db` (it owns no connection to close); the in-process sink
    // holds only per-run buffers that GC with the provider. Drop refs so a hot reload starts clean.
    // An MCP client DOES own a connection — a spawned stdio child or an HTTP session — so it closes.
    await this.#mcpTools?.close();
    this.#mcpTools = null;
    this.#store = null;
    this.#sink = null;
    this.#actorDirectory = null;
    this.#schemaOwners = [];
  }

  /**
   * Import each configured MCP server's tools into the shared registry.
   *
   * A failure here is the importer's own to report: a server that cannot be reached costs its own
   * tools and leaves the app booting, unless it declared `required: true` — in which case the throw
   * propagates and boot fails, which is what that flag asks for.
   */
  async #importMcpTools(config: AgentConfig, registry: ToolRegistry): Promise<void> {
    const servers = config.mcpServers ?? [];
    if (servers.length === 0) {
      return;
    }
    const importer = new McpToolImporter(servers, registry, {
      warn: (message) => console.warn(`[@adonis-agora/agent] ${message}`),
    });
    this.#mcpTools = importer;
    await importer.start();
  }

  // ── resolution helpers ────────────────────────────────────────────────────

  /** The app's `APP_KEY` (a `Secret` in `config/app.ts`), for an engine that signs something. */
  #appKey(): { appKey?: string } {
    const raw = this.app.config.get<unknown>('app.appKey', undefined);
    const released =
      typeof (raw as { release?: unknown } | undefined)?.release === 'function'
        ? (raw as { release(): unknown }).release()
        : raw;
    return typeof released === 'string' && released.length > 0 ? { appKey: released } : {};
  }

  async #resolveModel(config: AgentConfig): Promise<ModelProvider> {
    const model = config.model as AgentConfig['model'] & {};
    if (typeof model === 'function') {
      return model();
    }
    return model;
  }

  async #resolveStore(config: AgentConfig): Promise<AgentStore> {
    const name = config.store;
    if (name && config.stores?.[name]) {
      return config.stores[name]({ app: this.app });
    }
    const { InMemoryAgentStore } = await import('../src/testing/in-memory-store.js');
    return new InMemoryAgentStore();
  }

  async #resolveSink(config: AgentConfig): Promise<TokenStreamSink> {
    const sink = config.sink;
    if (sink === undefined) return new InProcessTokenStreamSink();
    return typeof sink === 'function' ? sink({ app: this.app }) : sink;
  }

  /**
   * Build the read-side actor directory from config (an `ActorDirectoryFactory` thunk or a ready
   * instance). `undefined` → governance/dashboard surfaces render raw opaque `actorRef`s.
   */
  async #resolveActorDirectory(config: AgentConfig): Promise<ActorDirectory | null> {
    const directory = config.actorDirectory;
    if (directory === undefined) return null;
    return typeof directory === 'function' ? directory({ app: this.app }) : directory;
  }

  /**
   * The Lucid connection of the main store when it is a `stores.lucid()` store (`null` = the app's
   * default connection), or `undefined` when the main store isn't Lucid. Used to default the pricing
   * store and governance read-model to the same connection the agent already persists on.
   */
  #mainStoreLucidConnection(config: AgentConfig): string | null | undefined {
    const name = config.store;
    const factory = name ? config.stores?.[name] : undefined;
    return lucidStoreConnection(factory);
  }

  /**
   * Build the pricing store. `false` disables it (cost stays `null`). Omitted → mirror the main store:
   * a Lucid pricing store on the same connection when the main store is Lucid, otherwise off.
   */
  async #resolvePricing(config: AgentConfig): Promise<AgentPricingStore | undefined> {
    const pricingStore = config.pricingStore;
    if (pricingStore === false) return undefined;
    if (pricingStore === undefined) {
      const connection = this.#mainStoreLucidConnection(config);
      if (connection === undefined) return undefined;
      return pricingStores.lucid(connection === null ? {} : { connection })({ app: this.app });
    }
    return typeof pricingStore === 'function' ? pricingStore({ app: this.app }) : pricingStore;
  }

  /**
   * Build the governance read-model. `false` disables it (the `/agent/governance/*` routes aren't
   * mounted). Omitted → mirror the main store: a Lucid read-model on the same connection when the main
   * store is Lucid, otherwise off. The factory receives the already-resolved `pricingStore` so the
   * Lucid read-model prices its rollups against the loop's live prices.
   */
  async #resolveGovernance(
    config: AgentConfig,
    pricingStore: AgentPricingStore | undefined,
  ): Promise<AgentGovernanceQueries | undefined> {
    const governance = config.governanceQueries;
    if (governance === false) return undefined;
    const ctx = { app: this.app, ...(pricingStore !== undefined ? { pricingStore } : {}) };
    if (governance === undefined) {
      const connection = this.#mainStoreLucidConnection(config);
      if (connection === undefined) return undefined;
      return governanceQueriesFactories.lucid(connection === null ? {} : { connection })(ctx);
    }
    return typeof governance === 'function' ? governance(ctx) : governance;
  }

  /** Build the inject-mode retriever from config (a `RetrieverFactory` thunk or a ready instance). */
  async #resolveRetriever(config: AgentConfig): Promise<Retriever | undefined> {
    const retriever = config.retriever;
    if (retriever === undefined) return undefined;
    return typeof retriever === 'function' ? retriever({ app: this.app }) : retriever;
  }

  /**
   * Build the attachment-staging store from config (an `AttachmentStagingFactory` thunk or a ready
   * instance). `undefined` → no upload route is mounted (a client sends already-staged references).
   */
  async #resolveAttachmentStaging(
    config: AgentConfig,
    agentStore: AgentStore,
  ): Promise<AttachmentStagingStore | undefined> {
    const staging = config.attachments;
    if (staging === undefined) return undefined;
    return typeof staging === 'function' ? staging({ app: this.app, agentStore }) : staging;
  }

  #resolveAuthorizer(config: AgentConfig, defaultRoles: string[]): RolesPolicy {
    // Whatever the app configured, personal agents (A2A) reach only tools that name them — see
    // `personalAgentGate`. A no-op for every other actor.
    return personalAgentGate(
      config.authorizer ??
        config.rolesPolicy ??
        new DefaultToolAuthorizer(defaultRoles, { emptyRoles: config.emptyRoles ?? 'allow' }),
    );
  }

  /**
   * Build the durable runner when `durable: true`, or `null` to fall back to inline. The optional
   * `@adonis-agora/durable` peer is imported lazily (so the agent package never hard-depends on it),
   * its {@link WorkflowEngine} resolved from the container (bound by the durable provider), the agent
   * workflow registered on it, and the module-level durable context wired. A missing peer, an
   * unresolvable engine, or any wiring error logs a warning and degrades to the in-process runner
   * rather than breaking boot.
   */
  async #resolveDurableRunner(
    factory: AgentDepsFactory,
    store: AgentStore,
    queue: ChatQueueService,
    sink: TokenStreamSink,
  ): Promise<AgentRunner | null> {
    try {
      const durable = await import('@adonis-agora/durable');
      const engine = await this.app.container.make(durable.WorkflowEngine);
      const { DurableAgentRunner, registerAgentWorkflow, setDurableAgentContext } = await import(
        '../src/durable/index.js'
      );
      setDurableAgentContext({ factory, store, queue, engine });
      registerAgentWorkflow(engine);
      return new DurableAgentRunner(engine, store, queue, sink);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[@adonis-agora/agent] \`durable: true\` was requested but the durable runner could not be wired (${message}) — is \`@adonis-agora/durable\` installed and configured? Falling back to the in-process (inline) runner.`,
      );
      return null;
    }
  }

  /** Best-effort import of the build-time tools barrel; `null` when absent (fall back to the scan). */
  async #loadGeneratedToolsBarrel(): Promise<ToolsBarrel | null> {
    const path = this.app.makePath('.adonisjs/agent/tools.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as { tools?: ToolsBarrel };
      return mod.tools ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  // ── routes ────────────────────────────────────────────────────────────────

  async #registerRoutes(
    config: AgentConfig,
    service: AgentService,
    actorResolver: ActorResolver,
    agents: AgentRegistry,
    attachmentStaging: AttachmentStagingStore | undefined,
    governance: AgentGovernanceQueries | undefined,
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
    pricingStore: AgentPricingStore | undefined,
    /** Read-side ref→label lookup; `null` when unbound, in which case rows keep their raw refs. */
    actorDirectory: ActorDirectory | null,
  ): Promise<void> {
    const router = await this.app.container.make('router');
    const path = (config.path ?? 'agent').replace(/^\/+|\/+$/g, '');
    const p = (suffix: string) => `${path}/${suffix}`;
    // One source of attachment limits: what the store declares, else the defaults.
    const declared = attachmentStaging?.describe?.() ?? {};
    const attachmentLimits = {
      maxBytes: declared.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
      allowedContentTypes: declared.allowedContentTypes ?? DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
    };
    const defaultAgentName = config.defaultAgent?.name ?? 'default';

    // 1. POST /agent/chat — resolve actor, start the run, SSE-pipe the token stream. When the caller
    // continues an EXISTING thread (`body.threadId`), it must own it: otherwise an authenticated caller
    // could pass another actor's threadId to load that thread's full history into the model (read it
    // back over SSE) and append its own turn into the victim's thread. A new-thread chat (no threadId)
    // has no owner to check. Owner-scoped exactly like the `threads/:id` routes.
    router.post(p('chat'), async (ctx: HttpContext) => {
      // Read the body first so the target agent is known: an agent with its own `actorResolver`
      // (e.g. one that reads the caller from the body) resolves the actor with it, else the global.
      const body = (ctx.request.body() ?? {}) as ChatBody;
      // A name a persona took over (`Persona.aliases`) is answered by the agent that owns it.
      const named = body.agent ?? defaultAgentName;
      const agentName =
        agents.get(named) !== undefined
          ? named
          : (resolvePersonaAlias(agents.list(), named)?.agent ?? named);
      const resolver = resolveActorResolver(actorResolver, agents.get(agentName));
      const actor = await this.#resolveActor(ctx, resolver);
      if (actor === null) return;
      if (body.threadId !== undefined) {
        const owner = await service.threadOwner(body.threadId);
        if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      }
      const regenerate = body.regenerate === true;
      if (regenerate && body.threadId === undefined) {
        return ctx.response.badRequest({
          message: 'regenerate requires an existing threadId',
          code: 'thread_required',
        });
      }
      const refs = attachmentRefs(body.attachments);
      if (typeof refs === 'string') {
        return ctx.response.badRequest({ message: refs });
      }
      const mode = sendMode(body);
      if (mode === null) {
        return ctx.response.badRequest({ message: "mode must be 'auto', 'queue' or 'interrupt'" });
      }
      let uiCapabilities: UiCapabilities | undefined;
      try {
        if (body.uiCapabilities !== undefined)
          uiCapabilities = validateUiCapabilities(body.uiCapabilities);
      } catch {
        return ctx.response.badRequest({
          message: 'uiCapabilities must be valid UI capabilities',
          code: 'invalid_ui_capabilities',
        });
      }
      let started: ChatSendResult;
      try {
        started = await service.send({
          actor,
          mode,
          // A regenerate answers the stored user message; whatever `message` says is ignored.
          message: regenerate ? '' : body.message,
          ...(regenerate ? { regenerate: true } : {}),
          ...(body.transient === true ? { transient: true } : {}),
          ...(typeof body.model === 'string' && body.model.length > 0 ? { model: body.model } : {}),
          ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
          ...(body.agent !== undefined ? { agentName: body.agent } : {}),
          ...(typeof body.persona === 'string' && body.persona.length > 0
            ? { personaId: body.persona }
            : {}),
          ...(body.pageContext !== undefined ? { pageContext: body.pageContext } : {}),
          ...(uiCapabilities !== undefined ? { uiCapabilities } : {}),
          ...(refs.length > 0 ? { attachments: refs } : {}),
        });
      } catch (error) {
        if (error instanceof ActionProposalServiceError)
          return ctx.response.status(error.status).json({ message: error.message });
        if (error instanceof AttachmentRefusedError) {
          return ctx.response.status(error.status).json({ message: error.message });
        }
        if (error instanceof ModelNotAllowedError) {
          return ctx.response.badRequest({ message: error.message, code: 'model_not_allowed' });
        }
        if (error instanceof PersonaNotFoundError) {
          return ctx.response.badRequest({ message: error.message, code: error.code });
        }
        if (error instanceof RegenerateNeedsThreadError) {
          return ctx.response.badRequest({ message: error.message, code: 'thread_required' });
        }
        if (error instanceof ChatQueueError) {
          return this.#refuseQueue(ctx, error);
        }
        if (error instanceof QuotaBlockedError) {
          return ctx.response.status(429).json({
            code: 'quota_exceeded',
            period: error.period,
            message: error.message,
          });
        }
        throw error;
      }
      if ('proposalDecision' in started) return ctx.response.json(started);
      if (started.queued === true) {
        // The thread already has a turn running: the message waits in its queue (`202`, JSON — no
        // stream). `runId` is there when it started straight away; attach to it with `GET …/stream`.
        return ctx.response.status(202).json(started);
      }
      await this.#pipe(ctx, service, started.runId, started.threadId);
    });

    // 2. GET /agent/chat/:runId/stream — re-attach SSE. Authenticated: the actor resolver reads the
    // request's session/cookies (an EventSource can't set headers), 401 on failure — so an anonymous
    // caller can never re-attach to a run's live token stream.
    router.get(p('chat/:runId/stream'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const runId = String(ctx.params.runId);
      const owner = await service.runOwner(runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      // Nothing buffered under the run — it ended while the client was away, or its buffer went with
      // a restarted process. A 404 reads as "nothing to resume"; subscribing would wait forever.
      if (!(await service.hasStream(runId))) {
        return ctx.response.notFound({ message: 'Nothing is streaming under that run.' });
      }
      // `?after=<seq>` (or the `Last-Event-ID` a browser EventSource sends on its own) skips the
      // events a reconnecting client already has; `after` wins when both are present.
      const after =
        parseStreamCursor(ctx.request.qs().after) ??
        parseStreamCursor(ctx.request.header('last-event-id')) ??
        0;
      await this.#pipe(ctx, service, runId, undefined, after);
    });

    // 3. POST /agent/chat/:runId/cancel — authenticated + owner-scoped (a caller cancels only its own
    // runs, unless governance-privileged).
    router.post(p('chat/:runId/cancel'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const runId = String(ctx.params.runId);
      const owner = await service.runOwner(runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      await service.cancel(runId);
      return ctx.response.json({ aborted: true });
    });

    // 3b. Protocol adapters (`adapters` in the config): other wire protocols over the same runs —
    // e.g. `agUiAdapter()` mounts `POST <path>/ag-ui`. Each gets the checks these routes use, so an
    // adapter cannot be more permissive than the native routes by forgetting one.
    // An engine's own routes (the MCP endpoint OpenCode reaches the app's tools through) mount the
    // same way, after the configured adapters.
    for (const adapter of [...(config.adapters ?? []), ...(this.#engine?.adapters?.() ?? [])]) {
      await adapter.mount({
        service,
        defaultAgentName,
        post: (suffix, handler) => void router.post(p(suffix), handler),
        get: (suffix, handler) => void router.get(p(suffix), handler),
        resolveActor: (ctx, agentName) =>
          this.#resolveActor(
            ctx,
            agentName === undefined
              ? actorResolver
              : resolveActorResolver(actorResolver, agents.get(agentName)),
          ),
        assertOwner: (ctx, actor, ownerRef, kind) =>
          this.#assertOwner(ctx, actor, ownerRef, kind, governanceAuthorize),
        mayDecide: (ctx, actor, runId, toolCallId) =>
          this.#mayDecide(ctx, service, actor, runId, toolCallId, governanceAuthorize),
        refuseSend: (ctx, error) => this.#refuseSend(ctx, error),
        conflictOnMismatch: (ctx, error) => this.#conflictOnMismatch(ctx, error),
        ...(attachmentStaging !== undefined
          ? {
              attachments: {
                store: attachmentStaging,
                maxBytes: attachmentLimits.maxBytes,
                allowedContentTypes: attachmentLimits.allowedContentTypes,
                maxPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
              },
            }
          : {}),
      });
    }

    // 4. POST /agent/tool-call/approve — authenticated + owner-scoped. Delivering a HITL decision is a
    // privileged control: only the actor that OWNS the run (or a governance-privileged actor) may
    // approve its pending tool call — an authenticated non-owner who learns a runId/toolCallId cannot.
    router.post(p('tool-call/approve'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as {
        runId?: string;
        toolCallId: string;
        remember?: unknown;
        via?: unknown;
      };
      const remember = decisionRemember(body.remember);
      const via = decisionVia(body.via);
      if (remember === null || via === null) {
        return ctx.response.badRequest({
          message: `remember must be a boolean and via a string of 1-${MAX_VIA_LENGTH} characters`,
        });
      }
      const runId = await this.#runOfToolCall(ctx, service, body);
      if (runId === null) return;
      if (
        !(await this.#mayDecide(ctx, service, actor, runId, body.toolCallId, governanceAuthorize))
      )
        return;
      try {
        await service.approve(runId, body.toolCallId, { executedByRef: actor.id, remember, via });
      } catch (error) {
        return this.#conflictOnMismatch(ctx, error);
      }
      return ctx.response.json({ ok: true });
    });

    // 5. POST /agent/tool-call/reject — authenticated + owner-scoped (mirrors approve).
    router.post(p('tool-call/reject'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as {
        runId?: string;
        toolCallId: string;
        reason?: string;
        via?: unknown;
      };
      const via = decisionVia(body.via);
      if (via === null) {
        return ctx.response.badRequest({
          message: `via must be a string of 1-${MAX_VIA_LENGTH} characters`,
        });
      }
      const runId = await this.#runOfToolCall(ctx, service, body);
      if (runId === null) return;
      if (
        !(await this.#mayDecide(ctx, service, actor, runId, body.toolCallId, governanceAuthorize))
      )
        return;
      try {
        await service.reject(runId, body.toolCallId, body.reason, { executedByRef: actor.id, via });
      } catch (error) {
        return this.#conflictOnMismatch(ctx, error);
      }
      return ctx.response.json({ ok: true });
    });

    // 5b. POST /agent/tool-call/answer — authenticated + owner-scoped (mirrors approve). Settles a
    // parked question set with the user's answers; an omitted question takes its own pre-picked
    // default, resolved server-side against the request the run already holds.
    router.post(p('tool-call/answer'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as {
        runId?: string;
        toolCallId: string;
        answers?: Record<string, string[]>;
        via?: unknown;
      };
      const via = decisionVia(body.via);
      if (via === null) {
        return ctx.response.badRequest({
          message: `via must be a string of 1-${MAX_VIA_LENGTH} characters`,
        });
      }
      const runId = await this.#runOfToolCall(ctx, service, body);
      if (runId === null) return;
      const owner = await service.runOwner(runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      // A value a question's rules refuse, or a `required` question left empty, is refused HERE so
      // the person who typed it hears why — rather than signalled and quietly dropped by the loop.
      const problem = await service.answerProblem(body.toolCallId, body.answers ?? {});
      if (problem !== null) {
        return ctx.response.badRequest({ message: problem });
      }
      try {
        await service.answer({
          runId,
          toolCallId: body.toolCallId,
          answers: body.answers ?? {},
          answeredByRef: actor.id,
          answeredVia: via,
        });
      } catch (error) {
        return this.#conflictOnMismatch(ctx, error);
      }
      return ctx.response.json({ ok: true });
    });

    // 5c. POST /agent/tool-call/skip — the user declining to answer. Same values as a confirmation,
    // recorded as a different fact.
    router.post(p('tool-call/skip'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as {
        runId?: string;
        toolCallId: string;
        via?: unknown;
      };
      const via = decisionVia(body.via);
      if (via === null) {
        return ctx.response.badRequest({
          message: `via must be a string of 1-${MAX_VIA_LENGTH} characters`,
        });
      }
      const runId = await this.#runOfToolCall(ctx, service, body);
      if (runId === null) return;
      const owner = await service.runOwner(runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      try {
        await service.skip({
          runId,
          toolCallId: body.toolCallId,
          answeredByRef: actor.id,
          answeredVia: via,
        });
      } catch (error) {
        return this.#conflictOnMismatch(ctx, error);
      }
      return ctx.response.json({ ok: true });
    });

    // 6. GET /agent/threads — the actor's threads.
    router.get(p('threads'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(await service.listThreads(actor.id));
    });

    // 6a. POST /agent/messages/:id/feedback — the thread owner rates a message. Only the OWNER: a
    // rating is the owner's opinion of their own conversation, so no governance bypass here.
    router.post(p('messages/:id/feedback'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const messageId = String(ctx.params.id);
      const threadId = await service.threadOfMessage(messageId);
      if (threadId === undefined) {
        return ctx.response.status(501).json({
          message:
            'Message feedback requires an AgentStore that implements threadOfMessage() and setMessageFeedback().',
        });
      }
      if (threadId === null) {
        return ctx.response.notFound({ message: 'message not found' });
      }
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', undefined))) return;
      const body = (ctx.request.body() ?? {}) as { value?: unknown; comment?: unknown };
      const result = await service.setMessageFeedback(messageId, {
        value: body.value ?? null,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      });
      if (!result.ok) {
        return ctx.response.status(result.status).json({ message: result.error });
      }
      return ctx.response.json({ feedback: result.feedback });
    });

    // 6c. GET /agent/models?agent= — the models the caller may pick, grouped by provider, with
    // availability; an empty catalog when none is configured. GET /agent/agents — the registered
    // agents for a picker, the default flagged.
    router.get(p('models'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const agent = ctx.request.qs().agent as string | undefined;
      return ctx.response.json(await service.listModels(actor, agent));
    });
    router.get(p('agents'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(await service.listAgents(actor));
    });

    // 6b. GET /agent/tools?agent= — the tools this caller can reach through an agent, with how a chat
    // surface should talk about each (`presentation`). The same list the model is offered; nothing the
    // caller passes widens it — `agent` only narrows to that agent's allow-list, and an unknown name is
    // a 404 rather than the widest answer (no allow-list at all). `?agent=*` is the union across every
    // agent: each tool this caller reaches through any of them, once, under the same gates.
    router.get(p('tools'), async (ctx: HttpContext) => {
      const agent = ctx.request.qs().agent as string | undefined;
      if (agent === ALL_AGENTS) {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        return ctx.response.json(await service.toolCatalogForAllAgents(actor));
      }
      if (agent !== undefined && agent !== defaultAgentName && agents.get(agent) === undefined) {
        return ctx.response.notFound({ message: `No agent named "${agent}"` });
      }
      const actor = await this.#resolveActor(
        ctx,
        resolveActorResolver(actorResolver, agents.get(agent ?? defaultAgentName)),
      );
      if (actor === null) return;
      return ctx.response.json(await service.toolCatalog(actor, agent));
    });

    // 7. GET /agent/threads/personas/catalog (before :id so it isn't captured by the param).
    // Authenticated — an anonymous caller reads nothing from the agent surface.
    router.get(p('threads/personas/catalog'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(service.personaCatalog());
    });

    const proposalResponse = async (ctx: HttpContext, action: () => Promise<unknown>) => {
      try {
        return ctx.response.json(await action());
      } catch (error) {
        if (error instanceof ActionProposalServiceError)
          return ctx.response.status(error.status).json({ message: error.message });
        throw error;
      }
    };
    router.get(p('threads/:id/action-proposals'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (!actor) return;
      return proposalResponse(ctx, async () => {
        let after: ListActionProposals['after'];
        const cursor = ctx.request.input('after');
        if (cursor !== undefined) {
          try {
            if (typeof cursor !== 'string') throw new Error('cursor');
            after = JSON.parse(cursor) as NonNullable<ListActionProposals['after']>;
            validateActionProposalListQuery({ after });
          } catch {
            throw new ActionProposalServiceError(400, 'Invalid action proposal cursor');
          }
        }
        const page = await service.listActionProposalsPage(actor, ctx.params.id, after);
        if (page.next)
          ctx.response.header(
            'X-Action-Proposals-Next',
            encodeURIComponent(JSON.stringify(page.next)),
          );
        ctx.response.header('Access-Control-Expose-Headers', 'X-Action-Proposals-Next');
        return page.items;
      });
    });
    for (const [route, decision] of [
      ['approve', 'approved'],
      ['reject', 'rejected'],
    ] as const) {
      router.post(
        p(`threads/:id/action-proposals/:proposalId/${route}`),
        async (ctx: HttpContext) => {
          const actor = await this.#resolveActor(ctx, actorResolver);
          if (!actor) return;
          return proposalResponse(ctx, () =>
            service.decideActionProposal(
              actor,
              ctx.params.id,
              ctx.params.proposalId,
              decision,
              ctx.request.body() ?? {},
            ),
          );
        },
      );
    }

    // 8. GET /agent/threads/:id — detail or null. Authenticated + owner-scoped (a caller reads only its
    // own threads, unless governance-privileged).
    router.get(p('threads/:id'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const threadId = String(ctx.params.id);
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      return ctx.response.json(await service.getThread(threadId, actor));
    });

    // 8b. PATCH /agent/threads/:id — rename (`{ title }`), what a thread list's rename calls.
    // Authenticated + owner-scoped. Unknown keys are ignored, so a client that also sends fields this
    // server does not store yet is not refused for it.
    router.patch(p('threads/:id'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const threadId = String(ctx.params.id);
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      const body = (ctx.request.body() ?? {}) as {
        title?: unknown;
        model?: unknown;
        defaultAgent?: unknown;
        persona?: unknown;
      };
      if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
        return ctx.response.badRequest({ message: 'model must be a string or null' });
      }
      if (
        body.defaultAgent !== undefined &&
        body.defaultAgent !== null &&
        typeof body.defaultAgent !== 'string'
      ) {
        return ctx.response.badRequest({ message: 'defaultAgent must be a string or null' });
      }
      if (body.persona !== undefined && body.persona !== null && typeof body.persona !== 'string') {
        return ctx.response.badRequest({ message: 'persona must be a string or null' });
      }
      if (
        body.model !== undefined ||
        body.defaultAgent !== undefined ||
        body.persona !== undefined
      ) {
        try {
          const saved = await service.updateThreadSettings(actor, threadId, {
            ...(body.model !== undefined ? { model: body.model as string | null } : {}),
            ...(body.defaultAgent !== undefined
              ? { defaultAgent: body.defaultAgent as string | null }
              : {}),
            ...(body.persona !== undefined ? { persona: body.persona as string | null } : {}),
          });
          if (!saved) {
            return ctx.response.status(501).json({
              message:
                "Setting a thread's model, default agent or persona requires an AgentStore that implements updateThread().",
            });
          }
        } catch (error) {
          if (error instanceof ModelNotAllowedError || error instanceof UnknownAgentError) {
            return ctx.response.badRequest({ message: error.message });
          }
          if (error instanceof PersonaNotFoundError) {
            return ctx.response.badRequest({ message: error.message, code: error.code });
          }
          throw error;
        }
      }
      if (body.title !== undefined) {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (title.length === 0 || title.length > 200) {
          return ctx.response.badRequest({ message: 'title must be a string of 1-200 characters' });
        }
        await service.renameThread(threadId, title);
      }
      return ctx.response.json({ ok: true });
    });

    // 8d. The thread message queue — messages sent while a turn was running, waiting to run after
    // it. Owner-scoped like the thread routes; each answers the queue (`{ items, paused }`) and
    // publishes it into the stream of the run holding the thread. `501` on a store without a queue.
    router.get(p('threads/:id/queue'), async (ctx: HttpContext) => {
      const threadId = await this.#ownedThread(ctx, service, actorResolver, governanceAuthorize);
      if (threadId === null) return;
      return this.#queueAnswer(ctx, () => service.getQueue(threadId));
    });
    router.delete(p('threads/:id/queue'), async (ctx: HttpContext) => {
      const threadId = await this.#ownedThread(ctx, service, actorResolver, governanceAuthorize);
      if (threadId === null) return;
      return this.#queueAnswer(ctx, () => service.clearQueue(threadId));
    });
    router.post(p('threads/:id/queue/resume'), async (ctx: HttpContext) => {
      const threadId = await this.#ownedThread(ctx, service, actorResolver, governanceAuthorize);
      if (threadId === null) return;
      return this.#queueAnswer(ctx, () => service.resumeQueue(threadId));
    });
    router.patch(p('queue/:messageId'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const messageId = String(ctx.params.messageId);
      if (!(await this.#ownsQueuedMessage(ctx, service, actor, messageId, governanceAuthorize)))
        return;
      const body = (ctx.request.body() ?? {}) as {
        message?: unknown;
        attachments?: unknown;
        position?: unknown;
      };
      if (body.message !== undefined && typeof body.message !== 'string') {
        return ctx.response.badRequest({ message: 'message must be a string' });
      }
      if (body.position !== undefined && typeof body.position !== 'number') {
        return ctx.response.badRequest({ message: 'position must be a non-negative integer' });
      }
      const refs =
        body.attachments === undefined || body.attachments === null
          ? body.attachments
          : attachmentRefs(body.attachments);
      if (typeof refs === 'string') {
        return ctx.response.badRequest({ message: refs });
      }
      return this.#queueAnswer(ctx, () =>
        service.updateQueuedMessage(actor, messageId, {
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
          ...(refs !== undefined ? { attachments: refs } : {}),
          ...(typeof body.position === 'number' ? { position: body.position } : {}),
        }),
      );
    });
    // Run a waiting message now — the "send this one now" button on a queued bubble. Answers the
    // queue plus `interrupting` (the run it cancelled) or `runId` (nothing was running; it started).
    router.post(p('queue/:messageId/interrupt'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const messageId = String(ctx.params.messageId);
      if (!(await this.#ownsQueuedMessage(ctx, service, actor, messageId, governanceAuthorize)))
        return;
      return this.#queueAnswer(ctx, () => service.interruptQueuedMessage(messageId));
    });
    router.delete(p('queue/:messageId'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const messageId = String(ctx.params.messageId);
      if (!(await this.#ownsQueuedMessage(ctx, service, actor, messageId, governanceAuthorize)))
        return;
      return this.#queueAnswer(ctx, () => service.removeQueuedMessage(messageId));
    });

    // 9. DELETE /agent/threads/:id. Authenticated + owner-scoped.
    router.delete(p('threads/:id'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const threadId = String(ctx.params.id);
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      await service.deleteThread(threadId);
      return ctx.response.json({ ok: true });
    });

    // 10. POST /agent/threads/:id/fork-from/:messageId. Authenticated + owner-scoped.
    router.post(p('threads/:id/fork-from/:messageId'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const threadId = String(ctx.params.id);
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      return ctx.response.json(await service.forkThread(threadId, String(ctx.params.messageId)));
    });

    // 10b. POST /agent/threads/:id/promote — keep a transient thread (it joins `GET threads`).
    router.post(p('threads/:id/promote'), async (ctx: HttpContext) => {
      const threadId = await this.#ownedThread(ctx, service, actorResolver, governanceAuthorize);
      if (threadId === null) return;
      if (!(await service.promoteThread(threadId))) {
        return ctx.response.status(501).json({
          message: 'Promoting a thread requires an AgentStore that implements promoteThread().',
        });
      }
      return ctx.response.json({ ok: true });
    });

    // 10c. DELETE /agent/threads/:id/from/:messageId — drop a message and everything after it, the
    // "edit and resend" primitive.
    router.delete(p('threads/:id/from/:messageId'), async (ctx: HttpContext) => {
      const threadId = await this.#ownedThread(ctx, service, actorResolver, governanceAuthorize);
      if (threadId === null) return;
      await service.truncateThreadFrom(threadId, String(ctx.params.messageId));
      return ctx.response.json({ ok: true });
    });

    // 10d. GET /agent/skills?threadId= — the skills THIS caller can invoke right now, scope-resolved:
    // the same list the model is offered, built by the same call, so what a composer suggests after
    // a `/` and what the agent can reach cannot drift apart. No skills configured → an empty list.
    // `threadId` only ever reaches the host's own resolver and provider; nothing here reads the
    // thread, so an unknown id widens nothing.
    const skills = config.skills;
    router.get(p('skills'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      if (skills === undefined) return ctx.response.json([]);
      const threadId = ctx.request.qs().threadId;
      const offer = await offerSkills(skills, {
        actor,
        threadId: typeof threadId === 'string' ? threadId : '',
      });
      return ctx.response.json(offer.entries);
    });

    // 11. GET /agent/memories + DELETE /agent/memories/:id — what the assistant believes about THIS
    // caller, and how they take one of those beliefs back.
    //
    // WHY THIS EXISTS WHERE SKILLS HAVE NO SUCH SIBLING. A skill is authored by a person who already
    // knows it exists; a memory is written by the agent, about someone who does not. So the
    // read-back is not a convenience on top of the feature, it IS half of the feature: a belief
    // nobody can inspect is one nobody can correct, and a belief nobody can delete is one the
    // deployment keeps whether or not it is true. That is also why `MemoryProvider.forget` is
    // required rather than optional.
    const memory = config.memory;
    // DELIBERATELY IGNORES `maxMemories`. That ceiling is a budget on what one TURN carries;
    // applying it here would mean a person could not see — and so could not delete — a belief the
    // assistant is one write away from acting on again. Showing someone more than the model sees is
    // harmless; showing them less is the failure this endpoint exists to prevent. For the same
    // reason it never passes a query: a relevance selection is what a turn wants, not what a person
    // owed the whole picture wants.
    const everyMemoryOf = (actor: Actor) =>
      offerMemories({
        config: { ...(memory as MemoryConfig), maxMemories: Number.POSITIVE_INFINITY },
        ctx: { actor, threadId: '' },
      });

    router.get(p('memories'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      if (memory === undefined) return ctx.response.json([]);
      return ctx.response.json((await everyMemoryOf(actor)).entries);
    });

    // Authorized against the actor's OWN resolved list, the same way a `skill` load is authorized
    // against the turn's catalog: an id this actor cannot see is answered as missing rather than
    // refused, so the endpoint cannot be used to find out which memories exist about other people.
    router.delete(p('memories/:id'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      if (memory === undefined) {
        return ctx.response.notFound({ message: 'No memory is configured in this deployment.' });
      }
      const id = String(ctx.params.id);
      const entry = (await everyMemoryOf(actor)).entries.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        return ctx.response.notFound({ message: `No memory with id "${id}".` });
      }
      const verdict = memoryForgetVerdict({ record: entry, actor });
      if (!verdict.allowed) {
        return ctx.response.forbidden({ message: verdict.reason });
      }
      return ctx.response.json({
        forgotten: await memory.provider.forget({ id: entry.id, ctx: { actor, threadId: '' } }),
      });
    });

    // 11a. GET /agent/config — server facts a client would otherwise repeat (attachment limits, whether
    // a picker / quota / anonymous identity is in play). Resolves the actor like every route, so an
    // anonymous browser gets its identity on whichever request comes first.
    router.get(p('config'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const clientConfig: AgentClientConfig = {
        attachments: {
          enabled: attachmentStaging !== undefined,
          upload: attachmentStaging === undefined ? null : (declared.upload ?? 'multipart'),
          maxBytes: attachmentLimits.maxBytes,
          allowedContentTypes: attachmentLimits.allowedContentTypes,
          maxPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
        },
        models: { enabled: service.hasModelCatalog() },
        quota: { enforced: config.quota !== undefined },
        identity: { anonymous: actorResolver instanceof AnonymousActorResolver },
      };
      return ctx.response.json(clientConfig);
    });

    // 11b. GET /agent/quota — every budget window with what was spent in it, and `blocked` naming
    // the exhausted one.
    router.get(p('quota'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(await service.quotaReport(actor));
    });

    // 12. POST /agent/attachments — OPTIONAL. Mounted only when `attachments` is configured, so
    // an app without it never exposes an upload surface. Buffers the multipart `file` field, validates
    // it against the size cap + content-type allowlist, then stages it into a model-fetchable
    // MessageAttachment the client sends back on its next `chat` call. Mirrors the SSE routes' envelope
    // (JSON body, actor resolved via the shared resolver, precise HTTP status on rejection).
    if (attachmentStaging !== undefined) {
      const staging = attachmentStaging;
      const { maxBytes, allowedContentTypes } = attachmentLimits;
      router.post(p('attachments'), async (ctx: HttpContext) => {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        const file = ctx.request.file('file');
        if (file === null || file.tmpPath === undefined) {
          return ctx.response.status(400).json({ message: 'multipart field "file" is required' });
        }
        const contentType =
          file.headers?.['content-type']?.split(';')[0]?.trim() ?? `${file.type}/${file.subtype}`;
        if (!allowedContentTypes.includes(contentType)) {
          return ctx.response.status(415).json({
            message: `content type "${contentType}" is not allowed (allowed: ${allowedContentTypes.join(', ')})`,
          });
        }
        const sizeBytes = file.size;
        if (sizeBytes > maxBytes) {
          return ctx.response
            .status(413)
            .json({ message: `file exceeds the ${maxBytes}-byte limit` });
        }
        const { readFile } = await import('node:fs/promises');
        const data = await readFile(file.tmpPath);
        const attachment = await staging.stage({
          data,
          filename: file.clientName,
          contentType,
          sizeBytes,
          actor,
        });
        return ctx.response.json(attachment);
      });

      // 12a. GET /agent/attachments — the caller's own staged files, newest first, metadata only
      // (no url: one is minted per request by the store's `resolve`). The one question
      // `GET threads/:id` cannot answer, since an upload that was never sent belongs to no thread.
      // `501` when the store keeps no inventory (`list`) — never an empty list in its place.
      // Collection is NOT a route: a sweep needs a host-chosen age and ends in deleting bytes, so it
      // stays in-process (`AgentService.collectableAttachments`).
      router.get(p('attachments'), async (ctx: HttpContext) => {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        try {
          return ctx.response.json(
            await service.listAttachments(actor, { limit: ATTACHMENT_PAGE_SIZE }),
          );
        } catch (error) {
          if (error instanceof AttachmentInventoryError) {
            return ctx.response.status(error.status).json({ message: error.message });
          }
          throw error;
        }
      });
    }

    // 12b. Resumable (tus) attachment uploads — mounted only when the store serves them
    // (`attachmentStores.media()` over a media library with `uploads.resumable`). These routes never
    // carry a byte: they open an owned, validated tus session, confirm the bytes arrived, and drop an
    // attachment the user removed. The bytes go to `@adonis-agora/media`'s own tus routes.
    const resumable = resumableStaging(attachmentStaging);
    if (resumable !== undefined) {
      const answer = async (
        ctx: HttpContext,
        work: (actor: Actor) => Promise<unknown>,
      ): Promise<unknown> => {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        try {
          return await work(actor);
        } catch (error) {
          const status = (error as { status?: unknown }).status;
          if (typeof status === 'number' && status >= 400 && status < 600) {
            return ctx.response
              .status(status)
              .json({ message: error instanceof Error ? error.message : String(error) });
          }
          throw error;
        }
      };
      // `{ filename, contentType, size }` → `{ mediaId, uploadId, location }`.
      router.post(p('attachments/uploads'), (ctx: HttpContext) =>
        answer(ctx, async (actor) => {
          const body = ctx.request.body() as Record<string, unknown>;
          return ctx.response.json(
            await resumable.beginUpload({
              actor,
              filename: body.filename as string,
              contentType: body.contentType as string,
              size: body.size as number,
            }),
          );
        }),
      );
      router.post(p('attachments/uploads/:mediaId/complete'), (ctx: HttpContext) =>
        answer(ctx, async (actor) => {
          const mediaId = String(ctx.params.mediaId);
          const attachment = await resumable.completeUpload({ actor, mediaId });
          if (attachment === null) {
            return ctx.response.status(404).json({ message: `attachment ${mediaId} not found` });
          }
          return ctx.response.json(attachment);
        }),
      );
      router.delete(p('attachments/uploads/:mediaId'), (ctx: HttpContext) =>
        answer(ctx, async (actor) => {
          const mediaId = String(ctx.params.mediaId);
          if (!(await resumable.discard({ actor, mediaId }))) {
            return ctx.response.status(404).json({ message: `attachment ${mediaId} not found` });
          }
          return ctx.response.status(204).send('');
        }),
      );
    }

    // The governance read-model resolved (often by default, when the main store is Lucid) but no
    // authorization gate was configured. The cross-actor `/agent/governance/*` routes are therefore
    // NOT mounted at all (they 404) — fail closed by omission, because an ungated cross-actor
    // read-model exposes every actor's spend/usage/threads/approvals to any authenticated caller,
    // and a boot warning is not a control. `/agent/approvals/mine` is unaffected (see below).
    if (governance !== undefined && governanceAuthorize === undefined) {
      console.warn(
        '[@adonis-agora/agent] `/agent/governance/*` was NOT mounted: the cross-actor spend/usage/threads/approvals read-model requires a `governanceAuthorize` gate, and none is configured. Set `governanceAuthorize` in config/agent.ts (e.g. an ADMIN check) to mount the routes gated, or `governanceAuthorize: () => true` to deliberately restore the old behaviour of letting ANY authenticated actor read them. `GET /agent/approvals/mine` is unaffected — it stays mounted and scoped to the calling actor.',
      );
    }

    // ── Per-actor approvals inbox. Mounted with the governance read-model (it reads the same store),
    // but NOT behind `governanceAuthorize`: it is ALWAYS scoped to the calling actor's OWN pending
    // approvals (`pendingApprovals({ actor })` filters by the owning run's `actor_ref`). This is the
    // route a non-admin surface (e.g. a coordinator's chat) polls to discover its own suspended
    // tool calls, even when the cross-actor governance read-model below is ADMIN-only.
    if (governance !== undefined) {
      const gov = governance;
      const limitFor = (ctx: HttpContext) => {
        const raw = Number.parseInt(String(ctx.request.input('limit', '50')), 10);
        const value = Number.isFinite(raw) && raw > 0 ? raw : 50;
        return Math.min(value, 200);
      };
      // GET /agent/approvals/mine — the authenticated actor's own pending HITL approvals, oldest first.
      router.get(p('approvals/mine'), async (ctx: HttpContext) => {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        return ctx.response.json(
          await withActorLabels(
            await gov.pendingApprovals({ limit: limitFor(ctx), actor: actor.id }),
            actorDirectory,
          ),
        );
      });
    }

    // ── OPTIONAL cross-actor governance read routes. Mounted only when `governanceQueries` is
    // configured AND a `governanceAuthorize` gate exists — no gate means the routes do not exist at
    // all (404), because every one of them reads PLATFORM-WIDE data (no route below is scoped to the
    // caller). Fail closed by omission: an app that wants the historical open behaviour asks for it
    // explicitly with `governanceAuthorize: () => true`. All read-only (GET). Each route resolves the
    // actor (401 on failure) and then runs the gate (403 on deny) via `#resolveGovernanceActor` —
    // restricting this read-model (e.g. ADMIN-only) never locks the per-actor `approvals/mine` route
    // above. `from`/`to` are inclusive UTC days (`YYYY-MM-DD`), defaulting to today; `limit` defaults
    // to 50, clamped to 200 (mirroring the dashboard's own clamp).
    if (governance !== undefined && governanceAuthorize !== undefined) {
      const gov = governance;
      const g = (suffix: string) => p(`governance/${suffix}`);
      const range = (ctx: HttpContext) => {
        const today = new Date().toISOString().slice(0, 10);
        const from = ctx.request.input('from', today);
        const to = ctx.request.input('to', today);
        return { fromDay: String(from), toDay: String(to) };
      };
      const positiveIntInput = (ctx: HttpContext, key: string) => {
        const raw = Number.parseInt(String(ctx.request.input(key, '50')), 10);
        const value = Number.isFinite(raw) && raw > 0 ? raw : 50;
        return Math.min(value, 200);
      };
      /** `?limit=` — the cap on the top-N feeds (`recentToolCalls`, `recentThreads`, the approvals
       *  inbox). Those are capped lists, not cursor-paginated surfaces, so they keep `limit`. */
      const limitOf = (ctx: HttpContext) => positiveIntInput(ctx, 'limit');
      /** `?first=` — the page size of the cursor-paginated surfaces, which speak `{ after, first }`
       *  (the ecosystem interface mirroring `@adonis-agora/filter`'s `CursorParams`). Same default
       *  (50) and ceiling (200) as `?limit=`. */
      const firstOf = (ctx: HttpContext) => positiveIntInput(ctx, 'first');

      // GET /agent/governance/spend/model — per-model token + cost rollup over the range.
      router.get(g('spend/model'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(await gov.spendByModel(range(ctx)));
      });

      // GET /agent/governance/spend/actor — per-actor token + cost rollup over the range.
      router.get(g('spend/actor'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(
          await withActorLabels(await gov.spendByActor(range(ctx)), actorDirectory),
        );
      });

      // GET /agent/governance/usage/trend — the daily token + cost trend over the range.
      router.get(g('usage/trend'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(await gov.usageTrend(range(ctx)));
      });

      // GET /agent/governance/tool-calls/recent — newest-first recent tool-call activity feed.
      router.get(g('tool-calls/recent'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(await gov.recentToolCalls(limitOf(ctx)));
      });

      // GET /agent/governance/threads/recent — newest-first recent thread activity feed.
      router.get(g('threads/recent'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(
          await withActorLabels(await gov.recentThreads(limitOf(ctx)), actorDirectory),
        );
      });

      // GET /agent/governance/threads/:id — one thread's governance drill-down (metadata + lifetime
      // usage rollup + recent runs/messages), or `null` when unknown. `501` when the bound governance
      // adapter predates `threadDetail` (an optional SPI method — a third-party adapter may omit it).
      router.get(g('threads/:id'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        if (gov.threadDetail === undefined) {
          return ctx.response
            .status(501)
            .json({ message: 'this governance adapter does not support thread detail' });
        }
        const detail = await withActorLabel(
          await gov.threadDetail(String(ctx.params.id)),
          actorDirectory,
        );
        if (detail === null) return ctx.response.json(null);
        return ctx.response.json({
          ...detail,
          runs: await withActorLabels(detail.runs, actorDirectory),
        });
      });

      // ── Run lifecycle governance (the run tracking read-model). Same read-only + authenticated +
      // authorized envelope; the runs are cross-actor governance data.
      const optionalRange = (ctx: HttpContext) => {
        const from = ctx.request.input('from');
        const to = ctx.request.input('to');
        return {
          ...(from !== undefined ? { from: String(from) } : {}),
          ...(to !== undefined ? { to: String(to) } : {}),
        };
      };

      // GET /agent/governance/runs — filterable, cursor-paginated run list, newest-first.
      // Query: actor?, agent?, status?, from?, to?, after?, first?
      // `after`/`first` are the ecosystem's forward-only cursor pagination interface (mirroring
      // `@adonis-agora/filter`'s `CursorParams`); the body is a `CursorPage` — `items`, `nextCursor`,
      // and the constant `prevCursor: null` / `hasPrev: false`.
      router.get(g('runs'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        const filterActor = ctx.request.input('actor');
        const agent = ctx.request.input('agent');
        const status = ctx.request.input('status');
        const after = ctx.request.input('after');
        const { from, to } = optionalRange(ctx);
        const page = await gov.listRuns({
          first: firstOf(ctx),
          ...(filterActor !== undefined ? { actor: String(filterActor) } : {}),
          ...(agent !== undefined ? { agent: String(agent) } : {}),
          ...(status !== undefined ? { status: String(status) as never } : {}),
          ...(after !== undefined ? { after: String(after) } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        });
        return ctx.response.json({
          ...page,
          items: await withActorLabels(page.items, actorDirectory),
        });
      });

      // GET /agent/governance/runs/:id — one run's full trace (run + messages + tool calls +
      // approvals + usage), or null.
      router.get(g('runs/:id'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        const detail = await gov.runDetail(String(ctx.params.id));
        if (detail === null) return ctx.response.json(null);
        return ctx.response.json({
          ...detail,
          run: (await withActorLabel(detail.run, actorDirectory)) ?? detail.run,
        });
      });

      // GET /agent/governance/approvals/pending — cross-actor HITL approvals inbox, oldest first. This
      // is the platform-wide inbox (every actor's pending calls); it is governance-gated. A caller that
      // only needs its OWN pending approvals uses `GET /agent/approvals/mine` instead.
      router.get(g('approvals/pending'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        const filterActor = ctx.request.input('actor');
        return ctx.response.json(
          await withActorLabels(
            await gov.pendingApprovals({
              limit: limitOf(ctx),
              ...(filterActor !== undefined ? { actor: String(filterActor) } : {}),
            }),
            actorDirectory,
          ),
        );
      });

      // GET /agent/governance/tools/stats — per-tool call/failure/rejection/latency rollup.
      router.get(g('tools/stats'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(await gov.perToolStats(optionalRange(ctx)));
      });

      // GET /agent/governance/reliability — success/failure/cancel rates + mean settled duration.
      router.get(g('reliability'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        return ctx.response.json(await gov.runReliability(optionalRange(ctx)));
      });

      // ── Model pricing CRUD — OPTIONAL within the already-optional governance block: mounted only
      // when a pricing store is ALSO bound (`pricingStore: false` disables it). The store already
      // exists and is wired into the loop's cost fold (`#resolvePricing`); these two routes are the
      // only thing missing for the console's Pricing panel to read/write it, gated the same as every
      // other cross-actor governance surface.
      if (pricingStore !== undefined) {
        const pricing = pricingStore;

        // GET /agent/governance/pricing — every model's current per-1M rates.
        router.get(g('pricing'), async (ctx: HttpContext) => {
          const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
          if (actor === null) return;
          return ctx.response.json(await pricing.listCurrentPrices());
        });

        // POST /agent/governance/pricing — upsert one model's rate (atomic supersede; see
        // `AgentPricingStore.upsertModelPrice`). Body: `{modelId, inputPricePer1m, outputPricePer1m,
        // cacheWritePricePer1m?, cacheReadPricePer1m?}`.
        router.post(g('pricing'), async (ctx: HttpContext) => {
          const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
          if (actor === null) return;
          const body = (ctx.request.body() ?? {}) as {
            modelId?: unknown;
            inputPricePer1m?: unknown;
            outputPricePer1m?: unknown;
            cacheWritePricePer1m?: unknown;
            cacheReadPricePer1m?: unknown;
          };
          if (
            typeof body.modelId !== 'string' ||
            body.modelId.length === 0 ||
            typeof body.inputPricePer1m !== 'number' ||
            typeof body.outputPricePer1m !== 'number'
          ) {
            return ctx.response.status(400).json({
              message:
                'body must be {modelId: string, inputPricePer1m: number, outputPricePer1m: number, cacheWritePricePer1m?: number, cacheReadPricePer1m?: number}',
            });
          }
          await pricing.upsertModelPrice({
            modelId: body.modelId,
            inputPricePer1m: body.inputPricePer1m,
            outputPricePer1m: body.outputPricePer1m,
            ...(typeof body.cacheWritePricePer1m === 'number'
              ? { cacheWritePricePer1m: body.cacheWritePricePer1m }
              : {}),
            ...(typeof body.cacheReadPricePer1m === 'number'
              ? { cacheReadPricePer1m: body.cacheReadPricePer1m }
              : {}),
          });
          return ctx.response.json({ ok: true });
        });
      }
    }
  }

  /**
   * Resolve the actor; on failure reply 401 and return `null` so the handler short-circuits. A
   * resolver is contracted to THROW when it can't establish an identity, but a misbehaving custom
   * resolver that returns a nullish value instead is also treated as unauthorized (401) rather than
   * letting `undefined`/`null` reach the service as a fabricated actor.
   */
  async #resolveActor(ctx: HttpContext, actorResolver: ActorResolver) {
    try {
      const actor = await actorResolver.resolve(ctx);
      if (actor === null || actor === undefined) {
        ctx.response.status(401).json({ message: 'unauthorized', code: 'unauthorized' });
        return null;
      }
      return actor;
    } catch (error) {
      // The resolver's `.message` is meant for the developer wiring `actorResolver`, not the caller —
      // in production, every request here is untrusted by definition, so the detail stays server-side
      // (dev/test keeps it, matching `evaluateDashboardGate`/`evaluateGovernanceGate`'s `debug` knob).
      const debug = !this.app.inProduction;
      ctx.response.status(401).json({
        message: debug && error instanceof Error ? error.message : 'unauthorized',
        code: 'unauthorized',
      });
      return null;
    }
  }

  /**
   * Resolve the actor for a cross-actor governance route, then apply the optional `governanceAuthorize`
   * gate. Replies `401` (unresolved actor) or `403` (gate denied/threw) and returns `null` so the
   * handler short-circuits; otherwise returns the resolved actor. The gate decision itself lives in the
   * router-free {@link evaluateGovernanceGate} so it can be unit tested.
   */
  async #resolveGovernanceActor(
    ctx: HttpContext,
    actorResolver: ActorResolver,
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
  ) {
    const actor = await this.#resolveActor(ctx, actorResolver);
    if (actor === null) return null;
    const verdict = await evaluateGovernanceGate(
      actor,
      ctx,
      governanceAuthorize,
      !this.app.inProduction,
    );
    if (!verdict.ok) {
      ctx.response.status(verdict.status).json({ message: verdict.error });
      return null;
    }
    return actor;
  }

  /**
   * Object-level authorization: assert the already-resolved `actor` may act on a per-actor resource
   * (a run or thread) whose owning ref is `ownerRef`. A caller may act on a resource it OWNS; a
   * cross-actor caller is allowed only when it is governance-privileged (passes `governanceAuthorize`,
   * the app's "may act across actors" seam — so with no gate configured, ownership is strict). Replies
   * `404` (unknown resource — never confirms an id the caller doesn't own) or `403` (not owner, not
   * privileged) and returns `false`; returns `true` to proceed. Decision core is the router-free
   * {@link evaluateOwnership}.
   */
  async #assertOwner(
    ctx: HttpContext,
    actor: Actor,
    ownerRef: string | null,
    kind: 'run' | 'thread',
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
  ): Promise<boolean> {
    let privileged = false;
    if (governanceAuthorize !== undefined) {
      privileged = (
        await evaluateGovernanceGate(actor, ctx, governanceAuthorize, !this.app.inProduction)
      ).ok;
    }
    const verdict = evaluateOwnership(actor.id, ownerRef, privileged);
    if (!verdict.ok) {
      const error = verdict.status === 404 ? `${kind} not found` : 'forbidden';
      ctx.response.status(verdict.status).json({ message: error });
      return false;
    }
    return true;
  }

  /**
   * Answers addressed at a tool call that is waiting for an approve/reject are a `409`, not a `500`:
   * nothing is broken, the caller sent the wrong kind of reply for that call. The run is left parked
   * on the approval it was always waiting for, rather than recording a decision nobody made.
   */
  /**
   * The run a HITL decision addresses. `runId` is optional on the body: the shared React client
   * (`@dudousxd/nestjs-agent-react`) names the call alone, since a tool call id is unique. Absent, it
   * is read off the call's own row; an unknown call answers `404` and returns `null`. A supplied
   * `runId` is trusted only as far as the owner check that follows it, exactly as before.
   */
  async #runOfToolCall(
    ctx: HttpContext,
    service: AgentService,
    body: { runId?: string; toolCallId?: string },
  ): Promise<string | null> {
    if (typeof body.runId === 'string' && body.runId.length > 0) return body.runId;
    const runId =
      typeof body.toolCallId === 'string' ? await service.toolCallRun(body.toolCallId) : null;
    if (runId === null) {
      ctx.response.notFound({ message: 'Unknown tool call.' });
      return null;
    }
    return runId;
  }

  /**
   * May `actor` settle this call, and is it still open? The call's recorded approver decides who:
   * the requester (the default, and every call recorded before approvers existed) is the run's own
   * actor — the ownership check this always was, governance-privileged callers included; any other
   * approver goes through the policy's `canDecide` (by default: holds that role) → `403`. A request
   * that already lapsed — recorded `expired`, or past its `expiresAt` with the run's own timer about
   * to fire — answers `410`: signalling it anyway would race the timeout, and a late approval must
   * not be what a later replay of the run reads back. Answers the response itself when it refuses.
   */
  async #mayDecide(
    ctx: HttpContext,
    service: AgentService,
    actor: Actor,
    runId: string,
    toolCallId: string,
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
  ): Promise<boolean> {
    const approval = await service.toolCallApproval(toolCallId);
    const approver = approval?.approver ?? REQUESTER_APPROVER;
    const owner = await service.runOwner(runId);
    if (approver === REQUESTER_APPROVER) {
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return false;
    } else {
      if (owner === null) {
        ctx.response.notFound({ message: 'Unknown run.' });
        return false;
      }
      if (!(await service.mayDecide(actor, { toolCallId, approver, requesterRef: owner }))) {
        ctx.response.forbidden({ message: `This approval is for ${approver}.` });
        return false;
      }
    }
    const lapsed =
      approval !== null &&
      (approval.status === 'expired' ||
        (approval.status === 'pending_approval' &&
          approval.expiresAt !== null &&
          Date.parse(approval.expiresAt) <= Date.now()));
    if (lapsed) {
      ctx.response.gone({
        message: `The approval request for tool call ${toolCallId} has expired.`,
      });
      return false;
    }
    return true;
  }

  /** A refused queue request: the error's own status, as `{ message, code? }`. */
  #refuseQueue(ctx: HttpContext, error: ChatQueueError): void {
    ctx.response
      .status(error.status)
      .json({ message: error.message, ...(error.code !== undefined ? { code: error.code } : {}) });
  }

  /** Answer a queue route: the service's result, or the refusal it threw. */
  async #queueAnswer(ctx: HttpContext, work: () => Promise<unknown>): Promise<void> {
    try {
      ctx.response.json(await work());
    } catch (error) {
      if (error instanceof ChatQueueError) {
        return this.#refuseQueue(ctx, error);
      }
      if (error instanceof AttachmentRefusedError) {
        ctx.response.status(error.status).json({ message: error.message });
        return;
      }
      throw error;
    }
  }

  /** The `:id` thread once the caller is shown to own it; `null` after replying 401/403/404. */
  async #ownedThread(
    ctx: HttpContext,
    service: AgentService,
    actorResolver: ActorResolver,
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
  ): Promise<string | null> {
    const actor = await this.#resolveActor(ctx, actorResolver);
    if (actor === null) return null;
    const threadId = String(ctx.params.id);
    const owner = await service.threadOwner(threadId);
    return (await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))
      ? threadId
      : null;
  }

  /**
   * Does `actor` own the thread a queued message waits on? Replies `404` for a message that does
   * not exist (or a store without a queue answers `501`), `403` for another actor's.
   */
  async #ownsQueuedMessage(
    ctx: HttpContext,
    service: AgentService,
    actor: Actor,
    messageId: string,
    governanceAuthorize: AgentGovernanceAuthorize | undefined,
  ): Promise<boolean> {
    let threadId: string | null;
    try {
      threadId = await service.queuedMessageThread(messageId);
    } catch (error) {
      if (error instanceof ChatQueueError) {
        this.#refuseQueue(ctx, error);
        return false;
      }
      throw error;
    }
    if (threadId === null) {
      ctx.response.notFound({ message: `queued message ${messageId} not found` });
      return false;
    }
    const owner = await service.threadOwner(threadId);
    return this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize);
  }

  /** The default `onPresentationError`: a warning on the app's logger (none bound → `undefined`). */
  async #logPresentationErrors(): Promise<PresentationErrorHandler | undefined> {
    if (!this.app.container.hasBinding('logger')) return undefined;
    const logger = await this.app.container.make('logger');
    return (error, details) => {
      logger.warn(
        { err: error, ...details },
        'Tool presentation failed after successful execution',
      );
    };
  }

  #conflictOnMismatch(ctx: HttpContext, error: unknown): void {
    // The run the decision was for has ended: nothing is waiting for it (`409 run_not_active`).
    if (error instanceof RunNotActiveError) {
      ctx.response.conflict({ code: error.code, message: error.message });
      return;
    }
    if (!(error instanceof HumanReplyMismatchError)) {
      throw error;
    }
    ctx.response.conflict({ message: error.message });
  }

  /**
   * Answer a refused send — an attachment, a model, a busy thread, an exhausted budget — the way
   * `POST <path>/chat` does. `false` for an error that is none of those (the caller rethrows).
   */
  #refuseSend(ctx: HttpContext, error: unknown): boolean {
    if (error instanceof ActionProposalServiceError) {
      ctx.response.status(error.status).json({ message: error.message });
      return true;
    }
    if (error instanceof AttachmentRefusedError) {
      ctx.response.status(error.status).json({ message: error.message });
      return true;
    }
    if (error instanceof ModelNotAllowedError) {
      ctx.response.badRequest({ message: error.message, code: 'model_not_allowed' });
      return true;
    }
    if (error instanceof PersonaNotFoundError) {
      ctx.response.badRequest({ message: error.message, code: error.code });
      return true;
    }
    if (error instanceof ChatQueueError) {
      this.#refuseQueue(ctx, error);
      return true;
    }
    if (error instanceof QuotaBlockedError) {
      ctx.response.status(429).json({
        code: 'quota_exceeded',
        period: error.period,
        message: error.message,
      });
      return true;
    }
    return false;
  }

  /**
   * Pipe the run's live token stream to the client as SSE: `event: meta` (runId/threadId), the run's
   * frames, then `event: done`. Sets the `X-Agent-Run-Id` / `X-Agent-Thread-Id` headers. Writes the
   * raw Node response directly (Adonis has no SSE helper) and ends only on stream completion — the
   * sink closes on run finish, not on suspend.
   *
   * The sink carries typed `StreamFrame`s; each becomes the `AgentStreamEvent`s it stands for
   * (`AgentSseEncoder`, the protocol shared with `@dudousxd/nestjs-agent`), and a failure ends the
   * stream with `event: error` instead of `done`.
   */
  async #pipe(
    ctx: HttpContext,
    service: AgentService,
    runId: string,
    threadId?: string,
    after = 0,
  ): Promise<void> {
    const raw = ctx.response.response;
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Agent-Run-Id': runId,
      ...(threadId !== undefined ? { 'X-Agent-Thread-Id': threadId } : {}),
    };
    // Headers the request already set on Adonis's response (the anonymous identity cookie, a
    // session) — `writeHead` on the raw response would otherwise skip them.
    const pending = ctx.response.getHeaders();
    for (const [name, value] of Object.entries(pending)) {
      if (value !== undefined && !(name in headers))
        raw.setHeader(name, value as string | string[]);
    }
    raw.writeHead(200, headers);
    raw.write(`event: meta\ndata: ${JSON.stringify({ runId, threadId })}\n\n`);
    const encoder = new AgentSseEncoder(after);
    for await (const frame of service.subscribe(runId)) {
      const text = encoder.encode(frame);
      if (text.length > 0) raw.write(text);
    }
    raw.write(encoder.close());
    raw.end();
  }
}

/** The resumable half of an attachment store, when it has one — what the tus routes call. */
interface ResumableAttachmentStaging {
  beginUpload(input: {
    actor: Actor;
    filename: string;
    contentType: string;
    size: number;
  }): Promise<unknown>;
  completeUpload(input: { actor: Actor; mediaId: string }): Promise<unknown | null>;
  discard(input: { actor: Actor; mediaId: string }): Promise<boolean>;
}

/**
 * The store's resumable methods, only when it has all three AND declares itself resumable — a
 * `MediaAttachmentStaging` over a media library without `uploads.resumable` has the methods but
 * would answer every one with a 501.
 */
function resumableStaging(
  staging: AttachmentStagingStore | undefined,
): ResumableAttachmentStaging | undefined {
  const candidate = staging as Partial<ResumableAttachmentStaging> | undefined;
  if (
    typeof candidate?.beginUpload !== 'function' ||
    typeof candidate.completeUpload !== 'function' ||
    typeof candidate.discard !== 'function' ||
    staging?.describe?.().upload !== 'resumable'
  ) {
    return undefined;
  }
  return candidate as ResumableAttachmentStaging;
}
