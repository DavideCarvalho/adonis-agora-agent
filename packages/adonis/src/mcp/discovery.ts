/**
 * The OAuth discovery surface of the MCP server (MCP Authorization spec, RFC 9728, RFC 6750 §3): the
 * protected-resource metadata document, its well-known URL, and the `WWW-Authenticate` challenge a
 * `401`/`403` carries so an MCP client knows where to start the login.
 *
 * Pure functions over strings — the provider decides which origin to feed them (the configured
 * `publicUrl`, or the request's own protocol and `Host` as a fallback).
 */

import type { McpOAuthMetadata } from './auth.js';

/** Normalize a route prefix the way the provider mounts it: no leading/trailing slashes. */
export function normalizeMcpPath(path: string | undefined): string {
  return (path ?? 'mcp').replace(/^\/+|\/+$/g, '');
}

/**
 * Validate `publicUrl` from `config/mcp.ts` and reduce it to its origin (`https://app.example.com`).
 * Only an origin is meaningful: the MCP endpoint and its well-known document are mounted at fixed
 * paths on this app, so a path, query, or fragment would advertise URLs the app does not serve.
 */
export function publicOrigin(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(
      `[@adonis-agora/agent] \`publicUrl\` in config/mcp.ts is not an absolute URL: ${JSON.stringify(publicUrl)}`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `[@adonis-agora/agent] \`publicUrl\` in config/mcp.ts must be http(s), got ${JSON.stringify(publicUrl)}`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `[@adonis-agora/agent] \`publicUrl\` in config/mcp.ts must be an origin only (e.g. "https://app.example.com"), got ${JSON.stringify(publicUrl)}`,
    );
  }
  return url.origin;
}

/** The protected resource (RFC 9728 `resource`): the URL an MCP client points at, e.g. `https://app.example.com/mcp`. */
export function mcpResourceUrl(origin: string, path: string): string {
  return `${origin}/${normalizeMcpPath(path)}`;
}

/** Where the protected-resource metadata lives (RFC 9728 §3.1): the well-known segment goes between host and path. */
export function protectedResourceMetadataUrl(origin: string, path: string): string {
  return `${origin}/.well-known/oauth-protected-resource/${normalizeMcpPath(path)}`;
}

/** The RFC 9728 protected-resource metadata document. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

/** Build the RFC 9728 document for the MCP endpoint at `origin` + `path`. */
export function protectedResourceMetadata(
  meta: McpOAuthMetadata,
  origin: string,
  path: string,
): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(origin, path),
    authorization_servers: [meta.issuer],
    scopes_supported: meta.scopesSupported,
    bearer_methods_supported: ['header'],
    resource_name: meta.resourceName,
  };
}

/** Options for {@link wwwAuthenticateChallenge}. */
export interface WwwAuthenticateOptions {
  /**
   * The RFC 6750 error code. `invalid_token` when the request carried a token that was refused,
   * `insufficient_scope` for a `403`, omitted when no token was sent at all (RFC 6750 §3.1).
   */
  error?: 'invalid_token' | 'insufficient_scope';
  /** The metadata URL (RFC 9728 §5.1). Set only when the auth strategy exposes OAuth metadata. */
  resourceMetadataUrl?: string;
}

/**
 * The `WWW-Authenticate` value for a `401`/`403` from the MCP endpoint — e.g.
 * `Bearer error="invalid_token", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"`.
 * `resource_metadata` is what makes an MCP client discover the authorization server and open the login.
 */
export function wwwAuthenticateChallenge(options: WwwAuthenticateOptions = {}): string {
  const params: string[] = [];
  if (options.error !== undefined) params.push(`error="${options.error}"`);
  if (options.resourceMetadataUrl !== undefined) {
    params.push(`resource_metadata="${quote(options.resourceMetadataUrl)}"`);
  }
  return params.length === 0 ? 'Bearer' : `Bearer ${params.join(', ')}`;
}

/** Escape a value for an RFC 7230 quoted-string. */
function quote(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}
