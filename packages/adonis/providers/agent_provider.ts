import { pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  type Actor,
  type ActorDirectory,
  type ActorResolver,
  type AgentConfig,
  AgentDepsFactory,
  type AgentGovernanceAuthorize,
  type AgentGovernanceQueries,
  type AgentPricingStore,
  AgentRegistry,
  type AgentRunner,
  AgentService,
  type AgentStore,
  type AttachmentStagingStore,
  DefaultToolAuthorizer,
  discoverTools,
  evaluateGovernanceGate,
  evaluateOwnership,
  frameToSse,
  governanceQueries as governanceQueriesFactories,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  lucidStoreConnection,
  type MessageAttachment,
  type ModelProvider,
  type PageContext,
  pricingStores,
  type QuotaStore,
  type Retriever,
  type RolesPolicy,
  registerDelegateTools,
  registerFunctionalTool,
  registerToolsFromBarrel,
  resolveActorResolver,
  type TokenStreamSink,
  ToolRegistry,
  type ToolsBarrel,
  UnconfiguredActorResolver,
  withActorLabel,
  withActorLabels,
} from '../src/index.js';
import { setTelescopeGovernanceQueries } from '../src/telescope/governance-registry.js';

interface ChatBody {
  message: string;
  threadId?: string;
  agent?: string;
  persona?: string;
  pageContext?: PageContext;
  /** Already-staged attachments (from `POST /agent/attachments`) to send with this message. */
  attachments?: MessageAttachment[];
}

/** Default per-file size cap when `attachmentMaxBytes` is omitted (20 MiB). */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default allowlist: what multimodal model providers commonly accept as native image/file parts. */
const DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/**
 * Wires `@adonis-agora/agent` into the AdonisJS application from `config/agent.ts`:
 *
 * - `register()` binds the shared `ToolRegistry` + `AgentRegistry` singletons.
 * - `boot()` discovers tools (the generated `hooks/tools` barrel first, then an `app/agent_tools`
 *   readdir fallback), registers config-level functional tools and synthesizes `agent`-kind delegate
 *   tools for `delegatesTo` edges, builds the runtime graph (store/sink/quota/authorizer/actor-resolver
 *   → deps factory → the inline runner → the `AgentService` facade), and mounts the `/agent` routes
 *   under `config.path` — plus optional routes (`POST /agent/attachments` when `attachmentStaging` is
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
  #sink: TokenStreamSink | null = null;
  #actorDirectory: ActorDirectory | null = null;

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
    const defaultRoles = config.defaultRoles ?? ['ADMIN'];

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
    });
    // Config-level functional tools (defineTool), then synthesized delegate tools.
    for (const tool of config.tools ?? []) {
      registerFunctionalTool(registry, tool, defaultRoles);
    }
    registerDelegateTools(registry, agents);

    // ── Runtime graph ──
    const model = await this.#resolveModel(config);
    const store = await this.#resolveStore(config);
    const sink = await this.#resolveSink(config);
    // Quota is resolved after the store so a ledger-backed quota can read the store's usage ledger.
    const quota = await this.#resolveQuota(config, store);
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
    const attachmentStaging = await this.#resolveAttachmentStaging(config);
    const authorizer = this.#resolveAuthorizer(config, defaultRoles);
    const actorResolver = config.actorResolver ?? new UnconfiguredActorResolver();
    // Read-side identity lookup for governance/dashboard surfaces (optional; renders raw refs if unset).
    const actorDirectory = await this.#resolveActorDirectory(config);
    this.#store = store;
    this.#sink = sink;
    this.#actorDirectory = actorDirectory;

    const factory = new AgentDepsFactory({
      model,
      store,
      sink,
      rolesPolicy: authorizer,
      registry,
      agents,
      defaultAgentName: config.defaultAgent?.name ?? 'default',
      ...(quota !== undefined ? { quota } : {}),
      ...(pricingStore !== undefined ? { pricingStore } : {}),
      ...(retriever !== undefined ? { retriever } : {}),
      ...(config.retrievalTopK !== undefined ? { retrievalTopK: config.retrievalTopK } : {}),
      ...(config.retrievalFilter !== undefined ? { retrievalFilter: config.retrievalFilter } : {}),
      ...(config.toolTransientRetry !== undefined
        ? { toolTransientRetry: config.toolTransientRetry }
        : {}),
    });
    // `durable: true` runs each turn as a replay-safe `@adonis-agora/durable` workflow; it degrades
    // gracefully to the in-process runner when the durable peer isn't installed/configured.
    const runner =
      config.durable === true
        ? ((await this.#resolveDurableRunner(factory, store)) ??
          new InlineAgentRunner(factory, store))
        : new InlineAgentRunner(factory, store);
    const service = new AgentService(runner, store, factory);
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

  async shutdown() {
    // The Lucid store shares the app's `db` (it owns no connection to close); the in-process sink
    // holds only per-run buffers that GC with the provider. Drop refs so a hot reload starts clean.
    this.#store = null;
    this.#sink = null;
    this.#actorDirectory = null;
  }

  // ── resolution helpers ────────────────────────────────────────────────────

  async #resolveModel(config: AgentConfig): Promise<ModelProvider> {
    const model = config.model;
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

  async #resolveQuota(config: AgentConfig, store: AgentStore): Promise<QuotaStore | undefined> {
    const quota = config.quota;
    if (quota === undefined) return undefined;
    return typeof quota === 'function' ? quota({ app: this.app, store }) : quota;
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
  ): Promise<AttachmentStagingStore | undefined> {
    const staging = config.attachmentStaging;
    if (staging === undefined) return undefined;
    return typeof staging === 'function' ? staging({ app: this.app }) : staging;
  }

  #resolveAuthorizer(config: AgentConfig, defaultRoles: string[]): RolesPolicy {
    return config.authorizer ?? config.rolesPolicy ?? new DefaultToolAuthorizer(defaultRoles);
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
  ): Promise<AgentRunner | null> {
    try {
      const durable = await import('@adonis-agora/durable');
      const engine = await this.app.container.make(durable.WorkflowEngine);
      const { DurableAgentRunner, registerAgentWorkflow, setDurableAgentContext } = await import(
        '../src/durable/index.js'
      );
      setDurableAgentContext({ factory, store });
      registerAgentWorkflow(engine);
      return new DurableAgentRunner(engine, store);
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
      const agentName = body.agent ?? defaultAgentName;
      const resolver = resolveActorResolver(actorResolver, agents.get(agentName));
      const actor = await this.#resolveActor(ctx, resolver);
      if (actor === null) return;
      if (body.threadId !== undefined) {
        const owner = await service.threadOwner(body.threadId);
        if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      }
      const { runId, threadId } = await service.chat({
        actor,
        message: body.message,
        ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
        ...(body.agent !== undefined ? { agentName: body.agent } : {}),
        ...(body.persona !== undefined ? { personaId: body.persona } : {}),
        ...(body.pageContext !== undefined ? { pageContext: body.pageContext } : {}),
        ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      });
      await this.#pipe(ctx, service, runId, threadId);
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
      await this.#pipe(ctx, service, runId);
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

    // 4. POST /agent/tool-call/approve — authenticated + owner-scoped. Delivering a HITL decision is a
    // privileged control: only the actor that OWNS the run (or a governance-privileged actor) may
    // approve its pending tool call — an authenticated non-owner who learns a runId/toolCallId cannot.
    router.post(p('tool-call/approve'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as { runId: string; toolCallId: string };
      const owner = await service.runOwner(body.runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      await service.approve(body.runId, body.toolCallId);
      return ctx.response.json({ ok: true });
    });

    // 5. POST /agent/tool-call/reject — authenticated + owner-scoped (mirrors approve).
    router.post(p('tool-call/reject'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const body = (ctx.request.body() ?? {}) as {
        runId: string;
        toolCallId: string;
        reason?: string;
      };
      const owner = await service.runOwner(body.runId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'run', governanceAuthorize))) return;
      await service.reject(body.runId, body.toolCallId, body.reason);
      return ctx.response.json({ ok: true });
    });

    // 6. GET /agent/threads — the actor's threads.
    router.get(p('threads'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(await service.listThreads(actor.id));
    });

    // 7. GET /agent/threads/personas/catalog (before :id so it isn't captured by the param).
    // Authenticated — an anonymous caller reads nothing from the agent surface.
    router.get(p('threads/personas/catalog'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(service.personaCatalog());
    });

    // 8. GET /agent/threads/:id — detail or null. Authenticated + owner-scoped (a caller reads only its
    // own threads, unless governance-privileged).
    router.get(p('threads/:id'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      const threadId = String(ctx.params.id);
      const owner = await service.threadOwner(threadId);
      if (!(await this.#assertOwner(ctx, actor, owner, 'thread', governanceAuthorize))) return;
      return ctx.response.json(await service.getThread(threadId));
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

    // 11. GET /agent/quota/today.
    router.get(p('quota/today'), async (ctx: HttpContext) => {
      const actor = await this.#resolveActor(ctx, actorResolver);
      if (actor === null) return;
      return ctx.response.json(await service.quotaToday(actor.id));
    });

    // 12. POST /agent/attachments — OPTIONAL. Mounted only when `attachmentStaging` is configured, so
    // an app without it never exposes an upload surface. Buffers the multipart `file` field, validates
    // it against the size cap + content-type allowlist, then stages it into a model-fetchable
    // MessageAttachment the client sends back on its next `chat` call. Mirrors the SSE routes' envelope
    // (JSON body, actor resolved via the shared resolver, precise HTTP status on rejection).
    if (attachmentStaging !== undefined) {
      const staging = attachmentStaging;
      const maxBytes = config.attachmentMaxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
      const allowedContentTypes =
        config.attachmentAllowedContentTypes ?? DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES;
      router.post(p('attachments'), async (ctx: HttpContext) => {
        const actor = await this.#resolveActor(ctx, actorResolver);
        if (actor === null) return;
        const file = ctx.request.file('file');
        if (file === null || file.tmpPath === undefined) {
          return ctx.response.status(400).json({ error: 'multipart field "file" is required' });
        }
        const contentType =
          file.headers?.['content-type']?.split(';')[0]?.trim() ?? `${file.type}/${file.subtype}`;
        if (!allowedContentTypes.includes(contentType)) {
          return ctx.response.status(415).json({
            error: `content type "${contentType}" is not allowed (allowed: ${allowedContentTypes.join(', ')})`,
          });
        }
        const sizeBytes = file.size;
        if (sizeBytes > maxBytes) {
          return ctx.response
            .status(413)
            .json({ error: `file exceeds the ${maxBytes}-byte limit` });
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
      const limitOf = (ctx: HttpContext) => {
        const raw = Number.parseInt(String(ctx.request.input('limit', '50')), 10);
        const value = Number.isFinite(raw) && raw > 0 ? raw : 50;
        return Math.min(value, 200);
      };

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
            .json({ error: 'this governance adapter does not support thread detail' });
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
      // Query: actor?, agent?, status?, from?, to?, cursor?, limit?
      router.get(g('runs'), async (ctx: HttpContext) => {
        const actor = await this.#resolveGovernanceActor(ctx, actorResolver, governanceAuthorize);
        if (actor === null) return;
        const filterActor = ctx.request.input('actor');
        const agent = ctx.request.input('agent');
        const status = ctx.request.input('status');
        const cursor = ctx.request.input('cursor');
        const { from, to } = optionalRange(ctx);
        const page = await gov.listRuns({
          limit: limitOf(ctx),
          ...(filterActor !== undefined ? { actor: String(filterActor) } : {}),
          ...(agent !== undefined ? { agent: String(agent) } : {}),
          ...(status !== undefined ? { status: String(status) as never } : {}),
          ...(cursor !== undefined ? { cursor: String(cursor) } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        });
        return ctx.response.json({
          ...page,
          runs: await withActorLabels(page.runs, actorDirectory),
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
              error:
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
        ctx.response.status(401).json({ error: 'unauthorized' });
        return null;
      }
      return actor;
    } catch (error) {
      // The resolver's `.message` is meant for the developer wiring `actorResolver`, not the caller —
      // in production, every request here is untrusted by definition, so the detail stays server-side
      // (dev/test keeps it, matching `evaluateDashboardGate`/`evaluateGovernanceGate`'s `debug` knob).
      const debug = !this.app.inProduction;
      ctx.response
        .status(401)
        .json({ error: debug && error instanceof Error ? error.message : 'unauthorized' });
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
      ctx.response.status(verdict.status).json({ error: verdict.error });
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
      ctx.response.status(verdict.status).json({ error });
      return false;
    }
    return true;
  }

  /**
   * Pipe the run's live token stream to the client as SSE, reproducing the envelope byte-for-byte for
   * text frames: `event: meta` (runId/threadId) → `data: {"delta":...}` per text frame → `event: done`.
   * Sets the `X-Agent-Run-Id` / `X-Agent-Thread-Id` headers. Writes the raw Node response directly
   * (Adonis has no SSE helper) and ends only on stream completion — the sink closes on run finish, not
   * on suspend.
   *
   * The sink carries typed `StreamFrame`s (`{ t: 'text' }` | `{ t: 'component' }`); `frameToSse`
   * serializes each frame to its wire envelope — text stays the byte-identical legacy
   * `data: {"delta":...}` frame, components become `event: component\ndata: {name,data}`.
   */
  async #pipe(
    ctx: HttpContext,
    service: AgentService,
    runId: string,
    threadId?: string,
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
    raw.writeHead(200, headers);
    raw.write(`event: meta\ndata: ${JSON.stringify({ runId, threadId })}\n\n`);
    for await (const frame of service.subscribe(runId)) {
      raw.write(frameToSse(frame));
    }
    raw.write('event: done\ndata: {}\n\n');
    raw.end();
  }
}
