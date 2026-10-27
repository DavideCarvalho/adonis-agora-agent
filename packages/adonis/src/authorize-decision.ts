/**
 * The dashboard-gate return contract shared by every `@adonis-agora/*` console (agent, telescope,
 * durable, media, payments, authz). Each lib carries its OWN copy of these two types — deliberately
 * no shared package — so they must stay identical across the ecosystem.
 *
 * An authorize hook may return:
 * - `true` / `{ allowed: true }` → proceed.
 * - `{ allowed: false, reason: 'unauthenticated' }` → `401` (nobody is signed in).
 * - `{ allowed: false, reason: 'forbidden' }` → `403` (signed in, not allowed).
 * - `false` / `{ allowed: false }` (no reason) → `403`.
 *
 * A decision object is truthy even when it denies, so a caller must NEVER test the raw result with
 * `if (!result)` — normalise it through {@link resolveAuthorizeResult}.
 */
export interface AuthorizeDecision {
  allowed: boolean;
  reason?: 'unauthenticated' | 'forbidden';
}

/** What an authorize hook returns: a bare boolean, or an {@link AuthorizeDecision}. */
export type AuthorizeResult = boolean | AuthorizeDecision;

/** An {@link AuthorizeResult} normalised: allowed, or denied with the HTTP status it maps to. */
export type ResolvedAuthorizeResult = { allowed: true } | { allowed: false; status: 401 | 403 };

/**
 * Normalise an {@link AuthorizeResult} to allow/deny + status. Only `true` and an object whose
 * `allowed` is exactly `true` allow; anything else (including a malformed value from an untyped hook)
 * denies — `401` only when the decision says `reason: 'unauthenticated'`, `403` otherwise.
 */
export function resolveAuthorizeResult(result: unknown): ResolvedAuthorizeResult {
  if (result === true) return { allowed: true };
  if (typeof result === 'object' && result !== null) {
    const decision = result as Partial<AuthorizeDecision>;
    if (decision.allowed === true) return { allowed: true };
    return { allowed: false, status: decision.reason === 'unauthenticated' ? 401 : 403 };
  }
  return { allowed: false, status: 403 };
}
