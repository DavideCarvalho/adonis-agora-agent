import { readFile } from 'node:fs/promises';
import type { ActorResolver, AgentConfig } from '@adonis-agora/agent';
import {
  type AgentDashboardAuthorize,
  type AgentDashboardConfig,
  apiBaseFor,
  contentTypeFor,
  decideDashboardMount,
  evaluateDashboardGate,
  injectApiBase,
  injectBaseHref,
  mountPathFor,
  resolveDashboardConfig,
  safeAssetSegments,
} from '@adonis-agora/agent/dashboard';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';

/**
 * Serves the `@adonis-agora/agent-dashboard` governance SPA (a Vite build in `dist/spa`) as static
 * assets under `<agentPath>/dashboard`, behind the SAME actor gating as the agent's governance
 * routes: every request resolves the actor through the agent config's `actorResolver`, replying `401`
 * on failure (an app that never configured a resolver exposes nothing — identical to the
 * `/agent/governance/*` routes). This is a thin, idiomatic AdonisJS static server — no NestJS module,
 * no bundled API. The SPA calls the agent's own real read routes.
 *
 * Routes (mount = `<agentPath>/dashboard`, default `/agent/dashboard`):
 * - `GET <mount>`      → `302` to `<mount>/` (canonical trailing slash so relative assets resolve)
 * - `GET <mount>/`     → the SPA shell (`index.html`, with the resolved API base injected)
 * - `GET <mount>/*`    → a built asset, or the SPA shell as a fallback (client-rendered console)
 *
 * Nothing mounts unless the agent config carries a `governanceAuthorize` gate: without it the
 * `/agent/governance/*` routes the console reads do not exist, so the console would load and fail on
 * every panel but Quota. The provider declines and logs why (see `decideDashboardMount`).
 *
 * Enable/disable and override the mount via the optional `config('agent').dashboard` block.
 *
 * As of `@adonis-agora/agent@0.21.0`, THIS is no longer the only way to get the console: the agent
 * package now ALSO ships its own embedded `@adonis-agora/agent/dashboard_provider`, wired
 * automatically by `node ace configure @adonis-agora/agent`, that serves the identical SPA bundled
 * straight into `@adonis-agora/agent`'s own `dist/`. This standalone package keeps working exactly as
 * before for apps that already install and register it directly — nothing here changed except WHERE
 * the shared config/gate/path logic lives (`@adonis-agora/agent/dashboard`, imported above, rather
 * than a local `src/server/*` copy) so both providers stay byte-for-byte identical in behavior. An
 * app should register ONE of the two: registering both at the same mount path throws AdonisJS's
 * "duplicate route" error at boot.
 */
export default class AgentDashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** The built SPA directory (`dist/spa`) as a `file://` URL, next to this compiled provider. */
  private spaDirUrl = new URL('../spa/', import.meta.url);

  async boot() {
    const agentConfig = this.app.config.get<AgentConfig>('agent', {} as AgentConfig);
    const dashboardConfig = resolveDashboardConfig(
      this.app.config.get<AgentDashboardConfig>('agent.dashboard', {}),
    );

    // Mount only when the console can actually work: every panel but Quota reads the agent's
    // cross-actor `/agent/governance/*` routes, and those do not exist without a `governanceAuthorize`
    // gate. Refusing here — loudly — beats serving a shell that 404s its own data with no explanation.
    const decision = decideDashboardMount(
      dashboardConfig.enabled,
      agentConfig.governanceAuthorize,
      agentConfig.governanceQueries,
    );
    if (!decision.mount) {
      if (decision.reason !== 'disabled') console.warn(decision.warning);
      return;
    }

    // Resolve the router from the container, NOT from `@adonisjs/core/services/router`: that service's
    // default export is assigned inside an `app.booted()` hook, which runs AFTER every provider's
    // `boot()` — so at this point the module default is still `undefined` and `router.get(...)` throws.
    // The container binding is available now (mirrors how the agent provider registers its routes).
    const router = await this.app.container.make('router');

    const agentPath = agentConfig.path ?? 'agent';
    const apiBase = apiBaseFor(agentPath);
    const mount = mountPathFor(agentPath, dashboardConfig.path);
    const actorResolver = agentConfig.actorResolver;

    const authorize = dashboardConfig.authorize;

    // The SPA shell, served at the bare mount. We do NOT redirect to a trailing-slash variant: the
    // AdonisJS router normalizes trailing slashes, so `mount` and `${mount}/` are the SAME route
    // pattern — registering both throws "Duplicate route". Instead `sendIndex` injects a
    // `<base href="${mount}/">`, so the SPA's relative `./assets/*` URLs resolve against the mount
    // directory regardless of whether the browser's URL carries a trailing slash.
    router.get(mount, async (ctx) => {
      if (!(await this.gate(ctx, actorResolver, authorize))) return;
      await this.sendIndex(ctx, apiBase, mount);
    });

    // Built assets (JS/CSS/fonts/...), with an index fallback for any unmatched path so the
    // client-rendered console still boots on a deep link.
    router.get(`${mount}/*`, async (ctx) => {
      if (!(await this.gate(ctx, actorResolver, authorize))) return;
      const segments = safeAssetSegments(ctx.params['*']);
      if (segments === null) {
        return ctx.response.status(400).json({ error: 'bad asset path' });
      }
      await this.sendAsset(ctx, segments, apiBase, mount);
    });
  }

  /**
   * Resolve the actor through the agent config's resolver, mirroring the governance routes, then run
   * the optional `authorize` gate. Returns `true` to proceed; replies `401` on a missing/failed
   * resolver and `403` when `authorize` denies the resolved actor. The decision itself lives in the
   * router-free {@link evaluateDashboardGate} so it can be unit tested; this only writes the response.
   */
  private async gate(
    ctx: HttpContext,
    actorResolver: ActorResolver | undefined,
    authorize?: AgentDashboardAuthorize,
  ): Promise<boolean> {
    const verdict = await evaluateDashboardGate(ctx, actorResolver, authorize);
    if (!verdict.ok) {
      ctx.response.status(verdict.status).json({ error: verdict.error });
      return false;
    }
    return true;
  }

  /**
   * Read `dist/spa/index.html`, inject the `<base href>` (so relative `./assets/*` resolve against
   * the mount dir) and the API base, and send it.
   */
  private async sendIndex(ctx: HttpContext, apiBase: string, mount: string): Promise<void> {
    const html = await readFile(new URL('index.html', this.spaDirUrl), 'utf8');
    ctx.response.header('content-type', 'text/html; charset=utf-8');
    ctx.response.header('cache-control', 'no-store, must-revalidate');
    ctx.response.send(injectApiBase(injectBaseHref(html, mount), apiBase));
  }

  /** Send the requested built asset, or fall back to the SPA shell when it does not exist. */
  private async sendAsset(
    ctx: HttpContext,
    segments: string[],
    apiBase: string,
    mount: string,
  ): Promise<void> {
    const filename = segments[segments.length - 1] ?? 'index.html';
    try {
      const buffer = await readFile(new URL(segments.join('/'), this.spaDirUrl));
      ctx.response.header('content-type', contentTypeFor(filename));
      ctx.response.send(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.sendIndex(ctx, apiBase, mount);
        return;
      }
      throw error;
    }
  }
}
