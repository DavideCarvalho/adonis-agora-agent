import type { HttpContext } from '@adonisjs/core/http';
import type { AgentConsoleAuthorize } from '../console-authorize.js';
import type { Actor } from '../types.js';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import type { ConsoleViewer, SignOutOption, ViewerHook } from './console_shell.js';

export type { ConsoleViewer, SignOutOption, ViewerHook };

/**
 * The function form of {@link AgentDashboardConfig.accessDenied}: render (or answer) a refused
 * page navigation yourself. Receives the refusal ({@link AccessDeniedInfo}) and the AdonisJS
 * {@link HttpContext}. Return an HTML string to have it served; answer the request yourself (a
 * redirect, most commonly) and return nothing to make the provider stand down; return nothing
 * WITHOUT answering and the built-in page is served.
 */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<HttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<HttpContext>;

/**
 * Who may use the agent console — the SPA shell and the cross-actor `/agent/governance/*` routes it
 * reads. The shared console `authorize` contract, in any of its three forms:
 *
 * - an inline function `(ctx) => result` — the resolved {@link Actor} comes as an optional second
 *   argument, `(ctx, actor) => ...`; `authorizeByRoles({ roles: ['ADMIN'] })` from
 *   `@adonis-agora/authz` and `authorizeByToken({ token })` work as they are;
 * - an authorizer class with `authorize(ctx, actor?)`, built through the container (`@inject()` works);
 * - a lazy import, `() => import('#policies/console_access')`, whose default export is that class.
 *
 * Results: `true` / `{ allowed: true }` → allowed; `false`, `{ allowed: false }` or `reason:
 * 'forbidden'` → `403`; `{ allowed: false, reason: 'unauthenticated' }` → `401`; `{ redirectTo }` → a
 * redirect for a page, `401` for an API call; throwing → `403`. If the hook answers the request
 * itself (e.g. `ctx.response.redirect('/login')`), that answer is kept.
 */
export type AgentDashboardAuthorize = AgentConsoleAuthorize;

/**
 * Optional `config('agent').dashboard` block. The dashboard reuses the agent config's `path` and
 * `actorResolver`; this block toggles it on/off, optionally overrides the mount path, and sets the
 * `authorize` that gates both the console and the `/agent/governance/*` routes it reads.
 *
 * Shared by BOTH the embedded dashboard provider (`@adonis-agora/agent/dashboard_provider`, wired
 * automatically when you `node ace configure @adonis-agora/agent`) and the standalone
 * `@adonis-agora/agent-dashboard` package's provider — one config block controls whichever one is
 * registered.
 */
export interface AgentDashboardConfig {
  /**
   * Mount the SPA. Default `true` — set `false` to keep it off. (It also stays off when
   * `governanceQueries: false` removes the data it reads, see {@link decideDashboardMount}.)
   */
  enabled?: boolean;
  /** Override the mount path. Default `<agentPath>/dashboard`. */
  path?: string;
  /**
   * Who may use the console: gates the SPA shell AND the `/agent/governance/*` routes it reads, and,
   * when set, also lets the actors it allows act on other actors' runs and threads. An inline
   * function, an authorizer class, or a lazy import of one — see {@link AgentDashboardAuthorize}.
   *
   * Omitted: open outside production; in production every console request is refused with `403`,
   * and a warning is logged at boot. `GET <path>/approvals/mine` is never gated by it.
   */
  authorize?: AgentDashboardAuthorize;
  /**
   * What a BROWSER sees when the gate refuses a page navigation to the SPA (API calls get JSON).
   * Omit it for the built-in page — a dark card in the console's own visual language with the status, a sentence explaining the refusal and a "Back to app" link. Pass an object to
   * tweak that page (`brand`, `title`, `message`, `homeHref`, `accent`, …), or a function to
   * render/answer it yourself — see {@link AccessDeniedRenderer}. A redirect `authorize` wrote or
   * asked for (`{ redirectTo }`) still wins.
   */
  accessDenied?: AccessDeniedOption;
  /**
   * Who the console's sidebar footer shows as signed in. Omit it to read `ctx.auth.user`
   * structurally (`fullName`/`name`/`email`, first of `role`/`roles`) when the request is already
   * authenticated; return `null` for no user row. A throw is treated as `null`.
   */
  viewer?: ViewerHook;
  /**
   * The footer's "Sign out": a POST action path (`'/logout'`, sent with the CSRF token), `{ href }`
   * for a plain link, or `false` for none. Omit it to use the sign-out an account console (authkit)
   * announces on the `agora.consoles` registry, when there is one. Same-origin paths only.
   */
  signOut?: SignOutOption;
}

export interface ResolvedAgentDashboardConfig {
  enabled: boolean;
  path?: string;
  authorize?: AgentDashboardAuthorize;
  accessDenied?: AccessDeniedOption;
  /** The host's `viewer` hook, or `null` for the structural `ctx.auth.user` read. */
  viewer: ViewerHook | null;
  /** The host's `signOut` option, or `null` for the one an account console announced. */
  signOut: SignOutOption | null;
}

/** Fill defaults for the optional dashboard config block. */
export function resolveDashboardConfig(
  config: AgentDashboardConfig | undefined,
): ResolvedAgentDashboardConfig {
  const resolved: ResolvedAgentDashboardConfig = {
    enabled: config?.enabled ?? true,
    viewer: config?.viewer ?? null,
    signOut: config?.signOut ?? null,
  };
  if (config?.path !== undefined) resolved.path = config.path;
  if (config?.authorize !== undefined) resolved.authorize = config.authorize;
  if (config?.accessDenied !== undefined) resolved.accessDenied = config.accessDenied;
  return resolved;
}

/** Whether the provider registers the console's routes, and (when it refuses) what to say about it. */
export type DashboardMountDecision =
  | { mount: true }
  | { mount: false; reason: 'disabled' }
  | { mount: false; reason: 'no-governance-queries'; warning: string };

/** The wording logged when the read-model the console reads was turned off. */
const NO_GOVERNANCE_QUERIES_WARNING =
  '[@adonis-agora/agent-dashboard] the governance console was NOT mounted: `governanceQueries` is set to `false` in config/agent.ts, so the cross-actor read-model was never built and the `/agent/governance/*` routes it serves do not exist — the console would load and then fail on every panel but Quota. Remove `governanceQueries: false` (omit it to get the Lucid read-model when the main store is Lucid, or pass a store/factory explicitly) to mount the read-model and this console. To keep the console off on purpose and silence this, set `dashboard: { enabled: false }`.';

/**
 * Decide whether to register the console's routes at all — the router-free core of the provider's
 * mount check. The console mounts unless `dashboard: { enabled: false }`, or unless
 * `governanceQueries: false` removed the `/agent/governance/*` routes every panel but Quota reads
 * (a shell that can only 404 its own data is worse than none, so that case says so at boot).
 * Access is `dashboard.authorize`'s job, not this one.
 */
export function decideDashboardMount(
  enabled: boolean,
  governanceQueries?: unknown,
): DashboardMountDecision {
  if (!enabled) return { mount: false, reason: 'disabled' };
  // ONLY an explicit `false` is decidable here. `undefined` does NOT mean "no read-model": the agent
  // provider defaults it to the Lucid read-model whenever the main store is Lucid.
  if (governanceQueries === false) {
    return {
      mount: false,
      reason: 'no-governance-queries',
      warning: NO_GOVERNANCE_QUERIES_WARNING,
    };
  }
  return { mount: true };
}
