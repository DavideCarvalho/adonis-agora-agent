import { scopeRole } from '../a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../a2a/permission-tool.js';
import { bridgeAuthkitClaims } from '../dev-tools/authkit-bridge.js';
import type { Actor } from '../types.js';
import { McpAuthError, type McpAuthFactory, POPPY_GRANT_TYPE } from './auth.js';
import {
  absoluteUrl,
  actorFromClaims,
  createJwtVerifier,
  rolesFrom,
  scopesFrom,
} from './jwt-verifier.js';

/** What `oidcAuth()` hands `toActor` for a verified access token. */
export interface OidcActorInfo {
  /** The token's subject (`sub`): the account, or the client of a `client_credentials` token. */
  subject: string;
  /** The verified claims. */
  claims: Record<string, unknown>;
  /** The token's granted scopes (`scope` / `scp`). */
  scopes: string[];
  /** Roles from `rolesClaim`, when the token carries them. */
  roles: string[] | undefined;
  /** The client the token was issued to (`client_id` / `azp`), when named. */
  clientId: string | undefined;
  /**
   * Who is really acting, for an impersonation token (RFC 8693 `act`). Use it for audit; authorize
   * on `subject`.
   */
  actor: { sub: string; email?: string } | undefined;
  /** Minted for a personal agent (Poppy, `gty: 'poppy'`): the personal-agent gate applies. */
  personalAgent: boolean;
}

/** Map a verified token to the MCP actor. Throw {@link McpAuthError} to refuse it. */
export type OidcActorResolver = (info: OidcActorInfo) => Actor | Promise<Actor>;

export interface OidcMcpAuthOptions {
  /** The authorization server's issuer: the exact `iss` of its tokens, advertised in the metadata. */
  issuer: string;
  /**
   * Accepted `aud` values: the resource URL(s) the tokens are issued for. Default: the endpoint's own
   * URL (`config.publicUrl` + path, else the request's origin + path), as RFC 8707 binds it.
   */
  resource?: string | string[];
  /** The JWKS URL. Default: `jwks_uri` from the issuer's discovery document. */
  jwksUri?: string;
  /** Accepted signing algorithms. Default: the asymmetric ones `jose` supports. */
  algorithms?: string[];
  /** Clock skew allowed on `exp`/`nbf`, in seconds. Default `30`. */
  clockTolerance?: number;
  /** Advertised as `scopes_supported`. Default `['openid', 'profile', 'email', 'offline_access', 'roles']`. */
  scopes?: string[];
  /** Scopes every token must carry, else `403 insufficient_scope`. */
  requiredScopes?: string[];
  /** The claim holding the caller's roles (authkit: its `globalRolesClaim`). Default `'roles'`. */
  rolesClaim?: string;
  /** Map the token to the acting {@link Actor}. Default `{ id: sub, roles }`. */
  toActor?: OidcActorResolver;
  /** Human label for the protected resource. Default `'Agent MCP Server'`. */
  resourceName?: string;
  /**
   * Put a verified user token on the request as an authkit identity (`ctx.authkit`, and `ctx.auth`
   * with `authkitClientGuard`). Default: when `@adonis-agora/authkit-client` is installed. Set `false`
   * for an issuer that is not authkit.
   */
  authkit?: boolean;
}

/**
 * Authenticate MCP clients with JWT access tokens of a remote OAuth / OIDC authorization server
 * (authkit-server on another host, or any issuer with a JWKS). Nothing of the authorization server
 * runs in this process: the token's signature is checked against the issuer's JWKS (found by
 * discovery, keys cached), then `iss`, `aud` (the endpoint's URL by default) and `exp`.
 *
 * The endpoint advertises the issuer in its RFC 9728 metadata and answers a refused request with
 * `WWW-Authenticate: Bearer resource_metadata=…`, so an MCP client opens the login. With authkit, list
 * the endpoint's URL in authkit-server's `mcpClients.resources` so it issues tokens for it.
 *
 * A token that is not a JWT of this issuer is "not mine" (a plain `Error`): inside {@link anyOf} the
 * next strategy gets it. A token it recognizes and refuses throws {@link McpAuthError}.
 */
export function oidcAuth(options: OidcMcpAuthOptions): McpAuthFactory {
  absoluteUrl(options.issuer, 'oidcAuth `issuer`');
  if (options.jwksUri !== undefined) absoluteUrl(options.jwksUri, 'oidcAuth `jwksUri`');
  const scopes = options.scopes ?? ['openid', 'profile', 'email', 'offline_access', 'roles'];
  const rolesClaim = options.rolesClaim ?? 'roles';
  const toActor: OidcActorResolver =
    options.toActor ??
    (({ subject, roles }) => ({ id: subject, ...(roles !== undefined ? { roles } : {}) }));
  const verifyJwt = createJwtVerifier(options);

  return async () => ({
    oauth: {
      issuer: options.issuer,
      scopesSupported: scopes,
      resourceName: options.resourceName ?? 'Agent MCP Server',
    },
    async verify(token, context) {
      const audiences =
        options.resource !== undefined
          ? Array.isArray(options.resource)
            ? options.resource
            : [options.resource]
          : context !== undefined
            ? [context.resource]
            : [];
      if (audiences.length === 0) {
        throw new McpAuthError('invalid_token: no resource to check the token audience against');
      }
      const claims = await verifyJwt(token, audiences);
      if (claims === null) {
        // Not a JWT of this issuer: plain `Error`, so `anyOf` tries the next strategy.
        throw new Error(`not an access token of ${options.issuer}`);
      }
      const subject = claims.sub as string;
      const tokenScopes = scopesFrom(claims);
      const missing = (options.requiredScopes ?? []).filter((s) => !tokenScopes.includes(s));
      if (missing.length > 0) {
        throw new McpAuthError(`insufficient_scope: this endpoint needs "${missing.join(' ')}"`, {
          status: 403,
        });
      }
      const clientId =
        typeof claims.client_id === 'string'
          ? claims.client_id
          : typeof claims.azp === 'string'
            ? claims.azp
            : undefined;
      const actor = actorFromClaims(claims);
      const personalAgent = claims.gty === POPPY_GRANT_TYPE;
      const resolved = await toActor({
        subject,
        claims,
        scopes: tokenScopes,
        roles: rolesFrom(claims[rolesClaim]),
        clientId,
        actor,
        personalAgent,
      });
      // As `authKitAuth`: a personal agent reaches only the tools of the scopes its user granted.
      const acting: Actor = personalAgent
        ? {
            ...resolved,
            roles: [
              ...new Set([
                ...(resolved.roles ?? []),
                PERSONAL_AGENT_ROLE,
                ...tokenScopes.map(scopeRole),
              ]),
            ],
          }
        : resolved;
      await bridgeAuthkitClaims(context?.ctx, claims, {
        mode: options.authkit,
        globalRolesClaim: rolesClaim,
      });
      return {
        token,
        clientId: clientId ?? '',
        scopes: tokenScopes,
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
        extra: { actor: acting, claims, ...(actor !== undefined ? { act: actor } : {}) },
      };
    },
  });
}
