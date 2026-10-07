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
export default class A2aProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<A2aConfig | undefined>('a2a', undefined);
    if (!config) return;

    const server = await this.app.container.make('server');
    server.use([() => import('../src/a2a/server_middleware.js')]);

    // Built on the first A2A request: the agent provider binds `AgentService` in its own boot, and
    // the auth driver may need a fully booted app. A failed build is retried on the next request.
    let built: Promise<A2aRequestHandler> | null = null;
    setA2aHandler(async (ctx) => {
      if (built === null) {
        built = this.#build(config);
        built.catch(() => {
          built = null;
        });
      }
      return (await built)(ctx);
    });
  }

  async shutdown() {
    setA2aHandler(null);
  }

  async #build(config: A2aConfig): Promise<A2aRequestHandler> {
    const registry = await this.app.container.make(ToolRegistry);
    const service = await this.app.container.make(AgentService);
    const auth = await resolveA2aAuth(config.auth, { app: this.app });

    const scopes = await auth.delegableScopes();
    if (Object.keys(scopes).length > 0) registerRequestPermissionTool(registry, scopes);

    const brands = new Map<string, A2aBrand>(
      Object.entries(config.agents).map(([id, agent]) => [
        id,
        { id, agentName: agent.agent ?? id, card: agent.card },
      ]),
    );

    return createA2aHandler({
      path: (config.path ?? 'a2a').replace(/^\/+|\/+$/g, ''),
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
