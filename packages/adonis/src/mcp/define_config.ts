import type { RolesPolicy } from '../spi/roles-policy.js';
import type { EmptyRoles, ToolRegistry } from '../tool-registry.js';
import type { McpAuth, McpAuthContext, McpAuthFactory } from './auth.js';
import { anyOf, apiKeyAuth, authKitAuth, McpAuthError } from './auth.js';

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
   * Instructions sent in the `initialize` result — how the client's model should use these tools
   * (where to start, units and time zone, what not to do).
   */
  instructions?: string;
  /**
   * Route prefix the MCP Streamable HTTP endpoint mounts under. Defaults to `'mcp'` (→ `/mcp`).
   * OAuth metadata (when `auth.oauth` is set) is served at `/.well-known/oauth-protected-resource{path}`.
   */
  path?: string;
  /**
   * The public origin MCP clients reach this app at (e.g. `'https://app.example.com'`) — the base of
   * the RFC 9728 `resource` and of the `resource_metadata` URL in the `WWW-Authenticate` challenge.
   * Set it whenever TLS terminates at a proxy the app does not trust (the request then "sees"
   * `http://`). Omit → both are built from the request's protocol and `Host` header. Must be an
   * origin only: a path, query, or fragment is rejected at boot.
   */
  publicUrl?: string;
  /**
   * How MCP clients authenticate. Pass a ready {@link McpAuth} or a lazy {@link McpAuthFactory} thunk
   * (`authKitAuth()` / `apiKeyAuth()`, or several of them combined with `anyOf()`). Omit → the server is open (no bearer check); the acting actor
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
   * What an empty roles list means to the default authorizer: `'allow'` (default) — no restriction;
   * `'deny'` — nobody, so a tool needs `roles` (or a non-empty `defaultRoles`) to be reachable. Only
   * consulted when no `authorizer` is set.
   */
  emptyRoles?: EmptyRoles;
  /**
   * Restrict the exposed tools to this allow-list of names. Omit → all tools the acting actor's roles
   * permit are exposed.
   */
  allowedTools?: string[];
  /**
   * Route middleware for the MCP endpoint (`POST|GET|DELETE {path}`) — e.g. a rate limiter. They
   * run BEFORE the bearer check (authentication happens in the handler), so key a limiter on the
   * `Authorization` header or the IP, not on the authenticated account. The RFC 9728 metadata
   * route is public and gets none.
   */
  middleware?: McpRouteMiddleware[];
  /**
   * What MCP callers may do with `action` tools. `'refuse'` (default): neither listed nor callable —
   * an action has a human approval gate in the loop that MCP cannot honour. `'execute'`: the
   * deployment accepts that the MCP client's own confirmation (most clients ask before each call)
   * stands in for it, and actions run when called.
   */
  actions?: 'refuse' | 'execute';
  /**
   * Serve without sessions: every `POST` is answered by a fresh transport and server, and `GET`
   * (the SSE stream) / `DELETE` are `405`. Use it behind a load balancer with more than one
   * instance — in-memory sessions would not survive a request landing on another one. Tool calls
   * lose nothing: each carries its own token, and tools are stateless here. Default: `false`.
   */
  stateless?: boolean;
  /**
   * How each tool reads in `tools/list`: its `title` and its MCP `annotations` (`readOnlyHint`,
   * `destructiveHint`…), which clients use to run reads without asking and confirm writes. Default:
   * `readOnlyHint: true` for a `read` tool and `false` for an `action`. Return `undefined` to keep it.
   */
  describeTool?: McpToolDescriber;
  /**
   * More MCP servers in the same app, each a protected resource of its own (RFC 9728/8707) — e.g. a
   * team endpoint and a family one, with different tools and audiences. Each inherits the settings
   * above and overrides what it declares; its tokens are bound to ITS URL.
   */
  endpoints?: McpEndpointConfig[];
}

/** An extra MCP server — see {@link McpConfig.endpoints}. */
export interface McpEndpointConfig {
  /** Route prefix, e.g. `'mcp/family'`. */
  path: string;
  /** Server name in the handshake. Default: the top-level `name`. */
  name?: string;
  instructions?: string;
  /** Its own auth (a different audience). Default: the top-level `auth`. */
  auth?: McpAuth | McpAuthFactory;
  /**
   * The tools it serves. Default: the agent's `ToolRegistry`. A thunk, so a registry bound in the
   * container (`app.container.make(FamilyToolRegistry)`) is resolved at boot.
   */
  registry?: (ctx: McpAuthContext) => ToolRegistry | Promise<ToolRegistry>;
  allowedTools?: string[];
  actions?: 'refuse' | 'execute';
  describeTool?: McpToolDescriber;
  /**
   * Name of its RFC 9728 metadata route. Default: `mcp.<path segments>.oauth_protected_resource`
   * (the top-level endpoint's is `mcp.oauth_protected_resource`).
   */
  metadataRouteName?: string;
}

/** What a tool shows in `tools/list` beyond its name, description and schema. */
export interface McpToolDescription {
  title?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type McpToolDescriber = (tool: {
  name: string;
  kind: string;
  description: string;
}) => McpToolDescription | undefined | Promise<McpToolDescription | undefined>;

/** Anything Adonis accepts in `route.use()`: a function, or a named/lazy middleware reference. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors the router's own `use()` parameter
export type McpRouteMiddleware = any;

/** Identity helper giving `config/mcp.ts` full type-checking. */
export function defineMcpConfig(config: McpConfig): McpConfig {
  return config;
}

export type {
  ApiKeyActorResolver,
  ApiKeyMcpAuthOptions,
  AuthKitActiveOrg,
  AuthKitActorInfo,
  AuthKitActorResolver,
  AuthKitGrant,
  AuthKitMcpAuthOptions,
  McpAuth,
  McpAuthContext,
  McpAuthFactory,
  McpOAuthMetadata,
} from './auth.js';
export { resolveMcpAuth } from './auth.js';
export { anyOf, apiKeyAuth, authKitAuth, McpAuthError };
