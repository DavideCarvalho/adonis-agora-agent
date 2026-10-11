import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { AgentService } from '../src/agent-service.js';
import type { PoppyConnectionsConfig } from '../src/poppy-connections/config.js';
import {
  createPoppyConnectionsHandler,
  type PoppyConnectRenderer,
} from '../src/poppy-connections/http.js';
import { resumeAfterConnect } from '../src/poppy-connections/resume.js';
import { setPoppyConnectionsHandler } from '../src/poppy-connections/runtime.js';
import { PoppyConnections } from '../src/poppy-connections/service.js';
import {
  InMemoryPoppyConnectionStore,
  LucidPoppyConnectionStore,
  type PoppyConnectionStore,
  type PoppyPendingConnect,
} from '../src/poppy-connections/store.js';
import { registerPoppyConnectionTools } from '../src/poppy-connections/tools.js';
import { ToolRegistry } from '../src/tool-registry.js';

type Config = PoppyConnectionsConfig & { render?: PoppyConnectRenderer };

function configOf(app: ApplicationService): Config | undefined {
  const config = app.config.get<Config | undefined>('poppy_connections', undefined);
  if (!config || typeof config !== 'object') return undefined;
  if ('default' in config && Object.keys(config).length === 1) return undefined;
  return config;
}

/**
 * This app's agent working with OTHER Poppy Companies for its users (`config/poppy_connections.ts`):
 * the agent identity routes, the connect pages and callback, the `poppy_*` tools, and — when the
 * config has `api` — `GET/DELETE {path}/api/connections` for the app's own settings UI.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 — will change as the spec evolves.
 */
export default class PoppyConnectionsProvider {
  #service: Promise<PoppyConnections> | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    const config = configOf(this.app);
    if (!config) return;
    this.app.container.singleton(PoppyConnections, () => this.#serviceFor(config));
  }

  async boot() {
    const config = configOf(this.app);
    if (!config) return;
    const connections = await this.app.container.make(PoppyConnections);
    const registry = await this.app.container.make(ToolRegistry);
    registerPoppyConnectionTools(registry, connections, config.tools ?? {});

    const logger = await this.app.container.make('logger');
    const handle = createPoppyConnectionsHandler(connections, {
      ...(config.render !== undefined ? { render: config.render } : {}),
      onError: (error) => logger.error({ err: error }, 'poppy-connections: request failed'),
    });
    const server = await this.app.container.make('server');
    server.use([() => import('../src/poppy-connections/server_middleware.js')]);
    setPoppyConnectionsHandler((ctx) => handle(exchange(ctx)));

    const api = config.api;
    if (api) {
      const router = await this.app.container.make('router');
      const base = `/${connections.path}/api/connections`;
      const who = async (ctx: HttpContext) => {
        const actor = await api.actor(ctx);
        if (!actor) ctx.response.unauthorized({ error: 'unauthorized' });
        return actor;
      };
      router
        .get(base, async (ctx: HttpContext) => {
          const actor = await who(ctx);
          if (!actor) return;
          return { connections: await connections.list(connections.ownerOf(actor)) };
        })
        .as('poppy_connections.list');
      router
        .delete(`${base}/:domain`, async (ctx: HttpContext) => {
          const actor = await who(ctx);
          if (!actor) return;
          const removed = await connections.disconnect(
            connections.ownerOf(actor),
            String(ctx.params.domain),
          );
          return { disconnected: removed };
        })
        .as('poppy_connections.disconnect');
    }
  }

  async shutdown() {
    setPoppyConnectionsHandler(null);
  }

  #serviceFor(config: Config): Promise<PoppyConnections> {
    if (this.#service === null) {
      this.#service = this.#create(config);
      this.#service.catch(() => {
        this.#service = null;
      });
    }
    return this.#service;
  }

  async #create(config: Config): Promise<PoppyConnections> {
    const logger = await this.app.container.make('logger');
    const appKey = this.app.config.get<unknown>('app.appKey');
    const secret =
      config.secret ??
      (typeof (appKey as { release?: () => string })?.release === 'function'
        ? (appKey as { release: () => string }).release()
        : String(appKey ?? ''));
    return new PoppyConnections({
      config,
      store: await this.#store(config),
      secret,
      production: this.app.inProduction,
      onConnected: (pending) => this.#resume(pending),
      log: (line) => logger.warn(line),
    });
  }

  async #store(config: Config): Promise<PoppyConnectionStore> {
    const store = config.store ?? 'lucid';
    if (typeof store === 'object') return store;
    if (store === 'memory') return new InMemoryPoppyConnectionStore();
    const db = (await this.app.container.make('lucid.db' as never)) as {
      connection(name?: string): ConstructorParameters<typeof LucidPoppyConnectionStore>[0];
    };
    return new LucidPoppyConnectionStore(db.connection(config.connection), {
      ...(config.autoCreateTables !== undefined
        ? { autoCreateTables: config.autoCreateTables }
        : {}),
    });
  }

  async #resume(pending: PoppyPendingConnect): Promise<void> {
    await resumeAfterConnect(await this.app.container.make(AgentService), pending);
  }
}

function exchange(ctx: HttpContext) {
  const original = ctx.request.url(true) ?? ctx.request.url() ?? '/';
  const target = new URL(original, 'http://local/');
  return {
    method: ctx.request.method(),
    path: target.pathname,
    query: target.searchParams,
    async readBody(limit: number): Promise<string> {
      const raw = (ctx.request as { raw?: () => string | null }).raw?.();
      if (typeof raw === 'string') return raw;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of ctx.request.request) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new Error('body too large');
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    send(status: number, headers: Record<string, string>, body: string) {
      ctx.response.status(status);
      for (const [name, value] of Object.entries(headers)) ctx.response.header(name, value);
      ctx.response.send(body);
    },
  };
}
