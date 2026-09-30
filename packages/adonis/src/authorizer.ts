import { DefaultRolesPolicy } from './tool-registry.js';
import type { Actor, ToolSpec } from './types.js';

/**
 * The default tool authorizer the provider binds when `config/agent.ts` sets no `authorizer` /
 * `rolesPolicy`. A tool that declares `roles` is offered (and invocable) only to an actor holding one
 * of them; a tool that declares none takes `defaultRoles` — `[]` unless configured, which means no
 * restriction (anyone the actor resolver resolved, an anonymous visitor included). Set
 * `defaultRoles: ['ADMIN']` for the old fail-closed posture.
 *
 * This is a thin, explicitly-named binding over core's {@link DefaultRolesPolicy} (the `RolesPolicy`
 * seam) so apps that plug an ability-aware gate (`@adonis-agora/authz` Bouncer adapter) swap ONLY the
 * binding, never the seam. The double check — offered-tools filter AND an invoke-time re-check inside
 * `ToolRegistry.invoke` — both run through this same `can(actor, tool)`.
 */
export class DefaultToolAuthorizer extends DefaultRolesPolicy {
  constructor(defaultRoles: string[] = []) {
    super(defaultRoles);
  }

  override can(actor: Actor, tool: ToolSpec): boolean {
    return super.can(actor, tool);
  }
}
