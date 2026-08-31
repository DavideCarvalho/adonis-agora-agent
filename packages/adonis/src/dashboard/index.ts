/**
 * Serving helpers for the `@adonis-agora/agent-dashboard` governance SPA — the config shape, the
 * mount/gate decisions, and the pure path/asset helpers. Framework-light (no AdonisJS router/app
 * dependency), so they're unit-testable in isolation and reusable by BOTH dashboard providers:
 *
 * - `@adonis-agora/agent/dashboard_provider` (this package, `providers/dashboard_provider.ts`) —
 *   embedded: registered automatically by `node ace configure @adonis-agora/agent`, serves the SPA
 *   bundle copied into THIS package's own `dist/assets/spa` at build time.
 * - `@adonis-agora/agent-dashboard`'s own provider (`agent_dashboard_provider.ts`) — standalone: an
 *   independently installable/registrable package some apps already depend on directly.
 *
 * Living here (rather than in `@adonis-agora/agent-dashboard`) keeps the dependency direction
 * one-way: the dashboard package already depends on this one for `AgentConfig`/`ActorResolver`/etc.,
 * so a package.json edge back from here to there would be circular. See
 * `providers/dashboard_provider.ts`'s module doc for the full story.
 */
export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// The built-in "access denied" page (what a browser sees on a refused page navigation).
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
export {
  type AccessDeniedOption,
  type AccessDeniedRenderer,
  type AgentDashboardAuthorize,
  type AgentDashboardConfig,
  type AgentDashboardUnauthenticatedHook,
  type DashboardMountDecision,
  decideDashboardMount,
  type ResolvedAgentDashboardConfig,
  resolveDashboardConfig,
} from './define_config.js';
export {
  answerDashboardDenial,
  type DashboardDenialOptions,
  type DashboardGateVerdict,
  evaluateDashboardGate,
} from './gate.js';
export {
  apiBaseFor,
  CONFIG_ELEMENT_ID,
  contentTypeFor,
  injectApiBase,
  injectBaseHref,
  mountPathFor,
  safeAssetSegments,
  trimSlashes,
} from './paths.js';
