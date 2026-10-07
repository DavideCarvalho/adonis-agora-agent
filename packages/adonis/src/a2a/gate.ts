import type { RolesPolicy } from '../spi/roles-policy.js';
import type { Actor, ToolSpec } from '../types.js';
import { PERSONAL_AGENT_ROLE } from './permission-tool.js';

/**
 * Wrap a {@link RolesPolicy} so personal agents reach only what was written for them.
 *
 * An A2A actor carries {@link PERSONAL_AGENT_ROLE}. For it, a tool must DECLARE one of the actor's
 * roles — `personal_agent` itself, or a scope the user delegated — and the wrapped policy must agree
 * too. A tool with no `roles` is unreachable: under the default policy "no roles" means "anyone",
 * and an app's existing tools were never written with an outside caller in mind. Every other actor
 * is decided by the wrapped policy alone, unchanged.
 */
export function personalAgentGate(inner: RolesPolicy): RolesPolicy {
  return {
    async can(actor: Actor, tool: ToolSpec) {
      const roles = actor.roles ?? [];
      if (roles.includes(PERSONAL_AGENT_ROLE)) {
        if (!(tool.roles ?? []).some((role) => roles.includes(role))) return false;
      }
      return inner.can(actor, tool);
    },
  };
}
