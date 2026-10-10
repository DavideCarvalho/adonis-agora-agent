import type { ApplicationService } from '@adonisjs/core/types';
import type { A2aTurnService } from '../src/a2a/turn.js';
import { AgentService } from '../src/agent-service.js';
import { globalPoppyAuthenticate } from '../src/poppy/auth.js';
import { PoppyConversations } from '../src/poppy/conversations.js';
import type { PoppyConfig } from '../src/poppy/define_config.js';
import { announcePoppyEndpoints, poppyConversationsUrl } from '../src/poppy/endpoints.js';
import { adonisExchange, createPoppyHandler } from '../src/poppy/handler.js';
import { type PoppyRequestHandler, setPoppyHandler } from '../src/poppy/runtime.js';
import { InMemoryPoppyStore, LucidPoppyStore, type PoppyStore } from '../src/poppy/store.js';
import { ToolRegistry } from '../src/tool-registry.js';

/**
 * Exposes a registered agent as the Company Agent of Personal Agent Protocol ("Poppy", Draft 0.1)
 * conversations (§7). Reads `config/poppy.ts` and answers, under its `path`:
 *
 * - `POST {path}` — start a conversation (or a Direct Conversation) with its first message;
 * - `POST {path}/{id}/messages` — another message;
 * - `GET {path}/{id}/events` — read events (cursor, `wait`), or stream them as SSE;
 * - `POST {path}/{id}/handoff`, `POST {path}/{id}/close`.
 *
 * Mounted as SERVER middleware, ahead of the router, like the A2A surface: requests are
 * authenticated by their Session Token before the body is read, and never reach the bodyparser,
 * session or CSRF. `PoppyConversations` is bound in the container — the app drives the Company
 * side through it (a person joining, `user_requested`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
function normalizePath(path: string | undefined): string {
  return (path ?? 'poppy/conversations').replace(/^\/+|\/+$/g, '');
}

/** The config, or `undefined` when the surface is off (a module whose default is `undefined`). */
function poppyConfigOf(app: ApplicationService): PoppyConfig | undefined {
  const config = app.config.get<PoppyConfig | undefined>('poppy', undefined);
  if (!config || typeof config !== 'object') return undefined;
  // A feature-flagged-off `config/poppy.ts` reaches the store as its module namespace.
  if ('default' in config && Object.keys(config).length === 1) return undefined;
  return config;
}

export default class PoppyProvider {
  #conversations: Promise<PoppyConversations> | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    const config = poppyConfigOf(this.app);
    if (!config) return;
    this.app.container.singleton(PoppyConversations, () => this.#conversationsFor(config));
  }

  async boot() {
    const config = poppyConfigOf(this.app);
    if (!config) return;

    const server = await this.app.container.make('server');
    server.use([() => import('../src/poppy/server_middleware.js')]);

    const path = normalizePath(config.path);
    const prefix = `/${path}`;

    // Tell an authorization server in this process (authkit) where conversations are, for
    // `poppy.json`. Only with `baseUrl`: an absolute URL cannot be known before a request.
    if (config.baseUrl !== undefined) {
      announcePoppyEndpoints({ conversations: poppyConversationsUrl(config.baseUrl, path) });
    }
    const isPoppy = (url: string) => url === prefix || url.startsWith(`${prefix}/`);

    // Built on the first Poppy request: the agent provider binds `AgentService` in its own boot.
    // A failed build is retried on the next one; only Poppy traffic ever touches it.
    let built: Promise<PoppyRequestHandler> | null = null;
    setPoppyHandler(async (ctx) => {
      if (!isPoppy((ctx.request.url() ?? '').split('?')[0]?.replace(/\/+$/, '') ?? '')) {
        return false;
      }
      if (built === null) {
        built = this.#build(config, path);
        built.catch(() => {
          built = null;
        });
      }
      return (await built)(ctx);
    });
  }

  /** Warn, once the app is up, when no one can verify a Session Token: every request is a 501. */
  async ready() {
    const config = poppyConfigOf(this.app);
    if (!config || config.authenticate !== undefined || globalPoppyAuthenticate()) return;
    const logger = await this.app.container.make('logger');
    logger.warn(
      'poppy: no Session Token resolver — install @adonis-agora/authkit-server with Poppy enabled, or set `authenticate` in config/poppy.ts. Until then the endpoint answers 501.',
    );
  }

  async shutdown() {
    setPoppyHandler(null);
    if (this.#conversations !== null) (await this.#conversations.catch(() => null))?.shutdown();
  }

  #conversationsFor(config: PoppyConfig): Promise<PoppyConversations> {
    if (this.#conversations === null) {
      this.#conversations = this.#createConversations(config);
      this.#conversations.catch(() => {
        this.#conversations = null;
      });
    }
    return this.#conversations;
  }

  async #createConversations(config: PoppyConfig): Promise<PoppyConversations> {
    const registry = await this.app.container.make(ToolRegistry);
    const service: A2aTurnService =
      config.service === undefined
        ? await this.app.container.make(AgentService)
        : typeof config.service === 'function'
          ? await config.service({ app: this.app })
          : config.service;
    const logger = await this.app.container.make('logger');
    return new PoppyConversations({
      store: await this.#store(config),
      service,
      toolRoles: (name) => service.toolRoles?.(name) ?? registry.spec(name)?.roles,
      ...(config.agent !== undefined ? { agentName: config.agent } : {}),
      actions: config.actions ?? 'approve-delegated',
      timeoutMs: config.timeoutMs ?? 120_000,
      drive: config.drive ?? true,
      ...(config.actorFor !== undefined ? { actorFor: config.actorFor } : {}),
      ...(config.handoff !== undefined ? { handoff: config.handoff } : {}),
      ...(config.direct !== undefined ? { direct: config.direct } : {}),
      ...(config.texts !== undefined ? { texts: config.texts } : {}),
      ...(config.retentionMs !== undefined ? { retentionMs: config.retentionMs } : {}),
      onError: (error, context) => logger.error({ err: error }, context),
    });
  }

  async #build(config: PoppyConfig, path: string): Promise<PoppyRequestHandler> {
    const conversations = await this.app.container.make(PoppyConversations);
    const logger = await this.app.container.make('logger');
    const handle = createPoppyHandler({
      path,
      conversations,
      ...(config.authenticate !== undefined ? { authenticate: config.authenticate } : {}),
      maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
      maxWaitSeconds: config.maxWaitSeconds ?? 30,
      streamMaxMs: config.streamMaxMs ?? 300_000,
      onError: (error) => logger.error({ err: error }, 'poppy: request failed'),
    });
    return (ctx) =>
      handle(adonisExchange(ctx, config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}));
  }

  async #store(config: PoppyConfig): Promise<PoppyStore> {
    const store = config.store ?? 'lucid';
    if (typeof store === 'object') return store;
    if (store === 'memory') return new InMemoryPoppyStore();
    const db = (await this.app.container.make('lucid.db' as never)) as {
      connection(name?: string): ConstructorParameters<typeof LucidPoppyStore>[0];
    };
    const lucid = new LucidPoppyStore(db.connection(config.connection), {
      ...(config.autoCreateTables !== undefined
        ? { autoCreateTables: config.autoCreateTables }
        : {}),
    });
    await lucid.ready();
    return lucid;
  }
}
