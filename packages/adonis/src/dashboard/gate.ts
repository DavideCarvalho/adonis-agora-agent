import type { HttpContext } from '@adonisjs/core/http';
import type { ActorResolver } from '../spi/actor-resolver.js';
import type { AgentDashboardAuthorize } from './define_config.js';

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
 */
export async function evaluateDashboardGate(
  ctx: HttpContext,
  actorResolver: ActorResolver | undefined,
  authorize?: AgentDashboardAuthorize,
  debug = false,
): Promise<DashboardGateVerdict> {
  if (actorResolver === undefined) {
    return { ok: false, status: 401, error: 'no actor resolver configured' };
  }
  let actor: Awaited<ReturnType<ActorResolver['resolve']>>;
  try {
    actor = await actorResolver.resolve(ctx);
  } catch (error) {
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
