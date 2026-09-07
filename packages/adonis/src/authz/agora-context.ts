/**
 * Structural, dependency-free reader for the Agora runtime context — mirrors
 * `@adonis-agora/authz`'s `agora/context.ts`. The Agora context library publishes a READ accessor
 * on the well-known symbol slot. We never import that package; when the slot is absent (context not
 * installed) the reader degrades to `undefined` and the caller fails closed.
 */

/** The symbol slot the Agora context library writes its read accessor into. */
export const AGORA_CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/**
 * The slice of the context accessor this package reads. `@adonis-agora/context`'s real accessor
 * (`packages/core/src/accessor.ts`) publishes `tenantId` and `userRef` as METHODS — calling them
 * returns the active value, or `undefined` outside a request/job. They are NOT plain properties;
 * treating them as values (the mistake this file used to make) makes every field a truthy function
 * reference instead of the data it holds. We never read `globalRoles` here — authz's
 * `effectiveRoles` does that internally.
 */
export interface AgoraContextAccessor {
  tenantId?: () => string | undefined;
  userRef?: () => { type?: string; id?: string | number } | undefined;
  get?: () => unknown;
}

/** Read the active Agora context accessor from the global slot, if present. */
export function readContextAccessor(): AgoraContextAccessor | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR];
  if (slot == null || typeof slot !== 'object') return undefined;
  return slot as AgoraContextAccessor;
}

/**
 * Call an accessor method safely: tolerates the method being absent (a partial/mocked accessor,
 * or a slot that isn't the real `@adonis-agora/context` implementation) and tolerates it throwing.
 * Degrades to `undefined` either way — this package never fabricates identity from a broken
 * context, it just leaves the field empty and lets the caller fail closed.
 */
function readMethod<T>(fn: unknown): T | undefined {
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => T | undefined)();
  } catch {
    return undefined;
  }
}

/**
 * The active caller's `userRef` from the Agora context, or `undefined` outside a context / when
 * the accessor slot is absent.
 */
export function userRefFromContext(
  accessor: AgoraContextAccessor | undefined = readContextAccessor(),
): { type?: string; id?: string | number } | undefined {
  return readMethod(accessor?.userRef);
}

/**
 * The active tenant id from the Agora context, or `undefined` outside a context / when unset /
 * when the accessor slot is absent.
 */
export function tenantIdFromContext(
  accessor: AgoraContextAccessor | undefined = readContextAccessor(),
): string | undefined {
  return readMethod(accessor?.tenantId);
}
