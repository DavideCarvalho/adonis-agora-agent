import type { HttpContext } from '@adonisjs/core/http';
import type { AgentGovernanceAuthorize } from '../governance-gate.js';
import type { Actor } from '../types.js';

/**
 * An extra authorization gate for the dashboard, run AFTER the agent config's `actorResolver` has
 * resolved the caller. Return `false` (or throw) to deny — the request gets `403`. The governance
 * read-model the SPA serves spans EVERY actor's spend/usage, so most apps restrict the console beyond
 * mere authentication, e.g. `(actor) => actor.roles?.includes('ADMIN') ?? false`.
 */
export type AgentDashboardAuthorize = (
  actor: Actor,
  ctx: HttpContext,
) => boolean | Promise<boolean>;

/**
 * Runs when the agent config's `actorResolver` itself rejects the caller — no resolver configured, or
 * `resolve(ctx)` threw (e.g. `AuthActorResolver` over an anonymous `ctx.auth`) — so there is no
 * resolved {@link Actor} to hand to {@link AgentDashboardAuthorize}. Deliberately ctx-only, never a
 * fabricated actor: the resolver's whole contract is "never invent an identity", and this hook must
 * not undermine that.
 *
 * Called BEFORE the gate writes its default `401 { error }` JSON. To show something other than that
 * JSON — a redirect to the app's own login page, most commonly — set a response header inside this
 * hook (typically via `ctx.response.redirect(...)`); the gate detects the `location` header and skips
 * its own write. Anything else (return normally without touching the response) falls through to the
 * default JSON, so this is safe to omit or to use only for side effects (e.g. logging).
 */
export type AgentDashboardUnauthenticatedHook = (ctx: HttpContext) => void | Promise<void>;

/**
 * Optional `config('agent').dashboard` block. The dashboard reuses the agent config's `path` and
 * `actorResolver` (so it sits behind the SAME actor gating as the governance routes); this block
 * toggles it on/off, optionally overrides the mount path, and optionally adds an `authorize` gate.
 *
 * Shared by BOTH the embedded dashboard provider (`@adonis-agora/agent/dashboard_provider`, wired
 * automatically when you `node ace configure @adonis-agora/agent`) and the standalone
 * `@adonis-agora/agent-dashboard` package's provider — one config block controls whichever one is
 * registered.
 */
export interface AgentDashboardConfig {
  /**
   * Mount the SPA. Default `true` — set `false` to keep the routes off entirely. Note `true` is
   * necessary but not sufficient: the console also needs the agent's `governanceAuthorize` gate, see
   * {@link decideDashboardMount}.
   */
  enabled?: boolean;
  /** Override the mount path. Default `<agentPath>/dashboard`. */
  path?: string;
  /**
   * Extra authorization run after the actor resolves. Return `false` to deny (`403`). Omit to allow
   * any resolved actor (the default) — note this is only an EXTRA gate on the SPA shell; whether the
   * console mounts at all, and whether its data is readable, is decided by the agent config's
   * `governanceAuthorize`.
   */
  authorize?: AgentDashboardAuthorize;
  /**
   * Runs when the actor resolver itself rejects the caller (no resolver, or `resolve(ctx)` threw) —
   * the one denial `authorize` never sees, since there is no resolved actor to hand it. Set a
   * response header inside (e.g. `ctx.response.redirect('/login')`) to replace the default
   * `401 { error }` JSON with a custom page/redirect. See {@link AgentDashboardUnauthenticatedHook}.
   */
  onUnauthenticated?: AgentDashboardUnauthenticatedHook;
}

export interface ResolvedAgentDashboardConfig {
  enabled: boolean;
  path?: string;
  authorize?: AgentDashboardAuthorize;
  onUnauthenticated?: AgentDashboardUnauthenticatedHook;
}

/** Fill defaults for the optional dashboard config block. */
export function resolveDashboardConfig(
  config: AgentDashboardConfig | undefined,
): ResolvedAgentDashboardConfig {
  const resolved: ResolvedAgentDashboardConfig = { enabled: config?.enabled ?? true };
  if (config?.path !== undefined) resolved.path = config.path;
  if (config?.authorize !== undefined) resolved.authorize = config.authorize;
  if (config?.onUnauthenticated !== undefined)
    resolved.onUnauthenticated = config.onUnauthenticated;
  return resolved;
}

/** Whether the provider registers the console's routes, and (when it refuses) what to say about it. */
export type DashboardMountDecision =
  | { mount: true }
  | { mount: false; reason: 'disabled' }
  | { mount: false; reason: 'no-governance-gate'; warning: string }
  | { mount: false; reason: 'no-governance-queries'; warning: string };

/**
 * The exact wording the provider logs when it declines to mount. Mirrors the agent provider's own
 * governance boot warning — same three facts, same vocabulary — so a reader who sees one recognises
 * the other.
 */
const NO_GOVERNANCE_GATE_WARNING =
  '[@adonis-agora/agent-dashboard] the governance console was NOT mounted: every panel but Quota reads the cross-actor `/agent/governance/*` routes, and those are themselves not mounted because no `governanceAuthorize` gate is configured — so the console would load and then fail on every panel. Set `governanceAuthorize` in config/agent.ts (e.g. an ADMIN check) to mount the routes and this console gated, or `governanceAuthorize: () => true` to deliberately restore the old behaviour of letting ANY authenticated actor read them. `GET /agent/approvals/mine` is unaffected — it stays mounted and scoped to the calling actor. To keep the console off on purpose and silence this, set `dashboard: { enabled: false }`.';

/**
 * The wording logged when the read-model itself was turned off. Deliberately distinct from
 * {@link NO_GOVERNANCE_GATE_WARNING}: both produce the same dead console, and an operator staring at
 * a 404 must be able to tell from the log ALONE which of the two knobs is responsible. A shared
 * "governance is not configured" message would recreate exactly the diagnosability problem this
 * check exists to remove.
 */
const NO_GOVERNANCE_QUERIES_WARNING =
  '[@adonis-agora/agent-dashboard] the governance console was NOT mounted: `governanceQueries` is set to `false` in config/agent.ts, so the cross-actor read-model was never built and the `/agent/governance/*` routes it serves do not exist — the console would load and then fail on every panel but Quota. A `governanceAuthorize` gate is NOT the missing piece here; it is already configured. Remove `governanceQueries: false` (omit it to get the Lucid read-model when the main store is Lucid, or pass a store/factory explicitly) to mount the read-model and this console. To keep the console off on purpose and silence this, set `dashboard: { enabled: false }`.';

/**
 * Decide whether to register the console's routes at all — the router-free core of the provider's
 * mount check, extracted so it can be unit tested without booting an app.
 *
 * The console is a pure consumer of the agent's cross-actor `/agent/governance/*` read routes, and
 * those routes are not mounted unless the agent config carries a `governanceAuthorize` gate. Serving
 * a shell that can only 404 its own data is worse than not serving it: the failure shows up as seven
 * dead panels at click time with nothing anywhere explaining why. So the console follows the same
 * fail-closed-by-omission rule one layer down — no gate, no routes — and says so at boot.
 *
 * This costs nothing that still works: every app affected is an app whose console is ALREADY dead in
 * every view but Quota. `dashboard.authorize` is deliberately NOT the trigger; it gates the shell,
 * not the data, and an app can set it and still have a console with nothing to render.
 */
export function decideDashboardMount(
  enabled: boolean,
  governanceAuthorize: AgentGovernanceAuthorize | undefined,
  governanceQueries?: unknown,
): DashboardMountDecision {
  if (!enabled) return { mount: false, reason: 'disabled' };
  if (governanceAuthorize === undefined) {
    return { mount: false, reason: 'no-governance-gate', warning: NO_GOVERNANCE_GATE_WARNING };
  }
  // ONLY an explicit `false` is decidable here. `undefined` does NOT mean "no read-model": the agent
  // provider's `#resolveGovernance` defaults it to the Lucid read-model whenever the main store is
  // Lucid, and reproducing that resolution would duplicate provider logic in the dashboard.
  if (governanceQueries === false) {
    return {
      mount: false,
      reason: 'no-governance-queries',
      warning: NO_GOVERNANCE_QUERIES_WARNING,
    };
  }
  return { mount: true };
}
