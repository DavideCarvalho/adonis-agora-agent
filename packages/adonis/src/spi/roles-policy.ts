import type { Actor, ToolSpec } from '../types.js';

/**
 * Decides whether an actor may invoke a tool. The default impl checks the actor's role
 * against `spec.roles` (defaulting to an ADMIN-only set). Apps can plug `nestjs-authz`
 * or any custom gate here.
 */
export interface RolesPolicy {
  /** May return a promise — an authz Gate (`gate.forUser(actor).allows(...)`) is async. */
  can(actor: Actor, tool: ToolSpec): boolean | Promise<boolean>;
  /**
   * Whether to OFFER the tool to the model (list it), when that differs from {@link can}. Omitted →
   * `can`. Invoking always re-checks `can`, so offering a tool an actor cannot run only lets the
   * model ask for it — `personalAgentGate` uses this so a personal agent's call to a tool behind a
   * scope it was not delegated becomes a permission request instead of a silence.
   */
  canOffer?(actor: Actor, tool: ToolSpec): boolean | Promise<boolean>;
}
