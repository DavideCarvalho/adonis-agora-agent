import type { RolesPolicy } from '../spi/roles-policy.js';
import type { McpAuth, McpAuthFactory } from './auth.js';
import { apiKeyAuth, authKitAuth } from './auth.js';

/**
 * Shape of `config/mcp.ts`. The MCP provider exposes the agent's {@link ToolRegistry} over the Model
 * Context Protocol (Streamable HTTP): `tools/list` mirrors the tools the acting actor may call
 * (role-filtered), `tools/call` runs them through the registry (role re-check + schema re-validation).
 *
 * ```ts
 * import { defineMcpConfig, authKitAuth } from '@adonis-agora/agent/mcp'
 *
 * export default defineMcpConfig({
 *   name: 'Lumen Agent',
 *   version: '1.0.0',
 *   auth: authKitAuth(),
 *   path: 'mcp',
 * })
 * ```
 */
export interface McpConfig {
  /** Server name reported to MCP clients in the initialize handshake. */
  name: string;
  /** Server version reported to MCP clients. */
  version: string;
  /**
   * Route prefix the MCP Streamable HTTP endpoint mounts under. Defaults to `'mcp'` (→ `/mcp`).
   * OAuth metadata (when `auth.oauth` is set) is served at `/.well-known/oauth-protected-resource{path}`.
   */
  path?: string;
  /**
   * How MCP clients authenticate. Pass a ready {@link McpAuth} or a lazy {@link McpAuthFactory} thunk
   * (`authKitAuth()` / `apiKeyAuth()`). Omit → the server is open (no bearer check); the acting actor
   * falls back to `actor`. Fail-closed: with no `auth` AND no `actor`, requests are rejected.
   */
  auth?: McpAuth | McpAuthFactory;
  /**
   * The acting actor when `auth` is omitted (dev/open mode). Fail-closed default: omitted → requests
   * are rejected 401. Set it (e.g. `{ id: 'mcp', roles: ['ADMIN'] }`) to let unauthenticated clients
   * run tools under that identity.
   */
  actor?: { id: string; roles?: string[]; tenantRef?: string };
  /**
   * Tool authorization gate. Defaults to `DefaultToolAuthorizer(config.defaultRoles ?? ['ADMIN'])` —
   * same fail-closed default as the agent provider.
   */
  authorizer?: RolesPolicy;
  /** Roles a tool requires when it declares none. Defaults to `['ADMIN']`. */
  defaultRoles?: string[];
  /**
   * Restrict the exposed tools to this allow-list of names. Omit → all tools the acting actor's roles
   * permit are exposed.
   */
  allowedTools?: string[];
}

/** Identity helper giving `config/mcp.ts` full type-checking. */
export function defineMcpConfig(config: McpConfig): McpConfig {
  return config;
}

export type {
  ApiKeyActorResolver,
  ApiKeyMcpAuthOptions,
  AuthKitActorResolver,
  AuthKitMcpAuthOptions,
  McpAuth,
  McpAuthContext,
  McpAuthFactory,
  McpOAuthMetadata,
} from './auth.js';
export { resolveMcpAuth } from './auth.js';
export { apiKeyAuth, authKitAuth };
