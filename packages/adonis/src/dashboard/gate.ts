import type { HttpContext } from '@adonisjs/core/http';
import {
  type ConsoleTenants,
  consoleClosedByDefault,
  isPageNavigation,
} from '../console-authorize.js';
import { evaluateGovernanceGate } from '../governance-gate.js';
import type { ActorResolver } from '../spi/actor-resolver.js';
import type { Actor } from '../types.js';
import { type AccessDeniedInfo, resolveAccessDeniedPage } from './access_denied_page.js';
import type { AccessDeniedOption, AgentDashboardAuthorize } from './define_config.js';

/** The outcome of the console access gate: proceed (with the actor, when one resolved), or deny. */
export type DashboardGateVerdict =
  | { ok: true; actor?: Actor; tenants?: ConsoleTenants }
  | {
      ok: false;
      status: 401 | 403;
      error: 'forbidden' | 'unauthenticated';
      /** The thrown error's message, only outside production. */
      detail?: string;
      redirectTo?: string;
    };

/** What {@link evaluateDashboardGate} needs. */
export interface DashboardGateOptions {
  /** The agent config's resolver; its actor (if any) is handed to `authorize` as the 2nd argument. */
  actorResolver?: ActorResolver | undefined;
  /** The console's `authorize` (`dashboard.authorize` in `config/agent.ts`). */
  authorize?: AgentDashboardAuthorize | undefined;
  /** `app.inProduction`: without `authorize`, the console is open outside production, closed in it. */
  inProduction?: boolean;
}

/** The request's actor, or `undefined` when there is no resolver or it rejects the request. */
async function resolveActorQuietly(
  ctx: HttpContext,
  actorResolver: ActorResolver | undefined,
): Promise<Actor | undefined> {
  if (actorResolver === undefined) return undefined;
  try {
    return (await actorResolver.resolve(ctx)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a request may use the agent console — the SPA shell AND the `/agent/governance/*`
 * routes it reads go through this same check. Touches nothing on the response, so it is unit
 * testable free of the router:
 *
 * - `authorize` omitted → allowed outside production, `403 forbidden` in production.
 * - otherwise the actor is resolved (best effort: `undefined` when there is none) and
 *   `authorize(ctx, actor)` decides: `true`/`{ allowed: true }` allow; `false`/`{ allowed: false }`
 *   → `403 forbidden`; `reason: 'unauthenticated'` → `401 unauthenticated`; `{ redirectTo }` → `401`
 *   carrying the path; a throw → `403` (its message as `detail` outside production only).
 */
export async function evaluateDashboardGate(
  ctx: HttpContext,
  options: DashboardGateOptions,
): Promise<DashboardGateVerdict> {
  const inProduction = options.inProduction === true;
  if (consoleClosedByDefault(options.authorize, inProduction)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (options.authorize === undefined) return { ok: true };
  const actor = await resolveActorQuietly(ctx, options.actorResolver);
  const verdict = await evaluateGovernanceGate(actor, ctx, options.authorize, !inProduction);
  if (verdict.ok) {
    return {
      ok: true,
      ...(actor !== undefined ? { actor } : {}),
      ...(verdict.tenants !== undefined ? { tenants: verdict.tenants } : {}),
    };
  }
  return {
    ok: false,
    status: verdict.status === 401 ? 401 : 403,
    error: verdict.error ?? 'forbidden',
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    ...(verdict.redirectTo !== undefined ? { redirectTo: verdict.redirectTo } : {}),
  };
}

/**
 * Write a refused {@link DashboardGateVerdict} as JSON — what the `/agent/governance/*` routes (and
 * any non-page request to the shell) answer: `{ error }`, plus `redirectTo` when `authorize` asked
 * for one. A page navigation with `redirectTo` is redirected instead. Stands down when the hook
 * already answered the request itself.
 */
export function answerConsoleDenialJson(
  ctx: HttpContext,
  verdict: Extract<DashboardGateVerdict, { ok: false }>,
): void {
  if (responseAnswered(ctx)) return;
  if (verdict.redirectTo !== undefined && isPageNavigation(ctx)) {
    ctx.response.redirect(verdict.redirectTo);
    return;
  }
  ctx.response.status(verdict.status).json({
    error: verdict.error,
    ...(verdict.redirectTo !== undefined ? { redirectTo: verdict.redirectTo } : {}),
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
  });
}

/** What {@link answerDashboardDenial} needs to serve (or delegate) the access-denied page. */
export interface DashboardDenialOptions {
  /** The console's mount (`/agent/dashboard`) — reported to a custom renderer as `basePath`. */
  basePath: string;
  /** The host's `dashboard.accessDenied` option — tweak the built-in page, or render it. */
  accessDenied?: AccessDeniedOption | undefined;
}

/**
 * Write a refused {@link DashboardGateVerdict} for the SPA shell — shared by BOTH dashboard providers
 * (embedded and standalone) so they refuse identically. A page navigation gets the built-in
 * access-denied page (or the host's `accessDenied` customisation of it), or a redirect when
 * `authorize` returned `{ redirectTo }`; anything else gets the JSON {@link answerConsoleDenialJson}
 * writes. Stands down when `authorize` (or the renderer) already answered the request.
 */
export async function answerDashboardDenial(
  ctx: HttpContext,
  verdict: Extract<DashboardGateVerdict, { ok: false }>,
  options: DashboardDenialOptions,
): Promise<void> {
  const answered = () => responseAnswered(ctx);
  if (answered()) return;
  if (!isPageNavigation(ctx)) {
    answerConsoleDenialJson(ctx, verdict);
    return;
  }
  if (verdict.redirectTo !== undefined) {
    ctx.response.redirect(verdict.redirectTo);
    return;
  }
  const nonce = cspNonce(ctx);
  const info: AccessDeniedInfo = {
    status: verdict.status,
    reason: verdict.status === 401 ? 'unauthenticated' : 'forbidden',
    basePath: options.basePath,
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
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
