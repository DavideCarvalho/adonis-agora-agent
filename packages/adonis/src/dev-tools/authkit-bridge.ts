import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';

/**
 * Bridges an MCP sign-in (an authkit access token the dev endpoint verified) into the request, so a
 * console `authorize(ctx)` sees the signed-in account exactly as it would on a browser request:
 * `getAuthkit(ctx)` / `ctx.authkit` answers `check()`, `getIdentity()`, `hasGlobalRole()` and
 * `getUser()`, and an `authkitClientGuard` default guard authenticates `ctx.auth` from it.
 *
 * Structural only: neither `@adonis-agora/authkit-server` nor `@adonis-agora/authkit-client` is
 * imported. Both are optional.
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
 * 2. When `ctx.auth`'s default guard is `authkitClientGuard`, it is (re)authenticated from that, so
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
  let authenticator: unknown;
  if (app.container.hasBinding('authkit.client' as never)) {
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

interface AdonisAuthLike {
  use(guard?: string): {
    driverName?: string;
    isAuthenticated?: boolean;
    authenticationAttempted?: boolean;
  };
  check(): Promise<boolean>;
}
