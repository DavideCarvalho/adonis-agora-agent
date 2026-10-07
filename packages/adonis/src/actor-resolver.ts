import type { ActorResolver } from './spi/actor-resolver.js';
import type { Actor, AgentDefinition } from './types.js';

/**
 * Pick the effective {@link ActorResolver} for a turn: an agent's own `actorResolver` (from its
 * {@link AgentDefinition}) wins over the module-global resolver, letting different agents read the
 * caller from different places (e.g. one that reads the actor from the HTTP body). Falls back to
 * `globalResolver` when the agent is unknown (`undefined` definition) or declares none — identical to
 * the single-resolver behavior before per-agent overrides existed.
 */
export function resolveActorResolver(
  globalResolver: ActorResolver,
  definition: Pick<AgentDefinition, 'actorResolver'> | undefined,
): ActorResolver {
  return definition?.actorResolver ?? globalResolver;
}

/**
 * The default {@link ActorResolver} the provider installs when `config/agent.ts` sets no
 * `actorResolver`. It throws on every request rather than inventing an identity — security by
 * default. Wire a real resolver (e.g. {@link AuthActorResolver}) or the opt-in
 * {@link HeaderActorResolver} via `defineConfig({ actorResolver })`.
 */
export class UnconfiguredActorResolver implements ActorResolver {
  resolve(): Actor {
    throw new Error(
      'No actorResolver configured. @adonis-agora/agent refuses to fabricate a caller identity. ' +
        'Set defineConfig({ actorResolver }) in config/agent.ts with a resolver that reads your ' +
        'authenticated principal (e.g. AuthActorResolver over ctx.auth.user), or the built-in ' +
        'HeaderActorResolver behind a trusted gateway.',
    );
  }
}

/** Read a string header off an Adonis-ish `HttpContext` without trusting its concrete shape. */
function readHeader(ctx: unknown, name: string): string | undefined {
  const request = (ctx as { request?: { header?: (n: string) => unknown } }).request;
  const value = request?.header?.(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A development / gateway {@link ActorResolver} that trusts request headers:
 * `x-actor-id` (required), `x-actor-role` (comma-separated → `roles`), `x-tenant-ref`.
 *
 * **Security:** it throws when `x-actor-id` is absent — it never fabricates an identity and never
 * grants a default role (an actor with no `x-actor-role` gets `roles: []`, i.e. no tools). Trusting
 * client headers is only safe behind a gateway that strips and re-sets them from an authenticated
 * principal. Real deployments should provide their own resolver (or {@link AuthActorResolver}) that
 * reads a verified session/JWT instead.
 */
export class HeaderActorResolver implements ActorResolver {
  resolve(ctx: unknown): Actor {
    const id = readHeader(ctx, 'x-actor-id');
    if (id === undefined || id.length === 0) {
      throw new Error(
        'HeaderActorResolver: missing x-actor-id header. No default actor is fabricated. ' +
          'Send x-actor-id from a trusted gateway, or configure defineConfig({ actorResolver }) ' +
          'with a resolver that reads your authenticated principal.',
      );
    }
    const roles = (readHeader(ctx, 'x-actor-role') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    const tenantRef = readHeader(ctx, 'x-tenant-ref');
    return {
      id,
      roles,
      ...(tenantRef !== undefined ? { tenantRef } : {}),
    };
  }
}

/** The authenticated-principal shape {@link AuthActorResolver} reads off `ctx.auth.user`. */
interface AuthUserLike {
  id?: unknown;
  roles?: unknown;
  tenantRef?: unknown;
}

/** What {@link AuthActorResolver} reads of `ctx.auth` — `@adonisjs/auth`'s authenticator, structurally. */
interface AuthenticatorLike {
  user?: unknown;
  /** Set once a guard tried this request (an auth middleware, or a check). */
  authenticationAttempted?: boolean;
  /** Silently try the default guard: `false` for an anonymous request, never a throw. */
  check?(): Promise<boolean>;
  /** Silently try these guards in order. */
  checkUsing?(guards: string[]): Promise<boolean>;
}

/** Options for {@link AuthActorResolver}. */
export interface AuthActorResolverOptions {
  /** Map the authenticated user to an {@link Actor}. Defaults to reading `id`/`roles`/`tenantRef`. */
  toActor?: (user: unknown) => Actor;
  /**
   * The `@adonisjs/auth` guards to check the request with, in order (`['web', 'api']`). Default:
   * the default guard.
   */
  guards?: string[];
}

/**
 * Reads Adonis's authenticated principal (`ctx.auth.user`, from `@adonisjs/auth`) into an
 * {@link Actor}. The agent routes run no auth middleware, so when no guard has tried the request
 * yet the resolver checks it itself — `ctx.auth.check()` (or `checkUsing(guards)`), which reads a
 * session cookie or a bearer token and never throws for an anonymous request. Fail-closed: throws
 * (the routes answer `401`) when no user is authenticated rather than fabricating one. Pass a
 * `toActor` mapper when your user model doesn't expose `id`/`roles`/`tenantRef` directly (e.g. to
 * pull roles from a relation). This is the resolver most apps wire in `config/agent.ts`.
 */
export class AuthActorResolver implements ActorResolver {
  constructor(private readonly options: AuthActorResolverOptions = {}) {}

  async resolve(ctx: unknown): Promise<Actor> {
    const auth = (ctx as { auth?: AuthenticatorLike } | null | undefined)?.auth;
    let user = auth?.user;
    if (
      (user === undefined || user === null) &&
      auth !== undefined &&
      !auth.authenticationAttempted
    ) {
      const guards = this.options.guards;
      if (guards !== undefined && guards.length > 0 && typeof auth.checkUsing === 'function') {
        await auth.checkUsing(guards);
      } else if (typeof auth.check === 'function') {
        await auth.check();
      }
      user = auth.user;
    }
    if (user === undefined || user === null) {
      throw new Error(
        'AuthActorResolver: no authenticated user on ctx.auth.user. Install @adonisjs/auth (its ' +
          'guard is checked on each request), or authenticate the request in a middleware before ' +
          'it reaches the agent routes; no identity is fabricated.',
      );
    }
    if (this.options.toActor !== undefined) {
      return this.options.toActor(user);
    }
    const record = user as AuthUserLike;
    if (record.id === undefined || record.id === null) {
      throw new Error('AuthActorResolver: ctx.auth.user has no id; pass a toActor mapper.');
    }
    const roles = Array.isArray(record.roles)
      ? record.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const tenantRef = typeof record.tenantRef === 'string' ? record.tenantRef : undefined;
    return {
      id: String(record.id),
      roles,
      ...(tenantRef !== undefined ? { tenantRef } : {}),
    };
  }
}
