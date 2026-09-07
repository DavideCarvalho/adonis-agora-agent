import type { ActorResolver } from '../spi/actor-resolver.js';
import type { Actor } from '../types.js';
import { readContextAccessor, tenantIdFromContext, userRefFromContext } from './agora-context.js';
import type { AuthzTenantScope } from './authz-tool-authorizer.js';

/**
 * The structural slice of `@adonis-agora/authz`'s `AuthzService` this resolver needs: the user's
 * effective roles (authz's union of global (context) ∪ app (`resolveRoles`) ∪ store (DB)). Typed
 * structurally so `@adonis-agora/authz` stays an OPTIONAL lazy peer — zero import of the package.
 */
export interface AuthzRolesSourceLike {
  effectiveRoles(user: unknown, scope?: AuthzTenantScope): Promise<string[]>;
}

/** Options for {@link AuthzActorResolver} / {@link authzActorResolver}. */
export interface AuthzActorResolverConfig {
  /** The `@adonis-agora/authz` `AuthzService` (or any structural match) the resolver reads roles from. */
  authz: AuthzRolesSourceLike;
}

/**
 * An {@link ActorResolver} that reads the caller from the Agora context authkit populates
 * (`userRef`, `tenantId`) and takes the caller's roles from authz (`effectiveRoles`). It ignores
 * the transport `req` and reads the active Agora context store, so it needs no `ctx.auth` and is
 * framework-agnostic.
 *
 * Security posture — FAIL-CLOSED: no `userRef.id` in context → throws (the provider replies 401).
 * An identity is never fabricated. The context `userRef` is passed straight to `effectiveRoles`;
 * authz reads its `.id`/`.type` and re-reads `globalRoles` from the same context, so global roles
 * (e.g. `ADMIN`) land in the result with no extra wiring.
 */
export class AuthzActorResolver implements ActorResolver {
  readonly #authz: AuthzRolesSourceLike;

  constructor(config: AuthzActorResolverConfig) {
    this.#authz = config.authz;
  }

  async resolve(_req: unknown): Promise<Actor> {
    const accessor = readContextAccessor();
    const ref = userRefFromContext(accessor);
    if (ref?.id === undefined || ref.id === null || String(ref.id).length === 0) {
      throw new Error(
        'authzActorResolver: no authenticated identity in @agora/context. The agent route must ' +
          'sit behind authkit auth middleware (which populates the context), with the ' +
          '@adonis-agora/context provider registered.',
      );
    }

    const tenantId = tenantIdFromContext(accessor);
    const scope: AuthzTenantScope | undefined = tenantId ? { tenantId } : undefined;
    const roles = await this.#authz.effectiveRoles(ref, scope);

    return {
      id: String(ref.id),
      roles,
      ...(tenantId ? { tenantRef: tenantId } : {}),
    };
  }
}

/** Factory for {@link AuthzActorResolver}. */
export function authzActorResolver(config: AuthzActorResolverConfig): ActorResolver {
  return new AuthzActorResolver(config);
}
