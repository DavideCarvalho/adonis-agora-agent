import type { HttpContext } from '@adonisjs/core/http';
import { type AuthorizeResult, resolveAuthorizeResult } from './authorize-decision.js';
import type { Actor } from './types.js';

/**
 * Authorization gate for the cross-actor `/agent/governance/*` read routes. It runs AFTER the actor
 * is resolved (so the caller is already authenticated), and decides whether THIS actor may read the
 * platform-wide governance read-model (every actor's spend/usage/threads/approvals). Returns an
 * {@link AuthorizeResult}: `true`/`{ allowed: true }` allows; `false`/`{ allowed: false }` denies
 * with `403`; `{ allowed: false, reason: 'unauthenticated' }` denies with `401` and
 * `{ allowed: false, reason: 'forbidden' }` with `403`. Throwing denies with `403`.
 *
 * The gate is what makes those routes exist: omit it and the provider does NOT mount
 * `/agent/governance/*` at all (every route answers `404`). Set it to mount them gated, or set
 * `governanceAuthorize: () => true` to deliberately restore the old behaviour of letting ANY
 * authenticated actor read them. `GET /agent/approvals/mine` is unaffected — it stays mounted and
 * scoped to the calling actor's own pending approvals.
 *
 * Mirrors `@adonis-agora/agent-dashboard`'s `authorize` hook so the JSON routes and the console SPA
 * that reads them can be gated with the SAME predicate (typically "actor is ADMIN").
 */
export type AgentGovernanceAuthorize = (
  actor: Actor,
  ctx: HttpContext,
) => AuthorizeResult | Promise<AuthorizeResult>;

/** The decision {@link evaluateGovernanceGate} returns: proceed, or reply `status` with `error`. */
export interface GovernanceGateVerdict {
  ok: boolean;
  /**
   * The HTTP status to reply when `!ok`: `403`, or `401` when `authorize` returned
   * `{ allowed: false, reason: 'unauthenticated' }`.
   */
  status: number;
  error?: string;
}

/**
 * Decide whether an already-resolved actor holds cross-actor governance privilege — the router-free
 * core of the provider's governance gate, extracted so it can be unit tested without booting an app.
 *
 * - No `authorize` configured → `{ ok: true }` (see the caveat below — the provider never gets here).
 * - `authorize` returns `true` / `{ allowed: true }` → `{ ok: true }`.
 * - `authorize` returns `false` / `{ allowed: false }` (no reason) / `{ allowed: false, reason:
 *   'forbidden' }` → `{ ok: false, status: 403 }`. A denying decision object is truthy, so it is
 *   normalised via {@link resolveAuthorizeResult}, never truth-tested.
 * - `authorize` returns `{ allowed: false, reason: 'unauthenticated' }` → `{ ok: false, status: 401 }`.
 * - `authorize` throws → `{ ok: false, status: 403 }` (fail-closed). `debug` decides whether the
 *   thrown `.message` reaches the client (`true`, e.g. local dev — the message is meant for whoever
 *   is wiring `governanceAuthorize`, useful to see while testing it) or a generic `'forbidden'`
 *   (`false`, the default — this predicate runs on every request from a caller who is, by
 *   definition, not yet proven trustworthy; matches `@adonis-agora/durable`'s dashboard convention of
 *   a uniform message on every credential failure). The provider passes `!app.inProduction`.
 *
 * The `undefined` branch is a pure-function convenience, NOT a claim that governance is readable
 * without a gate. Neither provider caller can reach it: `#resolveGovernanceActor` backs the
 * `/agent/governance/*` routes, which are NOT mounted at all when no gate is configured (they answer
 * `404`), so it always passes one; and `#assertOwner` — which reuses this predicate as the "may act
 * across actors" seam for the per-actor run/thread routes — short-circuits to "not privileged" when
 * no gate is configured, leaving ownership strict, rather than calling in. To mount the governance
 * routes, set `governanceAuthorize` (typically an ADMIN check); to deliberately restore the old
 * behaviour of letting ANY authenticated actor read them, set `governanceAuthorize: () => true`.
 * Either way `GET /agent/approvals/mine` is unaffected — it stays mounted and scoped to the calling
 * actor's own pending approvals.
 */
export async function evaluateGovernanceGate(
  actor: Actor,
  ctx: HttpContext,
  authorize?: AgentGovernanceAuthorize,
  debug = false,
): Promise<GovernanceGateVerdict> {
  if (authorize === undefined) return { ok: true, status: 200 };
  try {
    const decision = resolveAuthorizeResult(await authorize(actor, ctx));
    if (decision.allowed) return { ok: true, status: 200 };
    return decision.status === 401
      ? { ok: false, status: 401, error: 'unauthorized' }
      : { ok: false, status: 403, error: 'forbidden' };
  } catch (error) {
    return {
      ok: false,
      status: 403,
      error: debug && error instanceof Error ? error.message : 'forbidden',
    };
  }
}
