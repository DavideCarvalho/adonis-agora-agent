import { SCOPE_ROLE_PREFIX } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import type { RolesPolicy } from '../spi/roles-policy.js';
import type { Actor, ToolSpec } from '../types.js';

/**
 * The scopes a personal agent lacks to RUN a tool it is offered (`personalAgentGate`: a tool behind a
 * `scope:` role is offered to every personal agent, run only with that scope). `null` when the actor
 * is not a personal agent, the tool is not offered to it, or it may run it.
 *
 * The MCP provider answers such a `tools/call` with `403` + `WWW-Authenticate: Bearer
 * error="insufficient_scope", scope="…"` (RFC 6750 §3.1, MCP scope step-up), so the client can ask
 * the user for the scope instead of reading a generic tool error.
 */
export async function missingScopes(
  actor: Actor,
  spec: ToolSpec,
  policy: RolesPolicy,
): Promise<string[] | null> {
  const roles = actor.roles ?? [];
  if (!roles.includes(PERSONAL_AGENT_ROLE)) return null;
  const offered = policy.canOffer ? await policy.canOffer(actor, spec) : true;
  if (!offered || (await policy.can(actor, spec))) return null;
  const missing = (spec.roles ?? [])
    .filter((role) => role.startsWith(SCOPE_ROLE_PREFIX) && !roles.includes(role))
    .map((role) => role.slice(SCOPE_ROLE_PREFIX.length));
  return missing.length > 0 ? missing : null;
}
