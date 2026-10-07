/**
 * Announce a protected resource to an authorization server running in the same process —
 * `@adonis-agora/authkit-server`'s `mcp` option reads this registry when a client asks for a token
 * (RFC 8707 `resource`), so the MCP URL never has to be repeated in its config. The contract is the
 * global symbol, not a module: neither package imports the other.
 */
const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

export interface OAuthResourceRegistration {
  /** The exact resource URL. */
  url?: string;
  /** A path on the issuer's origin, when the public URL is not known at boot. */
  path?: string;
  scopes?: string[];
}

export function registerOAuthResource(resource: OAuthResourceRegistration): void {
  const slot = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(slot[REGISTRY])) slot[REGISTRY] = [];
  const list = slot[REGISTRY] as OAuthResourceRegistration[];
  if (!list.some((r) => r.url === resource.url && r.path === resource.path)) list.push(resource);
}
