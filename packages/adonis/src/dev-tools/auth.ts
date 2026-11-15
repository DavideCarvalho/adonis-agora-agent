import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { McpAuthError } from '../mcp/auth.js';
import {
  absoluteUrl,
  actorFromClaims,
  createJwtVerifier,
  rolesFrom,
  sameIssuer,
  scopesFrom,
} from '../mcp/jwt-verifier.js';
import { bridgeAuthkitClaims } from './authkit-bridge.js';

export { actorFromClaims, discoverJwksUri, issuerMetadataUrls } from '../mcp/jwt-verifier.js';

/**
 * `devTools.auth`: OAuth for the dev tools hub (`/mcp/agora`) with any authorization server.
 *
 * The hub publishes `authorizationServers` in its RFC 9728 protected-resource metadata, answers a
 * refused request with `WWW-Authenticate: Bearer resource_metadata=…` (so an MCP client opens the
 * login), and hands every bearer token to `verify`. The principal `verify` returns is what the
 * consoles' `authorize` callbacks see: through {@link devToolsPrincipal}, and as `ctx.auth.user` when
 * it carries a `user`.
 */
export interface DevToolsAuth {
  /** Issuer URLs advertised as `authorization_servers` (RFC 9728). */
  authorizationServers: string[];
  /** Advertised as `scopes_supported`. */
  scopes?: string[];
  /** Advertised as `resource_name`. Default `'Agora dev tools'`. */
  resourceName?: string;
  /**
   * Validate a bearer token. Return the principal, or `null` when the token is not one of yours
   * (it is then left on the request for an `authorizeByToken` console). Throw `McpAuthError` to
   * refuse a token you recognized (bad audience, expired…): `401` with `error="invalid_token"`, or
   * `403` with `error="insufficient_scope"`. Any other throw is a `401` too, and is logged.
   */
  verify(token: string, context: DevToolsAuthContext): Promise<DevToolsPrincipal | null>;
}

/** What `verify` knows about the request. */
export interface DevToolsAuthContext {
  ctx: HttpContext;
  app: ApplicationService;
  /** The hub's resource URL (`https://app.example.com/mcp/agora`), the audience a token must name. */
  resource: string;
}

/** Who a verified token belongs to. */
export interface DevToolsPrincipal {
  /** The token's subject (`sub`). Audit lines show it as `user:<subject>`. */
  subject: string;
  /** The token's claims (a JWT payload, or an introspection response). */
  claims: Record<string, unknown>;
  /** Roles of the caller, when the token carries them. Default: a string array under `claims.roles`. */
  roles?: string[];
  /** Scopes the token was granted. */
  scopes?: string[];
  /** The app's user for this subject. Set → `ctx.auth.user` is this user during the request. */
  user?: unknown;
  /**
   * Who is really acting, when the token was minted for an impersonation (RFC 8693 `act` claim).
   * Audit lines use `actor.sub` when set; authorization stays on `subject`.
   */
  actor?: { sub: string; email?: string };
}

const principals = new WeakMap<object, DevToolsPrincipal>();

/**
 * The principal `devTools.auth` verified for this request, or `undefined` (no token, a token the
 * hub's auth did not recognize, or not a dev tools request). Read it in an `authorize`:
 *
 * ```ts
 * authorize: (ctx) => devToolsPrincipal(ctx)?.roles?.includes('admin') === true
 * ```
 */
export function devToolsPrincipal(ctx: object): DevToolsPrincipal | undefined {
  return principals.get(ctx);
}

/**
 * Put the principal on the request: {@link devToolsPrincipal}, and with a `user`, `ctx.auth` answers
 * for it (`user`, `check()`, `authenticate()`, `checkUsing()`…) the way a guard that signed it in
 * would, so `authorizeByRoles(…)` and `(ctx) => ctx.auth.user?.isAdmin` work unchanged.
 */
export function bindDevToolsPrincipal(ctx: HttpContext, principal: DevToolsPrincipal): void {
  principals.set(ctx, principal);
  if (principal.user === undefined || principal.user === null) return;
  const user = principal.user;
  const holder = ctx as unknown as { auth?: object };
  const original = holder.auth;
  const overrides: Record<string, unknown> = {
    user,
    isAuthenticated: true,
    authenticationAttempted: true,
    check: async () => true,
    checkUsing: async () => true,
    authenticate: async () => user,
    authenticateUsing: async () => user,
    getUserOrFail: () => user,
  };
  if (original === undefined || original === null) {
    holder.auth = { ...overrides, use: () => overrides };
    return;
  }
  holder.auth = new Proxy(original, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(overrides, key)) return overrides[key];
      // `target` as `this`: @adonisjs/auth's Authenticator keeps its state in private fields.
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Resolve the app's user for a verified token. `null` → the account is gone (`401`). */
export type DevToolsUserResolver = (
  claims: Record<string, unknown>,
  context: DevToolsAuthContext,
) => unknown | Promise<unknown>;

interface PrincipalOptions {
  rolesClaim?: string;
  requiredScopes?: string[];
  resolveUser?: DevToolsUserResolver;
}

async function principalOf(
  claims: Record<string, unknown>,
  options: PrincipalOptions,
  context: DevToolsAuthContext,
): Promise<DevToolsPrincipal> {
  const subject = claims.sub;
  if (typeof subject !== 'string' || subject === '') {
    throw new McpAuthError('invalid_token: the token has no subject');
  }
  const scopes = scopesFrom(claims);
  const missing = (options.requiredScopes ?? []).filter((s) => !scopes.includes(s));
  if (missing.length > 0) {
    throw new McpAuthError(
      `insufficient_scope: the dev tools need the scope "${missing.join(' ')}"`,
      {
        status: 403,
      },
    );
  }
  const roles = rolesFrom(claims[options.rolesClaim ?? 'roles']);
  const actor = actorFromClaims(claims);
  const principal: DevToolsPrincipal = {
    subject,
    claims,
    scopes,
    ...(roles !== undefined ? { roles } : {}),
    ...(actor !== undefined ? { actor } : {}),
  };
  if (options.resolveUser !== undefined) {
    const user = await options.resolveUser(claims, context);
    if (user === null || user === undefined) {
      throw new McpAuthError('invalid_token: the account no longer exists');
    }
    principal.user = user;
  }
  return principal;
}

function audiencesOf(
  audience: string | string[] | undefined,
  context: DevToolsAuthContext,
): string[] {
  if (audience === undefined) return [context.resource];
  return Array.isArray(audience) ? audience : [audience];
}

// ── jwtAuth ─────────────────────────────────────────────────────────────────

export interface JwtAuthOptions {
  /** The authorization server's issuer: the exact `iss` of its tokens, and what the hub advertises. */
  issuer: string;
  /**
   * Accepted `aud` values. Default: the hub's own resource URL (`https://app.example.com/mcp/agora`),
   * as RFC 8707 resource indicators bind it.
   */
  audience?: string | string[];
  /** The JWKS URL. Default: `jwks_uri` from the issuer's OpenID / OAuth server metadata. */
  jwksUri?: string;
  /** Accepted signing algorithms. Default: the asymmetric ones `jose` supports. */
  algorithms?: string[];
  /** Scopes the hub advertises in its metadata (`scopes_supported`). */
  scopes?: string[];
  /** Scopes every token must carry, else `403 insufficient_scope`. */
  requiredScopes?: string[];
  /** The claim holding the caller's roles. Default `'roles'`. */
  rolesClaim?: string;
  /** Clock skew allowed on `exp`/`nbf`, in seconds. Default `30`. */
  clockTolerance?: number;
  /** Find the app's user for the token (e.g. `(claims) => User.find(claims.sub)`). */
  resolveUser?: DevToolsUserResolver;
  /** Advertised as `resource_name`. */
  resourceName?: string;
  /**
   * Put a verified user token on the request as an authkit identity (`ctx.authkit`, global roles
   * from `rolesClaim`), so `getAuthkit(ctx)` and `authkitDashboardAuthorize` see the caller.
   * Default: when `@adonis-agora/authkit-client` is installed. Set `false` for an issuer that is not
   * authkit.
   */
  authkit?: boolean;
}

/**
 * Verify JWT access tokens of an OAuth / OIDC authorization server (authkit with JWT access tokens,
 * Sésame with `accessTokenFormat: 'jwt'`, Auth0, Keycloak, Entra ID…) against its JWKS: signature,
 * `iss`, `aud` (the hub's URL by default) and `exp`/`nbf`. The JWKS URL is discovered from the
 * issuer's metadata on first use and its keys are cached (refetched when a token names an unknown key).
 *
 * A token with another `iss`, or that is not a JWT, is not this auth's: it is left on the request
 * for an `authorizeByToken` console.
 *
 * With `@adonis-agora/authkit-client` installed (or `authkit: true`), a verified user token is also
 * put on the request as an authkit identity (`ctx.authkit`, and `ctx.auth` with `authkitClientGuard`),
 * so a console gated by `authkitDashboardAuthorize` accepts the caller.
 */
export function jwtAuth(options: JwtAuthOptions): DevToolsAuth {
  absoluteUrl(options.issuer, 'jwtAuth `issuer`');
  if (options.jwksUri !== undefined) absoluteUrl(options.jwksUri, 'jwtAuth `jwksUri`');
  const verifyJwt = createJwtVerifier(options);

  return {
    authorizationServers: [options.issuer],
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    ...(options.resourceName !== undefined ? { resourceName: options.resourceName } : {}),
    async verify(token, context) {
      const payload = await verifyJwt(token, audiencesOf(options.audience, context));
      if (payload === null) return null;
      const principal = await principalOf(payload, options, context);
      await bridgeAuthkitClaims(context.ctx, payload, {
        mode: options.authkit,
        globalRolesClaim: options.rolesClaim,
      });
      return principal;
    },
  };
}

// ── introspectionAuth ───────────────────────────────────────────────────────

export interface IntrospectionAuthOptions {
  /** The authorization server's issuer, advertised in the metadata (and checked against `iss` when the response has one). */
  issuer: string;
  /** The RFC 7662 introspection endpoint. */
  endpoint: string;
  /** The hub's client credentials at the authorization server (HTTP Basic). */
  clientId: string;
  clientSecret: string;
  /** Accepted `aud` values. Default: the hub's resource URL. */
  audience?: string | string[];
  /**
   * Refuse a token whose introspection response has no `aud` (one not bound to a resource, which
   * any resource of the server could have been issued). Default `true`.
   */
  requireAudience?: boolean;
  scopes?: string[];
  requiredScopes?: string[];
  rolesClaim?: string;
  resolveUser?: DevToolsUserResolver;
  resourceName?: string;
}

/**
 * Verify opaque access tokens with the authorization server's introspection endpoint (RFC 7662):
 * one `POST` per request. `active: false` → `401`; an `aud` that does not name the hub, or none
 * (unless `requireAudience: false`) → `401`. An unreachable endpoint → `503`.
 */
export function introspectionAuth(options: IntrospectionAuthOptions): DevToolsAuth {
  absoluteUrl(options.issuer, 'introspectionAuth `issuer`');
  absoluteUrl(options.endpoint, 'introspectionAuth `endpoint`');
  // RFC 6749 §2.3.1 (client_secret_basic): id and secret are form-urlencoded, then joined by `:`
  // and base64-encoded — so a `:` in the id cannot split it.
  const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  const basic = Buffer.from(
    `${formEncode(options.clientId)}:${formEncode(options.clientSecret)}`,
  ).toString('base64');

  return {
    authorizationServers: [options.issuer],
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    ...(options.resourceName !== undefined ? { resourceName: options.resourceName } : {}),
    async verify(token, context) {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(
          `[@adonis-agora/agent] token introspection at ${options.endpoint} answered ${response.status}`,
        );
      }
      const claims = (await response.json()) as Record<string, unknown>;
      if (claims.active !== true) throw new McpAuthError('invalid_token: the token is not active');
      if (typeof claims.iss === 'string' && !sameIssuer(claims.iss, options.issuer)) {
        throw new McpAuthError('invalid_token: the token was issued by another server');
      }
      if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
        throw new McpAuthError('invalid_token: the token expired');
      }
      const aud = claims.aud;
      if (aud === undefined && options.requireAudience !== false) {
        throw new McpAuthError('invalid_token: the token names no audience (resource)');
      }
      if (aud !== undefined) {
        const given = Array.isArray(aud) ? aud : [aud];
        const accepted = audiencesOf(options.audience, context);
        if (!given.some((a) => typeof a === 'string' && accepted.includes(a))) {
          throw new McpAuthError('invalid_token: the token was not issued for this resource');
        }
      }
      return principalOf(claims, options, context);
    },
  };
}

// ── validation (provider + doctor) ──────────────────────────────────────────

/** What is wrong with a `devTools.auth` value, read structurally. Empty → usable. */
export function devToolsAuthProblems(auth: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof auth !== 'object' || auth === null) {
    return {
      errors: ['`devTools.auth` must be an object (e.g. `jwtAuth({ issuer })`).'],
      warnings,
    };
  }
  const value = auth as Partial<DevToolsAuth>;
  if (typeof value.verify !== 'function') {
    errors.push('`devTools.auth.verify` is missing: no token can be verified.');
  }
  const servers = value.authorizationServers;
  if (!Array.isArray(servers) || servers.length === 0) {
    warnings.push(
      '`devTools.auth.authorizationServers` is empty: MCP clients cannot discover where to sign in.',
    );
  } else {
    for (const server of servers) {
      try {
        absoluteUrl(String(server), '');
      } catch {
        errors.push(
          `\`devTools.auth.authorizationServers\` has ${JSON.stringify(server)}, not an absolute http(s) URL.`,
        );
      }
    }
  }
  return { errors, warnings };
}

/** The issuers of a `devTools.auth`, for messages. */
export function devToolsAuthIssuers(auth: unknown): string[] {
  const servers = (auth as Partial<DevToolsAuth> | null | undefined)?.authorizationServers;
  return Array.isArray(servers) ? servers.map(String) : [];
}
