import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  type AgentDashboardAuthorize,
  type AgentDashboardUnauthenticatedHook,
  answerDashboardDenial,
  apiBaseFor,
  contentTypeFor,
  type DashboardDenialOptions,
  decideDashboardMount,
  evaluateDashboardGate,
  injectApiBase,
  injectBaseHref,
  mountPathFor,
  resolveDashboardConfig,
  safeAssetSegments,
} from '../src/dashboard/index.js';
import type { AgentConfig } from '../src/define_config.js';
import type { ActorResolver } from '../src/spi/actor-resolver.js';

/**
 * Serves the `@adonis-agora/agent-dashboard` governance SPA **from this package's own build** — no
 * separate install, no separate provider registration. `node ace configure @adonis-agora/agent`
 * registers this provider alongside `agent_provider`, and the SPA it serves is bundled straight into
 * `@adonis-agora/agent`'s own `dist/` at build time (`package.json`'s `copy:stubs` copies
 * `../dashboard/dist/spa`, the `@adonis-agora/agent-dashboard` package's `vite build` output, into
 * `dist/assets/spa`) — mirrors `@adonis-agora/durable`'s `dashboard_provider.ts` /
 * `src/dashboard/spa.ts` split, which does the identical thing for its own dashboard.
 *
 * The routing/gating logic here is BYTE-FOR-BYTE the same as `@adonis-agora/agent-dashboard`'s own
 * `agent_dashboard_provider.ts` — both call the SAME shared helpers from `../src/dashboard/index.js`
 * (`decideDashboardMount`, `evaluateDashboardGate`, the path/content-type helpers). The two providers
 * differ only in WHERE they read the built `index.html`/assets from: this one reads its own
 * `dist/assets/spa` (copied in at build time); the standalone provider reads
 * `@adonis-agora/agent-dashboard`'s own `dist/spa`.
 *
 * Why the logic lives HERE rather than in `@adonis-agora/agent-dashboard` (which would let this
 * provider stay a one-line re-export): `@adonis-agora/agent-dashboard` already depends on
 * `@adonis-agora/agent` (its provider imports `AgentConfig`/`ActorResolver`), so a dependency the
 * other way — this package depending on the dashboard package's code at runtime — would be circular,
 * and in this monorepo it would ALSO be a real `turbo`/pnpm build cycle (the dashboard package's own
 * build needs `@adonis-agora/agent` built first, to typecheck its provider against it). Keeping the
 * shared logic in `src/dashboard/` (owned by this package) avoids the cycle exactly the way
 * `@adonis-agora/durable` avoids it — by owning its `spa.ts` serving helpers directly rather than
 * depending on `@adonis-agora/durable-dashboard` for anything but the BUILT ASSET FILES (a
 * build-time-only, one-directional filesystem copy in `copy:stubs`, no package.json dependency at
 * all — see that script for how the dashboard's SPA output is located: a plain relative path,
 * `../dashboard/dist/spa`, resolved by directory layout, not by module resolution).
 *
 * `@adonis-agora/agent-dashboard`'s own provider keeps working entirely unchanged for apps that
 * already install and register it directly (e.g. on an older `@adonis-agora/agent` version, or where
 * an app wants the standalone package's independent versioning/release cadence) — this provider is
 * purely additive. An app that registers BOTH providers with the same mount path will hit AdonisJS's
 * "duplicate route" error at boot; pick one (this is the intended migration signal, not a bug).
 *
 * Routes (mount = `<agentPath>/dashboard`, default `/agent/dashboard`) — identical to the standalone
 * provider's:
 * - `GET <mount>`   → the SPA shell (`index.html`, with the resolved API base + `<base href>` injected)
 * - `GET <mount>/*` → a built asset, or the SPA shell as a fallback (client-rendered console)
 *
 * Nothing mounts unless the agent config carries a `governanceAuthorize` gate: without it the
 * `/agent/governance/*` routes the console reads do not exist, so the console would load and fail on
 * every panel but Quota. The provider declines and logs why (see `decideDashboardMount`).
 *
 * Enable/disable and override the mount via the optional `config('agent').dashboard` block — the SAME
 * block the standalone provider reads.
 */
export default class DashboardProvider {
  constructor(protected app: ApplicationService) {}

  /**
   * Directory of the built SPA (`dist/assets/spa`, copied in by `copy:stubs` — see `package.json`),
   * relative to this compiled provider (`dist/providers`). Resolved lazily (not at module scope):
   * `fileURLToPath` throws on any non-`file:` `import.meta.url`, which would make this provider
   * unimportable under a test runner that doesn't use real file URLs.
   */
  #spaDir: string | undefined;
  #spaDirectory(): string {
    this.#spaDir ??= fileURLToPath(new URL('../assets/spa/', import.meta.url));
    return this.#spaDir;
  }

  async boot() {
    const agentConfig = this.app.config.get<AgentConfig>('agent', {} as AgentConfig);
    // Read off the typed `AgentConfig` (the `dashboard` key is part of it) rather than through an
    // untyped `config.get('agent.dashboard')` string path, so `config/agent.ts` type-checks the block.
    const dashboardConfig = resolveDashboardConfig(agentConfig.dashboard);

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
    const router = await this.app.container.make('router');

    const agentPath = agentConfig.path ?? 'agent';
    const apiBase = apiBaseFor(agentPath);
    const mount = mountPathFor(agentPath, dashboardConfig.path);
    const actorResolver = agentConfig.actorResolver;

    const authorize = dashboardConfig.authorize;
    // What a refused browser sees — the built-in access-denied page unless the host customised it.
    const denial: DashboardDenialOptions = {
      basePath: mount,
      accessDenied: dashboardConfig.accessDenied,
    };

    // The SPA shell, served at the bare mount. We do NOT redirect to a trailing-slash variant: the
    // AdonisJS router normalizes trailing slashes, so `mount` and `${mount}/` are the SAME route
    // pattern — registering both throws "Duplicate route". Instead `sendIndex` injects a
    // `<base href="${mount}/">`, so the SPA's relative `./assets/*` URLs resolve against the mount
    // directory regardless of whether the browser's URL carries a trailing slash.
    router.get(mount, async (ctx) => {
      if (
        !(await this.#gate(
          ctx,
          actorResolver,
          authorize,
          dashboardConfig.onUnauthenticated,
          denial,
        ))
      )
        return;
      await this.#sendIndex(ctx, apiBase, mount);
    });

    // Built assets (JS/CSS/fonts/...), with an index fallback for any unmatched path so the
    // client-rendered console still boots on a deep link.
    router.get(`${mount}/*`, async (ctx) => {
      if (
        !(await this.#gate(
          ctx,
          actorResolver,
          authorize,
          dashboardConfig.onUnauthenticated,
          denial,
        ))
      )
        return;
      const segments = safeAssetSegments(ctx.params['*']);
      if (segments === null) {
        return ctx.response.status(400).json({ error: 'bad asset path' });
      }
      await this.#sendAsset(ctx, segments, apiBase, mount);
    });
  }

  /**
   * Resolve the actor through the agent config's resolver, mirroring the governance routes, then run
   * the optional `authorize` gate. Returns `true` to proceed; replies `401` on a missing/failed
   * resolver and `403` when `authorize` denies the resolved actor. The decision itself lives in the
   * router-free {@link evaluateDashboardGate} so it can be unit tested; this only writes the response
   * — the access-denied PAGE (a browser is what hits these routes), via the shared
   * {@link answerDashboardDenial} — and, mirroring `@adonis-agora/durable`'s dashboard, ONLY when
   * neither `onUnauthenticated` nor `authorize` already answered the request themselves: if either
   * set a `location` header (typically via `ctx.response.redirect(...)`, e.g. to the app's own login
   * page), that redirect stands and this skips writing its own `401`/`403` page on top of it.
   */
  async #gate(
    ctx: HttpContext,
    actorResolver: ActorResolver | undefined,
    authorize: AgentDashboardAuthorize | undefined,
    onUnauthenticated: AgentDashboardUnauthenticatedHook | undefined,
    denial: DashboardDenialOptions,
  ): Promise<boolean> {
    const verdict = await evaluateDashboardGate(
      ctx,
      actorResolver,
      authorize,
      !this.app.inProduction,
      onUnauthenticated,
    );
    if (!verdict.ok) {
      await answerDashboardDenial(ctx, verdict, denial);
      return false;
    }
    return true;
  }

  /**
   * Read `dist/assets/spa/index.html`, inject the `<base href>` (so relative `./assets/*` resolve
   * against the mount dir) and the API base, and send it.
   */
  async #sendIndex(ctx: HttpContext, apiBase: string, mount: string): Promise<void> {
    const html = await readFile(resolvePath(this.#spaDirectory(), 'index.html'), 'utf8');
    ctx.response.header('content-type', 'text/html; charset=utf-8');
    ctx.response.header('cache-control', 'no-store, must-revalidate');
    ctx.response.send(injectApiBase(injectBaseHref(html, mount), apiBase));
  }

  /** Send the requested built asset, or fall back to the SPA shell when it does not exist. */
  async #sendAsset(
    ctx: HttpContext,
    segments: string[],
    apiBase: string,
    mount: string,
  ): Promise<void> {
    const filename = segments[segments.length - 1] ?? 'index.html';
    try {
      const buffer = await readFile(resolvePath(this.#spaDirectory(), ...segments));
      ctx.response.header('content-type', contentTypeFor(filename));
      ctx.response.send(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#sendIndex(ctx, apiBase, mount);
        return;
      }
      throw error;
    }
  }
}
