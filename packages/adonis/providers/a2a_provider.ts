import type { ApplicationService } from '@adonisjs/core/types';
import { resolveA2aAuth } from '../src/a2a/auth.js';
import type { A2aConfig } from '../src/a2a/define_config.js';
import { type A2aBrand, createA2aHandler } from '../src/a2a/handler.js';
import { registerRequestPermissionTool } from '../src/a2a/permission-tool.js';
import { type A2aRequestHandler, setA2aHandler } from '../src/a2a/runtime.js';
import {
  type A2aStore,
  ensureA2aTables,
  InMemoryA2aStore,
  LucidA2aStore,
} from '../src/a2a/store.js';
import { AgentService } from '../src/agent-service.js';
import { ToolRegistry } from '../src/tool-registry.js';

/**
 * Exposes registered agents to personal agents over A2A 1.0 (HTTP+JSON) — the transport of PACT.
 * Reads `config/a2a.ts` and answers, for each configured agent:
 *
 * - `GET /{path}/{agent}/.well-known/agent-card.json` — the Agent Card (public).
 * - `POST /{path}/{agent}/message:send` — a synchronous turn (identity, and delegation when sent).
 * - `GET /{path}/{agent}/tasks`, `GET …/tasks/{id}`, `POST …/tasks/{id}:cancel` — as PACT §2.2 fixes.
 *
 * Mounted as SERVER middleware, ahead of the router: A2A requests never reach the bodyparser,
 * session or CSRF (see `src/a2a/server_middleware.ts`). Everything is resolved on the first A2A
 * request, so this provider can sit anywhere in `adonisrc.ts`.
 */
function normalizePath(path: string | undefined): string {
  return (path ?? 'a2a').replace(/^\/+|\/+$/g, '');
}

/**
 * The A2A config, or `undefined` when the surface is off. A `config/a2a.ts` whose default export
 * is `undefined` (feature-flagged off) reaches the config store as its module namespace
 * (`{ default: undefined }`), not as `undefined`.
 */
function a2aConfigOf(app: ApplicationService): A2aConfig | undefined {
  const config = app.config.get<A2aConfig | undefined>('a2a', undefined);
  return config && typeof config === 'object' && config.agents && config.auth ? config : undefined;
}

export default class A2aProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = a2aConfigOf(this.app);
    if (!config) return;

    const server = await this.app.container.make('server');
    server.use([() => import('../src/a2a/server_middleware.js')]);

    // Only A2A traffic ever touches the A2A runtime: a broken auth driver or database must not
    // turn every route of the app into a 500.
    const prefix = `/${normalizePath(config.path)}/`;
    const isA2a = (url: string) =>
      url.startsWith(prefix) ||
      (config.rootCard !== undefined && url === '/.well-known/agent-card.json');

    // Built on the first A2A request: the agent provider binds `AgentService` in its own boot, and
    // the auth driver may need a fully booted app. A failed build is retried on the next one.
    let built: Promise<A2aRequestHandler> | null = null;
    setA2aHandler(async (ctx) => {
      if (!isA2a((ctx.request.url() ?? '').split('?')[0] ?? '')) return false;
      if (built === null) {
        built = this.#build(config);
        built.catch(() => {
          built = null;
        });
      }
      return (await built)(ctx);
    });
  }

  /**
   * Register `request_permission` in every process — a queue or durable worker that replays a turn
   * which called it needs the tool as much as the web process that started it.
   */
  async ready() {
    const config = a2aConfigOf(this.app);
    if (!config) return;
    try {
      await this.#registerPermissionTool(config);
    } catch (error) {
      const logger = await this.app.container.make('logger');
      logger.warn({ err: error }, 'a2a: could not register request_permission yet');
    }
  }

  async shutdown() {
    setA2aHandler(null);
  }

  #permissionToolRegistered = false;

  async #registerPermissionTool(config: A2aConfig): Promise<void> {
    // With its own runtime the app registers `request_permission` where ITS tools live
    // (`registerRequestPermissionTool`) — the shared registry may be another surface's.
    if (this.#permissionToolRegistered || config.service !== undefined) return;
    const auth = await resolveA2aAuth(config.auth, { app: this.app });
    const scopes = await auth.delegableScopes();
    if (Object.keys(scopes).length > 0) {
      registerRequestPermissionTool(await this.app.container.make(ToolRegistry), scopes);
    }
    this.#permissionToolRegistered = true;
  }

  async #build(config: A2aConfig): Promise<A2aRequestHandler> {
    const registry = await this.app.container.make(ToolRegistry);
    const service =
      config.service === undefined
        ? await this.app.container.make(AgentService)
        : typeof config.service === 'function'
          ? await config.service({ app: this.app })
          : config.service;
    const auth = await resolveA2aAuth(config.auth, { app: this.app });

    await this.#registerPermissionTool(config);

    const brands = new Map<string, A2aBrand>(
      Object.entries(config.agents).map(([id, agent]) => [
        id,
        { id, agentName: agent.agent ?? id, card: agent.card },
      ]),
    );

    return createA2aHandler({
      path: normalizePath(config.path),
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      brands,
      ...(config.rootCard !== undefined ? { rootCardBrand: config.rootCard } : {}),
      auth,
      store: await this.#store(config),
      service,
      registry,
      actions: config.actions ?? 'approve-delegated',
      timeoutMs: config.timeoutMs ?? 120_000,
      maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
      ...(config.roles !== undefined ? { roles: config.roles } : {}),
      ...(config.actor !== undefined ? { actor: config.actor } : {}),
    });
  }

  async #store(config: A2aConfig): Promise<A2aStore> {
    const store = config.store ?? 'lucid';
    if (typeof store === 'object') return store;
    if (store === 'memory') return new InMemoryA2aStore();
    const db = (await this.app.container.make('lucid.db' as never)) as {
      connection(
        name?: string,
      ): ConstructorParameters<typeof LucidA2aStore>[0] & Parameters<typeof ensureA2aTables>[0];
    };
    const connection = db.connection(config.connection);
    await ensureA2aTables(connection);
    return new LucidA2aStore(connection);
  }
}
