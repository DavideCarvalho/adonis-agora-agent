import type { RolesPolicy } from '../spi/roles-policy.js';
import type { Actor, ToolSpec } from '../types.js';

/**
 * Tenant scope shape — a structural mirror of `@adonis-agora/authz`'s `TenantScope`
 * (`{ tenantId?: string }`). Kept local so the adapter references the authz package
 * only by structure, never by import (see {@link AuthzServiceLike}).
 */
export interface AuthzTenantScope {
  tenantId?: string;
}

/**
 * The structural slice of `@adonis-agora/authz`'s `AuthzService` this adapter needs: a
 * tenant-scoped, wildcard permission check.
 *
 * Typing it structurally (rather than `import type { AuthzService } from '@adonis-agora/authz'`)
 * is what keeps `@adonis-agora/authz` an OPTIONAL lazy peer — the adapter carries zero import of
 * the package, so it is pulled in only by an app that has already wired authz and hands its
 * `AuthzService` to the factory. The `./authz` subpath is the load boundary: the main entry never
 * references this file, so apps that don't use authz never load it.
 */
export interface AuthzServiceLike {
  /**
   * Does `user` hold `permission` (with wildcard matching, e.g. `posts.*` ⊇ `posts.edit`),
   * scoped to `options.scope`? Mirrors `AuthzService.can`.
   */
  can(user: unknown, permission: string, options?: { scope?: AuthzTenantScope }): Promise<boolean>;
}

/** Options for {@link AuthzToolAuthorizer} / {@link authzToolAuthorizer}. */
export interface AuthzToolAuthorizerConfig {
  /**
   * The `@adonis-agora/authz` `AuthzService` (or any structural match) the adapter consults for
   * each tool's declared `ability`. The app builds it from its own `config/authz.ts` and passes
   * the instance here — no host user entity is required.
   */
  authz: AuthzServiceLike;
  /**
   * Maps an {@link Actor} onto the user object authz resolves a `SubjectRef` from. Defaults to
   * `{ id: actor.id }` — enough for authz's `defaultResolveSubjectRef` (which reads `.id`, defaulting
   * the type to `user`). Override to attach a polymorphic `type` or a host user entity.
   */
  userFromActor?: (actor: Actor) => unknown;
}

/** Default {@link Actor} → authz subject mapping: the minimal `{ id }` authz needs to resolve a `SubjectRef`. */
export function defaultUserFromActor(actor: Actor): unknown {
  return { id: actor.id };
}

/**
 * A {@link RolesPolicy} (the agent's `ToolAuthorizer` seam) backed by `@adonis-agora/authz`
 * (AdonisJS Bouncer). For each tool it checks the actor against the tool's declared `ability`
 * via {@link AuthzServiceLike.can}, scoped to the actor's tenant.
 *
 * Security posture — FAIL-CLOSED:
 * - A tool that declares no `ability` is NEVER authorized (deny). Unlike the role-based default,
 *   there is no ADMIN fallback: with authz selected, an un-annotated tool is simply not reachable.
 * - Any error thrown while resolving the decision denies.
 *
 * Tenant isolation: `actor.tenantRef` is passed as the authz **scope** (`{ tenantId }`), so a
 * permission granted in one tenant never authorizes a tool call made in another. When the actor has
 * no `tenantRef`, the check runs against the global scope (authz's default).
 *
 * The agent's double check — the offered-tools filter AND the invoke-time re-check inside
 * `ToolRegistry` — both run through this same `can(actor, tool)`, so offer and invoke stay
 * consistent.
 */
export class AuthzToolAuthorizer implements RolesPolicy {
  readonly #authz: AuthzServiceLike;
  readonly #userFromActor: (actor: Actor) => unknown;

  constructor(config: AuthzToolAuthorizerConfig) {
    this.#authz = config.authz;
    this.#userFromActor = config.userFromActor ?? defaultUserFromActor;
  }

  async can(actor: Actor, tool: ToolSpec): Promise<boolean> {
    // Fail-closed: no declared ability → deny. There is no role fallback under authz.
    if (tool.ability === undefined) return false;
    try {
      // Pass the actor's tenant as the authz scope so the grant is tenant-isolated. Omit the option
      // entirely when there is no tenantRef (global scope) — honors `exactOptionalPropertyTypes`.
      const options = actor.tenantRef !== undefined ? { scope: { tenantId: actor.tenantRef } } : {};
      return await this.#authz.can(this.#userFromActor(actor), tool.ability, options);
    } catch {
      // Fail-closed: any failure resolving the decision denies.
      return false;
    }
  }
}

/**
 * Factory for an {@link AuthzToolAuthorizer}. Wire it in `config/agent.ts` as the tool authorizer,
 * replacing the ADMIN-only `DefaultToolAuthorizer`:
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/agent'
 * import { authzToolAuthorizer } from '@adonis-agora/agent/authz'
 * import authz from '@adonis-agora/authz/services/main'
 *
 * export default defineConfig({
 *   model: () => aiSdkModel({ model: '...' }),
 *   authorizer: authzToolAuthorizer({ authz }),
 * })
 * ```
 */
export function authzToolAuthorizer(config: AuthzToolAuthorizerConfig): AuthzToolAuthorizer {
  return new AuthzToolAuthorizer(config);
}
