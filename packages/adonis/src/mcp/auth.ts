import type { ApplicationService } from '@adonisjs/core/types';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Actor } from '../types.js';

/**
 * Runtime context a {@link McpAuthFactory} thunk receives when the MCP provider builds the configured
 * auth at boot. Carries the booted application so a driver can resolve a peer's service if it needs to.
 */
export interface McpAuthContext {
  app: ApplicationService;
}

/**
 * OAuth metadata the MCP server advertises at `/.well-known/oauth-protected-resource{path}` (RFC 9728)
 * so an MCP client can discover how to obtain a token. Omitted → the server exposes no OAuth metadata
 * endpoint and clients must authenticate another way (e.g. a static API key).
 */
export interface McpOAuthMetadata {
  /** The OAuth 2.0 / OIDC authorization server (the authkit issuer, e.g. `http://localhost:3333/oidc`). */
  issuer: string;
  /** Authorization endpoint the MCP client redirects to (e.g. `${issuer}/auth`). */
  authorizationEndpoint: string;
  /** Token endpoint the MCP client exchanges the code at (e.g. `${issuer}/token`). */
  tokenEndpoint: string;
  /** Scopes supported by the authorization server. */
  scopesSupported: string[];
  /** Human label for the protected resource. */
  resourceName: string;
}

/**
 * MCP `AuthInfo` with a typed acting {@link Actor} in `extra`. The MCP auth strategies
 * (`authKitAuth`/`apiKeyAuth`) and the open-mode fallback all produce this shape, so consumers can
 * read `extra.actor` without a runtime guard — or resolve it from a generic SDK `AuthInfo` with
 * `actorFromAuthInfo`.
 */
export interface McpAuthInfo extends Omit<AuthInfo, 'extra'> {
  extra: { actor: Actor };
}

/**
 * A configured MCP auth strategy. `verify` validates a bearer token and resolves the acting {@link Actor}
 * (attached to `extra.actor` as a typed {@link McpAuthInfo}); it MUST throw when the token is
 * missing/invalid/expired. The same `AuthInfo` is surfaced to the `tools/list` / `tools/call` handlers
 * as `extra.authInfo`, so the actor the tool registry gates against is exactly the one the auth
 * strategy resolved — consumers can read it with `authInfo.extra.actor` or `actorFromAuthInfo`.
 */
export interface McpAuth {
  /** OAuth metadata to advertise, resolved lazily (the authkit peer may not be bootable until first use). */
  oauth?: McpOAuthMetadata | (() => McpOAuthMetadata | Promise<McpOAuthMetadata>);
  /**
   * Validate `token` and resolve the acting actor as a typed `McpAuthInfo`. Throws on rejection:
   * {@link McpAuthError} for a deliberate refusal (its `status` and message reach the client), any
   * other `Error` for a token this strategy does not recognize (→ `401`).
   */
  verify(token: string): Promise<McpAuthInfo>;
}

/**
 * A typed refusal from an MCP auth strategy: the token was recognized and deliberately refused (a
 * client that is not allowed on this endpoint, an account that left the tenant, a revoked grant).
 *
 * Throw it from `verify` — or from the `toActor` of `authKitAuth()` / `apiKeyAuth()` — and the
 * provider answers with its `status` and message, plus the matching `WWW-Authenticate` challenge:
 * `401` → `error="invalid_token"`, `403` → `error="insufficient_scope"`.
 *
 * Inside {@link anyOf} it is also a stop signal: a strategy that throws `McpAuthError` has claimed
 * the token, so the remaining strategies are not tried. Any other error means "not my token" and
 * the next strategy gets its turn.
 *
 * ```ts
 * authKitAuth({
 *   toActor: ({ accountId, clientId }) => {
 *     if (clientId === 'web') throw new McpAuthError('token was not issued for MCP')
 *     return { id: accountId }
 *   },
 * })
 * ```
 */
export class McpAuthError extends Error {
  /** HTTP status of the refusal: `401` (the token does not authenticate) or `403` (it does, but may not do this). */
  readonly status: 401 | 403;

  constructor(message: string, options: { status?: 401 | 403; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'McpAuthError';
    this.status = options.status ?? 401;
  }
}

/**
 * A configured MCP auth strategy, as a lazy thunk the provider calls at boot. Each factory lazily
 * imports / resolves its peer inside the thunk, so nothing loads until the strategy is actually selected.
 */
export type McpAuthFactory = (ctx: McpAuthContext) => McpAuth | Promise<McpAuth>;

/**
 * Resolve a `McpAuth` config value (a ready instance or a lazy factory) at provider boot.
 */
export async function resolveMcpAuth(
  auth: McpAuth | McpAuthFactory,
  ctx: McpAuthContext,
): Promise<McpAuth> {
  if (typeof auth === 'function') {
    return auth(ctx);
  }
  return auth;
}

// ── authKitAuth ─────────────────────────────────────────────────────────────

/** Shape of the authkit `OidcService` the MCP auth resolves from the container. Duck-typed. */
interface AuthKitServiceLike {
  config: { issuer: string };
  provider: {
    AccessToken: {
      find(token: string): Promise<AuthKitAccessTokenLike | undefined>;
    };
    /** Absent on a provider that does not persist grants; then no grant is loaded. */
    Grant?: {
      find(grantId: string): Promise<AuthKitGrant | undefined>;
    };
  };
}

/** Shape of an oidc-provider access token instance as returned by `AccessToken.find`. */
interface AuthKitAccessTokenLike {
  accountId: string;
  clientId?: string;
  grantId?: string;
  scope?: string;
  exp?: number;
  extra?: Record<string, unknown>;
  isExpired: boolean;
}

/**
 * The organization authkit bound to a grant at consent time (the active org of the session that
 * approved it). Stored on the grant as `activeOrg`.
 */
export interface AuthKitActiveOrg {
  orgId: string;
  orgSlug?: string;
  orgRole?: string;
}

/**
 * The oidc-provider `Grant` behind an access token — the authorization the user gave to a client.
 * Duck-typed: only the fields this package reads are named; the rest of the stored grant is there too.
 */
export interface AuthKitGrant {
  accountId?: string;
  clientId?: string;
  /** Set by authkit at consent when the session had an active organization. */
  activeOrg?: unknown;
  [key: string]: unknown;
}

/** What `authKitAuth()` hands `toActor` for a verified access token. */
export interface AuthKitActorInfo {
  /** The account the token was issued to. */
  accountId: string;
  /** The token's granted scopes. */
  scopes: string[];
  /** The client the token was issued to — refuse clients that should not reach MCP by throwing {@link McpAuthError}. */
  clientId: string | undefined;
  /** The grant id the token belongs to, when the provider tracks one. */
  grantId: string | undefined;
  /** The grant itself (loaded per request, so a revoked grant stops the token right away). */
  grant: AuthKitGrant | undefined;
  /** The organization authkit bound to the grant at consent — the tenant the user authorized. */
  activeOrg: AuthKitActiveOrg | undefined;
  /** Extra claims stored on the access token (`extraTokenClaims`), if any. */
  extra: Record<string, unknown> | undefined;
}

/**
 * How `authKitAuth()` maps an access token to the MCP actor. Defaults to the account id. Throw
 * {@link McpAuthError} to refuse the token (e.g. a client that is not allowed on this endpoint).
 */
export type AuthKitActorResolver = (info: AuthKitActorInfo) => Actor | Promise<Actor>;

/** Options for {@link authKitAuth}. */
export interface AuthKitMcpAuthOptions {
  /** Scopes the authorization server advertises. Defaults to the standard authkit scopes. */
  scopes?: string[];
  /** Map a validated access token to the acting {@link Actor}. Defaults to `{ id: accountId }`. */
  toActor?: AuthKitActorResolver;
  /** Human label for the protected resource. Defaults to `'Agent MCP Server'`. */
  resourceName?: string;
}

/**
 * Authenticate MCP clients with `@adonis-agora/authkit-server`: verifies the bearer token against the
 * authkit OIDC provider's stored access tokens (`provider.AccessToken.find`) and advertises OAuth
 * metadata derived from the issuer so MCP clients can run the full OAuth login flow.
 *
 * The authkit peer is resolved lazily — the `verify`/`oauth` accessors touch the container only when
 * a request actually arrives (by then the app is fully booted and the authkit keystore/encryption
 * services are ready). `@adonis-agora/authkit-server` stays an optional dependency. Throws a clear
 * error at first use if the binding isn't resolvable (authkit not installed / provider not registered).
 */
export function authKitAuth(options: AuthKitMcpAuthOptions = {}): McpAuthFactory {
  const scopes = options.scopes ?? ['openid', 'profile', 'email', 'offline_access', 'roles'];
  const toActor: AuthKitActorResolver = options.toActor ?? (({ accountId }) => ({ id: accountId }));

  return async ({ app }) => {
    let servicePromise: Promise<AuthKitServiceLike> | undefined;

    const getService = (): Promise<AuthKitServiceLike> => {
      servicePromise ??= resolveAuthKitService(app);
      return servicePromise;
    };

    const oauth = async (): Promise<McpOAuthMetadata> => {
      const service = await getService();
      const issuer = service.config.issuer;
      return {
        issuer,
        authorizationEndpoint: `${issuer}/auth`,
        tokenEndpoint: `${issuer}/token`,
        scopesSupported: scopes,
        resourceName: options.resourceName ?? 'Agent MCP Server',
      };
    };

    return {
      oauth,
      async verify(token) {
        const service = await getService();
        const at = await service.provider.AccessToken.find(token);
        if (!at) {
          // Not an access token this issuer knows — plain `Error`, so `anyOf` tries the next strategy.
          throw new Error('invalid or expired access token');
        }
        if (at.isExpired) {
          throw new McpAuthError('invalid or expired access token');
        }
        let grant: AuthKitGrant | undefined;
        if (at.grantId !== undefined && service.provider.Grant !== undefined) {
          grant = await service.provider.Grant.find(at.grantId);
          if (grant === undefined) {
            // The user revoked the authorization; the token must not outlive it.
            throw new McpAuthError('authorization revoked');
          }
        }
        const tokenScopes = (at.scope ?? '').split(' ').filter(Boolean);
        const actor = await toActor({
          accountId: at.accountId,
          scopes: tokenScopes,
          clientId: at.clientId,
          grantId: at.grantId,
          grant,
          activeOrg: readActiveOrg(grant?.activeOrg),
          extra: at.extra,
        });
        return {
          token,
          clientId: at.clientId ?? '',
          scopes: tokenScopes,
          ...(at.exp !== undefined ? { expiresAt: at.exp } : {}),
          extra: { actor },
        };
      },
    };
  };
}

/** Narrow the grant's stored `activeOrg` to {@link AuthKitActiveOrg}; anything without an `orgId` string is no org. */
function readActiveOrg(value: unknown): AuthKitActiveOrg | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.orgId !== 'string' || candidate.orgId === '') return undefined;
  return {
    orgId: candidate.orgId,
    ...(typeof candidate.orgSlug === 'string' ? { orgSlug: candidate.orgSlug } : {}),
    ...(typeof candidate.orgRole === 'string' ? { orgRole: candidate.orgRole } : {}),
  };
}

/**
 * Resolve the authkit `OidcService` from the container. `@adonis-agora/authkit-server` augments
 * `ContainerBindings` with `'authkit.server'`, so `make` is fully typed with no cast.
 */
async function resolveAuthKitService(app: ApplicationService): Promise<AuthKitServiceLike> {
  try {
    return await app.container.make('authkit.server');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[@adonis-agora/agent] \`authKitAuth()\` could not resolve the authkit server (${message}). Is \`@adonis-agora/authkit-server\` installed and its provider registered in adonisrc.ts?`,
    );
  }
}

// ── apiKeyAuth ──────────────────────────────────────────────────────────────

/** Resolve the MCP actor from a validated API key. Defaults to `{ id: apiKey }`. */
export type ApiKeyActorResolver = (apiKey: string) => Actor | Promise<Actor>;

/** Options for {@link apiKeyAuth}. */
export interface ApiKeyMcpAuthOptions {
  /** Static API keys clients present in `Authorization: Bearer <key>`. */
  apiKeys: string[];
  /** Map a validated API key to the acting {@link Actor}. Defaults to `{ id: apiKey }`. */
  toActor?: ApiKeyActorResolver;
}

/**
 * Authenticate MCP clients with a static list of API keys (no OAuth metadata). Intended for trusted
 * gateway / machine-to-machine integrations where the host proxies auth and this server just
 * checks the key. Keys are compared with a constant-time compare to resist timing attacks.
 */
export function apiKeyAuth(options: ApiKeyMcpAuthOptions): McpAuthFactory {
  const keys = new Set(options.apiKeys);
  const toActor: ApiKeyActorResolver = options.toActor ?? ((apiKey) => ({ id: apiKey }));
  return async () => {
    return {
      async verify(token) {
        if (![...keys].some((key) => timingSafeEqual(key, token))) {
          throw new Error('invalid API key');
        }
        const actor = await toActor(token);
        return { token, clientId: token, scopes: [], extra: { actor } };
      },
    };
  };
}

/** Constant-time string comparison (no `node:crypto` import at module top to keep the browser-safe build). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── anyOf ───────────────────────────────────────────────────────────────────

/**
 * Accept more than one kind of bearer token on the same MCP endpoint — e.g. OAuth access tokens from
 * MCP clients that logged in through the browser AND personal access tokens for machine integrations:
 *
 * ```ts
 * auth: anyOf(
 *   authKitAuth({ toActor }),
 *   { verify: verifyPersonalAccessToken },
 * )
 * ```
 *
 * Strategies are tried in order and the first that verifies the token wins. A strategy that throws a
 * plain `Error` passes ("not my token"); one that throws {@link McpAuthError} has claimed the token and
 * refused it, so the chain stops there with that refusal. When every strategy passes, the last error
 * is rethrown.
 *
 * OAuth metadata comes from the first strategy that exposes it, so the RFC 9728 document and the
 * `WWW-Authenticate` challenge still point MCP clients at the login flow.
 */
export function anyOf(...strategies: Array<McpAuth | McpAuthFactory>): McpAuthFactory {
  if (strategies.length === 0) {
    throw new Error('[@adonis-agora/agent] `anyOf()` needs at least one MCP auth strategy');
  }
  return async (ctx) => {
    const resolved = await Promise.all(strategies.map((strategy) => resolveMcpAuth(strategy, ctx)));
    const oauth = resolved.find((strategy) => strategy.oauth !== undefined)?.oauth;
    return {
      ...(oauth !== undefined ? { oauth } : {}),
      async verify(token) {
        let lastError: unknown;
        for (const strategy of resolved) {
          try {
            return await strategy.verify(token);
          } catch (error) {
            if (error instanceof McpAuthError) throw error;
            lastError = error;
          }
        }
        throw lastError;
      },
    };
  };
}
