import type { HttpContext } from '@adonisjs/core/http';
import {
  type AgentConsoleAuthorize,
  type ConsoleAccess,
  type ConsoleTenants,
  consoleAuthorizeFor,
} from './console-authorize.js';
import type { Actor } from './types.js';

/** The decision {@link evaluateGovernanceGate} returns: proceed, or reply `status` with `error`. */
export interface GovernanceGateVerdict {
  ok: boolean;
  /**
   * The HTTP status to reply when `!ok`: `403`, or `401` when `authorize` returned
   * `{ allowed: false, reason: 'unauthenticated' }` or `{ redirectTo }`.
   */
  status: number;
  /** The JSON `error` code to reply with: `'forbidden'` (`403`) or `'unauthenticated'` (`401`). */
  error?: 'forbidden' | 'unauthenticated';
  /** The thrown error's message, only when `debug` is on (outside production). */
  detail?: string;
  /** Where to send a page navigation instead, when the gate returned `{ redirectTo }`. */
  redirectTo?: string;
  /** When allowed: the tenants `authorize` granted (`'*'` or ids); absent = the viewer's own. */
  tenants?: ConsoleTenants;
  /** When allowed: the federated apps `authorize` granted (`'*'` or keys); absent = all. */
  apps?: ConsoleTenants;
  /** When allowed: what `authorize` granted (`access: 'read'` → none of the write ones). */
  access?: ConsoleAccess;
  /** When allowed: the viewer's console capabilities `authorize` returned; absent = all. */
  capabilities?: string[];
}

/**
 * Decide whether a request (and its actor, when one resolved) passes the console's `authorize` — the
 * router-free core of the `/agent/governance/*` gate (and of the "may act across actors" check on the per-actor
 * run/thread routes), extracted so it can be unit tested without booting an app.
 *
 * - No `authorize` → `{ ok: true }`. The provider handles the omitted case before calling (open
 *   outside production, `403` in production), and never treats it as cross-actor privilege.
 * - `true` / `{ allowed: true }` → `{ ok: true }`.
 * - `false` / `{ allowed: false }` / `reason: 'forbidden'` → `403 forbidden`.
 * - `{ allowed: false, reason: 'unauthenticated' }` → `401 unauthenticated`.
 * - `{ redirectTo }` → `401 unauthenticated` carrying `redirectTo`.
 * - a throw → `403 forbidden`; with `debug` the thrown message rides along as `detail`.
 * - `action: 'write'` (a change) and `{ allowed: true, access: 'read' }` → `403 forbidden`: a
 *   read-level grant never changes anything.
 */
export async function evaluateGovernanceGate(
  actor: Actor | undefined,
  ctx: HttpContext,
  authorize?: AgentConsoleAuthorize,
  debug = false,
  action: ConsoleAccess = 'read',
): Promise<GovernanceGateVerdict> {
  if (authorize === undefined) return { ok: true, status: 200 };
  const decision = await consoleAuthorizeFor(authorize)(ctx, actor, { action });
  if (decision.allowed && action === 'write' && decision.access === 'read') {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      ...(debug ? { detail: "this access is read-only (`access: 'read'`)" } : {}),
    };
  }
  if (decision.allowed) {
    return {
      ok: true,
      status: 200,
      ...(decision.tenants !== undefined ? { tenants: decision.tenants } : {}),
      ...(decision.apps !== undefined ? { apps: decision.apps } : {}),
      ...(decision.access !== undefined ? { access: decision.access } : {}),
      ...(decision.capabilities !== undefined ? { capabilities: decision.capabilities } : {}),
    };
  }
  if (decision.error !== undefined) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      ...(debug && decision.error instanceof Error ? { detail: decision.error.message } : {}),
    };
  }
  if (decision.redirectTo !== undefined) {
    return { ok: false, status: 401, error: 'unauthenticated', redirectTo: decision.redirectTo };
  }
  return decision.status === 401
    ? { ok: false, status: 401, error: 'unauthenticated' }
    : { ok: false, status: 403, error: 'forbidden' };
}
