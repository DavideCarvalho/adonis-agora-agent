import { defaultScopeResolver, type ScopeResolver } from '../skills.js';
import type { RolesPolicy } from '../spi/roles-policy.js';
import type { Actor, ToolSpec } from '../types.js';
import { PERSONAL_AGENT_ROLE } from './permission-tool.js';

/** The role a delegated scope becomes. Namespaced, so a scope can never pose as an app role. */
export function scopeRole(scope: string): string {
  return `scope:${scope}`;
}

function isPersonalAgent(actor: Actor): boolean {
  return (actor.roles ?? []).includes(PERSONAL_AGENT_ROLE);
}

/**
 * Wrap a {@link RolesPolicy} so personal agents reach only what was written for them.
 *
 * An A2A actor carries {@link PERSONAL_AGENT_ROLE}, plus one {@link scopeRole} per delegated scope.
 * For it, a tool must DECLARE one of those roles, and the wrapped policy must agree too. A tool with
 * no `roles` is unreachable: under the default policy "no roles" means "anyone", and an app's
 * existing tools were never written with an outside caller in mind. Every other actor is decided by
 * the wrapped policy alone, unchanged.
 */
export function personalAgentGate(inner: RolesPolicy): RolesPolicy {
  return {
    async can(actor: Actor, tool: ToolSpec) {
      if (isPersonalAgent(actor)) {
        const roles = actor.roles ?? [];
        if (!(tool.roles ?? []).some((role) => roles.includes(role))) return false;
      }
      return inner.can(actor, tool);
    },
  };
}

/**
 * Wrap the {@link ScopeResolver} of memory or skills so a personal agent resolves NO scope. Under
 * delegation its actor id is the account's — without this it would read the account's memories
 * (and its tenant's) and could write new ones, a standing instruction to the user's own assistant.
 * Built-ins like `remember` come from config, not the registry, so the tool gate never sees them.
 */
export function personalAgentScopes(inner: ScopeResolver | undefined): ScopeResolver {
  const resolver = inner ?? defaultScopeResolver;
  return {
    resolve: (ctx) => (isPersonalAgent(ctx.actor) ? [] : resolver.resolve(ctx)),
  };
}
