import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';

/**
 * Bridges an MCP sign-in (an authkit access token the dev endpoint verified) into the request, so a
 * console `authorize(ctx)` sees the signed-in account exactly as it would on a browser request:
 * `getAuthkit(ctx)` / `ctx.authkit` answers `check()`, `getIdentity()`, `hasGlobalRole()` and
 * `getUser()`, and an `authkitClientGuard` default guard authenticates `ctx.auth` from it.
 *
 * Also binds the account as this request's bearer caller on `authkit.server` (its
 * `bindBearerAccount`, when the installed authkit-server has it), so an `authorize` written with
 * authkit-server's `getAccountId(ctx)` / `realAccountId(ctx)` sees the account too.
 *
 * Both peers are optional: `@adonis-agora/authkit-client` is imported lazily (its
 * `bindAuthkitIdentity` / `identityFromClaims`, the same helpers an app uses for a remote authkit),
 * and `@adonis-agora/authkit-server` is only read through the container. Without authkit-client a
 * minimal authenticator stands in.
 */

/** The authkit `Identity` shape (from `@adonis-agora/authkit-core`), re-declared. */
export interface BridgedIdentity {
  userId: string;
  email: string;
  globalRoles: string[];
  profile?: { name?: string; avatarUrl?: string };
  orgId?: string | null;
  orgSlug?: string | null;
  orgRole?: string | null;
  /** The real actor of an impersonation (`act` claim). */
  actor?: { sub: string; email?: string };
  issuedAt: number;
  expiresAt: number;
  raw: Record<string, unknown>;
}

/** What `authkit.server`'s resolved config gives us, duck-typed. */
interface AuthkitServerAccounts {
  config?: {
    findAccount?: (sub: string) => Promise<AuthkitAccountLike | null>;
    resolveTokenRoles?: (
      account: AuthkitAccountLike,
      context: { clientId: string | undefined; activeOrg: null },
    ) => string[] | Promise<string[]>;
    globalRolesClaim?: string;
  };
}

interface AuthkitAccountLike {
  id: string;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  globalRoles?: string[] | null;
}

/** What the dev endpoint knows about a verified authkit token. */
export interface VerifiedAuthkitToken {
  accountId: string;
  clientId: string | undefined;
  scopes: string[];
  /** Seconds since the epoch. */
  expiresAt?: number;
}

/**
 * Build the account's {@link BridgedIdentity} from the authkit server in this process: its email,
 * profile and global roles (through the app's `resolveTokenRoles` when set). No organization is
 * bridged: a token carries no verified active org. `null` when the account no longer exists.
 */
export async function identityForToken(
  app: ApplicationService,
  token: VerifiedAuthkitToken,
): Promise<BridgedIdentity | null> {
  const service = (await app.container.make('authkit.server' as never)) as AuthkitServerAccounts;
  const config = service?.config;
  const now = Date.now();
  const base = {
    userId: token.accountId,
    issuedAt: now,
    expiresAt: token.expiresAt !== undefined ? token.expiresAt * 1000 : now + 60_000,
    orgId: null,
    orgSlug: null,
    orgRole: null,
  };
  if (typeof config?.findAccount !== 'function') {
    return { ...base, email: '', globalRoles: [], raw: { sub: token.accountId } };
  }
  const account = await config.findAccount(token.accountId);
  if (!account) return null;
  const globalRoles = config.resolveTokenRoles
    ? await config.resolveTokenRoles(account, { clientId: token.clientId, activeOrg: null })
    : (account.globalRoles ?? []);
  const roles = Array.isArray(globalRoles) ? globalRoles.filter((r) => typeof r === 'string') : [];
  return {
    ...base,
    email: account.email ?? '',
    globalRoles: roles,
    profile: {
      ...(account.name ? { name: account.name } : {}),
      ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    },
    raw: {
      sub: token.accountId,
      ...(account.email ? { email: account.email } : {}),
      [config.globalRolesClaim ?? 'roles']: roles,
      client_id: token.clientId,
      scope: token.scopes.join(' '),
    },
  };
}

/** The `Authenticator` surface of authkit-client, re-declared for the fallback. */
interface AuthenticatorLike {
  readonly identity: BridgedIdentity | null;
  readonly resolvesUser: boolean;
  getIdentity(): Promise<BridgedIdentity | null>;
  authenticate(): Promise<BridgedIdentity>;
  check(): Promise<boolean>;
  hasGlobalRole(role: string): boolean;
  getUser(): Promise<unknown>;
  getUserOrFail(): Promise<unknown>;
  toSharedProps(): Promise<{ user: unknown; globalRoles: string[] } | null>;
}

interface AuthkitClientManagerLike {
  createAuthenticator(
    ctx: HttpContext,
    options: {
      resolver: { resolver(rc: unknown): Promise<{ resolve(ctx: HttpContext): Promise<unknown> }> };
    },
  ): Promise<unknown>;
}

/** An authenticator for an app without `@adonis-agora/authkit-client` (no `resolveUser`). */
function identityAuthenticator(identity: BridgedIdentity): AuthenticatorLike {
  return {
    identity,
    resolvesUser: false,
    getIdentity: async () => identity,
    authenticate: async () => identity,
    check: async () => true,
    hasGlobalRole: (role) => identity.globalRoles.includes(role),
    getUser: async () => null,
    getUserOrFail: async () => {
      throw new Error('Not authenticated: no user for the current session');
    },
    toSharedProps: async () => ({ user: null, globalRoles: identity.globalRoles }),
  };
}

/**
 * Put `identity` on the request the way a browser session would be:
 *
 * 1. `ctx.authkit` becomes an authkit `Authenticator` resolving to it — built by the app's own
 *    authkit client (so `resolveUser`, e.g. `lucidMirror`, gives `getUser()` the app's user), or a
 *    minimal one when the app has no authkit client.
 * 2. `authkit.server`'s `bindBearerAccount(ctx, accountId)` (optional, newer authkit-server) records
 *    the account for `getAccountId(ctx)`, `realAccountId(ctx)` and `impersonationState(ctx)` (not
 *    impersonating).
 * 3. When `ctx.auth`'s default guard is `authkitClientGuard`, it is (re)authenticated from that, so
 *    `ctx.auth.user` and `ctx.auth.check()` see the account too — even after a silent-auth middleware
 *    already found no browser session on this request.
 *
 * Best effort past step 1: a guard that fails leaves `ctx.auth` as it was.
 */
export async function bridgeIdentity(
  app: ApplicationService,
  ctx: HttpContext,
  identity: BridgedIdentity,
): Promise<void> {
  await bindBearerAccount(app, ctx, identity.userId);
  await bindIdentity(ctx, identity, app);
}

/** The parts of `@adonis-agora/authkit-client` the bridge uses (>= 1.0.0-rc.7). */
interface AuthkitClientModule {
  bindAuthkitIdentity(ctx: HttpContext, identity: never): Promise<void>;
  identityFromClaims(claims: Record<string, unknown>, globalRolesClaim?: string): BridgedIdentity;
  Authenticator: new (
    ctx: HttpContext,
    deps: { resolver: { resolve(): Promise<unknown> } },
  ) => unknown;
}

let authkitClient: Promise<AuthkitClientModule | null> | undefined;

/** `@adonis-agora/authkit-client`, when the app has it (with the identity bridge); else `null`. */
export function loadAuthkitClient(): Promise<AuthkitClientModule | null> {
  authkitClient ??= import('@adonis-agora/authkit-client').then(
    (mod) => {
      const candidate = mod as unknown as Partial<AuthkitClientModule>;
      return typeof candidate.bindAuthkitIdentity === 'function' &&
        typeof candidate.identityFromClaims === 'function' &&
        typeof candidate.Authenticator === 'function'
        ? (candidate as AuthkitClientModule)
        : null;
    },
    () => null,
  );
  return authkitClient;
}

/**
 * `ctx.authkit` (and an `authkitClientGuard` `ctx.auth`) for `identity`: authkit-client's
 * `bindAuthkitIdentity` when installed, else the structural fallback below.
 */
async function bindIdentity(
  ctx: HttpContext,
  identity: BridgedIdentity,
  app?: ApplicationService,
): Promise<void> {
  const client = await loadAuthkitClient();
  if (client !== null) {
    await client.bindAuthkitIdentity(ctx, identity as never);
    return;
  }
  let authenticator: unknown;
  if (app?.container.hasBinding('authkit.client' as never)) {
    try {
      const manager = (await app.container.make(
        'authkit.client' as never,
      )) as AuthkitClientManagerLike;
      authenticator = await manager.createAuthenticator(ctx, {
        resolver: { resolver: async () => ({ resolve: async () => identity }) },
      });
    } catch {
      authenticator = undefined;
    }
  }
  (ctx as unknown as { authkit?: unknown }).authkit =
    authenticator ?? identityAuthenticator(identity);

  const auth = (ctx as unknown as { auth?: AdonisAuthLike }).auth;
  if (auth === undefined || typeof auth.use !== 'function') return;
  try {
    const guard = auth.use();
    if (guard?.driverName !== 'authkit_client' || guard.isAuthenticated === true) return;
    // A silent-auth middleware may already have tried (and found no browser session).
    guard.authenticationAttempted = false;
    await auth.check();
  } catch {
    // leave ctx.auth alone
  }
}

/** When a verified JWT is put on the request as an authkit identity. */
export interface BridgeClaimsOptions {
  /** `true`: always; `false`: never; `undefined`: when `@adonis-agora/authkit-client` is installed. */
  mode?: boolean | undefined;
  /** The claim holding the global roles. Default `'roles'`. */
  globalRolesClaim?: string | undefined;
}

/**
 * Put the claims of a JWT access token verified remotely (`jwtAuth`, `oidcAuth`) on the request as
 * an authkit identity, the way authkit-client's `bridgeAuthkitToken` does, without verifying it a
 * second time. A `client_credentials` token (`sub` = `client_id`) has no user and is not bridged.
 *
 * A token without an `email` claim (authkit's access tokens carry none today) is bound to
 * `ctx.authkit` only: the app's `resolveUser` (e.g. `lucidMirror`, which syncs the email) is not run
 * and `ctx.auth` is left alone, so a mirrored user is never overwritten with an empty email.
 * Returns whether an identity was bound.
 */
export async function bridgeAuthkitClaims(
  ctx: HttpContext | undefined,
  claims: Record<string, unknown>,
  options: BridgeClaimsOptions = {},
): Promise<boolean> {
  if (ctx === undefined || options.mode === false) return false;
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub === '') return false;
  if (typeof claims.client_id === 'string' && claims.client_id === sub) return false;
  const client = await loadAuthkitClient();
  if (client === null && options.mode !== true) return false;
  const rolesClaim = options.globalRolesClaim ?? 'roles';
  const identity =
    client !== null
      ? client.identityFromClaims(claims, rolesClaim)
      : localIdentity(claims, rolesClaim);
  if (identity.email === '') {
    (ctx as unknown as { authkit?: unknown }).authkit =
      client !== null
        ? new client.Authenticator(ctx, { resolver: { resolve: async () => identity } })
        : identityAuthenticator(identity);
    return true;
  }
  await bindIdentity(ctx, identity);
  return true;
}

/** `identityFromClaims` for an app without authkit-client (`authkit: true` forced). */
function localIdentity(claims: Record<string, unknown>, rolesClaim: string): BridgedIdentity {
  const roles = claims[rolesClaim];
  const text = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : null);
  return {
    userId: String(claims.sub),
    email: text('email') ?? '',
    globalRoles: Array.isArray(roles)
      ? roles.filter((r): r is string => typeof r === 'string')
      : [],
    profile: {
      ...(text('name') !== null ? { name: text('name') as string } : {}),
      ...(text('picture') !== null ? { avatarUrl: text('picture') as string } : {}),
    },
    orgId: text('org_id'),
    orgSlug: text('org_slug'),
    orgRole: text('org_role'),
    issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : 0,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : 0,
    raw: claims,
  };
}

/** `authkit.server`'s bearer binding, duck-typed (absent before authkit-server shipped it). */
interface AuthkitServerBearerBinding {
  bindBearerAccount?: (ctx: object, accountId: string) => void;
}

async function bindBearerAccount(
  app: ApplicationService,
  ctx: HttpContext,
  accountId: string,
): Promise<void> {
  if (!app.container.hasBinding('authkit.server' as never)) return;
  try {
    const service = (await app.container.make(
      'authkit.server' as never,
    )) as AuthkitServerBearerBinding | null;
    if (typeof service?.bindBearerAccount === 'function') service.bindBearerAccount(ctx, accountId);
  } catch {
    // an authkit server that cannot be built binds nothing
  }
}

interface AdonisAuthLike {
  use(guard?: string): {
    driverName?: string;
    isAuthenticated?: boolean;
    authenticationAttempted?: boolean;
  };
  check(): Promise<boolean>;
}
