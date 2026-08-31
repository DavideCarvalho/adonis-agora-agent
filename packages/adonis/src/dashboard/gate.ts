import type { HttpContext } from '@adonisjs/core/http';
import type { ActorResolver } from '../spi/actor-resolver.js';
import { type AccessDeniedInfo, resolveAccessDeniedPage } from './access_denied_page.js';
import type {
  AccessDeniedOption,
  AgentDashboardAuthorize,
  AgentDashboardUnauthenticatedHook,
} from './define_config.js';

/** The outcome of the dashboard access gate: proceed, or deny with an HTTP status + message. */
export type DashboardGateVerdict = { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Decide whether a request may reach the dashboard, WITHOUT touching the response — so it is unit
 * testable free of the AdonisJS router/app: resolve the actor through the agent config's resolver
 * (missing/failed → `401`), then run the optional `authorize` gate over the resolved actor
 * (denied/threw → `403`).
 *
 * This gates the SPA **shell**, and only the shell. It is NOT what decides whether the console's data
 * is readable, and it is no longer the last line of defence it once had to be:
 *
 * - Whether the console mounts at all is decided earlier, by {@link decideDashboardMount} — the
 *   routes are not registered unless the agent config carries a `governanceAuthorize` gate AND its
 *   `governanceQueries` read-model exists. So this function never runs for a console that could only
 *   404 its own panels.
 * - Whether the DATA is readable is decided by the agent's own `governanceAuthorize` on the
 *   `/agent/governance/*` routes, not here. Omitting `authorize` while a gate is configured leaves
 *   the shell open to any resolved actor but exposes no cross-actor data.
 *
 * Omitting BOTH the resolver and `authorize` would expose the shell to any request; the provider is
 * expected to short-circuit on a missing resolver via the `401` here.
 *
 * `debug` controls whether a THROWN error's `.message` reaches the client, for the two per-request
 * failure paths (the resolver rejecting a caller, `authorize` throwing): the resolver's job is
 * exactly to reject unauthenticated/unauthorized callers, and its message is meant for the developer
 * wiring the config (e.g. `AuthActorResolver`'s "no authenticated user on ctx.auth.user...") — not
 * for whoever is making the request, which in production is an untrusted, possibly anonymous,
 * possibly adversarial caller. Default `false` (generic `'unauthorized'`/`'forbidden'`, matching
 * `@adonis-agora/durable`'s dashboard convention of a uniform message on every credential failure);
 * the provider passes `!app.inProduction` so local/dev boots keep the diagnostic detail. The "no
 * actor resolver configured" branch is unaffected — that is a static config error, not a per-request
 * one, identical for every caller, and useful for the operator to see even in production.
 *
 * `onUnauthenticated`, when set, runs on EITHER failure-to-resolve branch (no resolver configured, or
 * `resolve(ctx)` threw) before this returns its verdict — it never sees a fabricated actor, since
 * there isn't one. The provider (not this function) is what actually decides whether to skip its
 * default JSON write in favour of whatever the hook did to `ctx.response` (redirect, custom render);
 * this function only guarantees the hook runs before the verdict is handed back.
 */
export async function evaluateDashboardGate(
  ctx: HttpContext,
  actorResolver: ActorResolver | undefined,
  authorize?: AgentDashboardAuthorize,
  debug = false,
  onUnauthenticated?: AgentDashboardUnauthenticatedHook,
): Promise<DashboardGateVerdict> {
  if (actorResolver === undefined) {
    await onUnauthenticated?.(ctx);
    return { ok: false, status: 401, error: 'no actor resolver configured' };
  }
  let actor: Awaited<ReturnType<ActorResolver['resolve']>>;
  try {
    actor = await actorResolver.resolve(ctx);
  } catch (error) {
    await onUnauthenticated?.(ctx);
    return {
      ok: false,
      status: 401,
      error: debug && error instanceof Error ? error.message : 'unauthorized',
    };
  }
  if (authorize !== undefined) {
    try {
      if (!(await authorize(actor, ctx))) {
        return { ok: false, status: 403, error: 'forbidden' };
      }
    } catch (error) {
      return {
        ok: false,
        status: 403,
        error: debug && error instanceof Error ? error.message : 'forbidden',
      };
    }
  }
  return { ok: true };
}

/** What {@link answerDashboardDenial} needs to serve (or delegate) the access-denied page. */
export interface DashboardDenialOptions {
  /** The console's mount (`/agent/dashboard`) — reported to a custom renderer as `basePath`. */
  basePath: string;
  /** The host's `dashboard.accessDenied` option — tweak the built-in page, or render it. */
  accessDenied?: AccessDeniedOption | undefined;
}

/**
 * Write a refused {@link DashboardGateVerdict} to the response — shared by BOTH dashboard providers
 * (embedded and standalone) so they refuse identically. A browser is what hits these routes (the
 * SPA shell and its assets), so the body is the built-in access-denied page (or the host's
 * `accessDenied` customisation of it), not the JSON the governance API answers with.
 *
 * Stands down when the request is already answered: `onUnauthenticated`/`authorize` (or the
 * renderer) writing a redirect keeps it — the `location`-header rule the providers have always
 * honoured. The verdict's `error` is shown on the page as a developer detail only when it is more
 * than the generic word (i.e. the `debug` message outside production, or the static "no actor
 * resolver configured" operator hint).
 */
export async function answerDashboardDenial(
  ctx: HttpContext,
  verdict: Extract<DashboardGateVerdict, { ok: false }>,
  options: DashboardDenialOptions,
): Promise<void> {
  const answered = () => responseAnswered(ctx);
  if (answered()) return;
  const nonce = cspNonce(ctx);
  const generic = verdict.error === 'unauthorized' || verdict.error === 'forbidden';
  const info: AccessDeniedInfo = {
    status: verdict.status,
    reason: verdict.status === 401 ? 'unauthenticated' : 'forbidden',
    basePath: options.basePath,
    ...(generic ? {} : { detail: verdict.error }),
    ...(nonce !== undefined ? { nonce } : {}),
  };
  const html = await resolveAccessDeniedPage(info, options.accessDenied, ctx, answered);
  if (html === null) return;
  ctx.response
    .status(info.status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store, must-revalidate')
    .send(html);
}

/**
 * Whether something already answered this request: a redirect (`location` header) or a body queued
 * on the response. The body check reads AdonisJS's `response.hasLazyBody` structurally so a
 * plain-object `ctx` double in a unit test (which has neither) still works.
 */
function responseAnswered(ctx: HttpContext): boolean {
  if (ctx.response.getHeader('location')) return true;
  const response = ctx.response as unknown as { hasLazyBody?: unknown; headersSent?: unknown };
  return response.hasLazyBody === true || response.headersSent === true;
}

/**
 * The request's CSP nonce when the host runs `@adonisjs/shield` with `@nonce` in its policy (shield
 * exposes it as `response.nonce`). Read structurally: this package neither depends on shield nor
 * cares which middleware minted the nonce — only that the page's inline `<style>` carries it.
 */
function cspNonce(ctx: HttpContext): string | undefined {
  const nonce = (ctx.response as unknown as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}
