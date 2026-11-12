/**
 * Structural reader for the tenancy contract `@adonis-agora/context` publishes on its global slots.
 * Never imports that package: with the slot missing, too old, or throwing, tenancy reads as OFF, so
 * the agent behaves exactly as it does without tenancy.
 *
 * The tenant here is the customer a piece of data belongs to (an organization, a clinic…), not a
 * process topology.
 */

import type { ActorResolver } from '../spi/actor-resolver.js';
import type { Actor } from '../types.js';

const ACCESSOR = Symbol.for('@agora/context:accessor');
const TENANCY = Symbol.for('@agora/context:tenancy');

/** One level of a tenant chain. */
export interface TenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** The active tenant, as context publishes it. */
export interface TenantRef extends TenantLevel {
  source: string;
  parents?: TenantLevel[];
  family?: string;
}

/** How a read or write must be scoped right now. */
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef; chain?: TenantLevel[] };

/** The agent's `tenancy` option (`config/agent.ts`). */
export type AgentTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `tenancy.enabled` in `config/context.ts`. */
      enabled?: 'inherit' | boolean;
      /** Tenant kinds the agent honours; another kind reads as no tenant. Default: context's. */
      kinds?: string[];
      /**
       * Rows with no tenant: `'tenantless'` (default) shows them only to requests without a tenant;
       * `'shared'` also shows them inside every tenant.
       */
      nullRows?: 'tenantless' | 'shared';
    };

/** {@link AgentTenancyOption} resolved against context. */
export interface ResolvedAgentTenancy {
  enabled: boolean;
  kinds?: string[];
  nullRows: 'tenantless' | 'shared';
}

interface AccessorSlot {
  tenancy?: () => { enabled?: boolean; kinds?: string[] } | undefined;
  tenantFilter?: (options?: { kinds?: string[] }) => TenantFilter;
  tenant?: () => TenantRef | undefined;
}

interface TenancySlot {
  version?: number;
  tenancy?: AccessorSlot['tenancy'];
  tenantFilter?: AccessorSlot['tenantFilter'];
  tenantLabels?: (ids: string[], kind?: string) => Promise<Record<string, string>>;
}

/**
 * The tenancy reader: context's versioned `:tenancy` slot (v1) when present, else the `:accessor`
 * slot's tenancy members (an earlier context), else nothing.
 */
function reader(): AccessorSlot | undefined {
  const tenancy = slot<TenancySlot>(TENANCY);
  if (tenancy?.version === 1 && typeof tenancy.tenantFilter === 'function') {
    return tenancy as AccessorSlot;
  }
  const accessor = slot<AccessorSlot>(ACCESSOR);
  return typeof accessor?.tenantFilter === 'function' ? accessor : undefined;
}

function slot<T>(key: symbol): T | undefined {
  const value = (globalThis as Record<symbol, unknown>)[key];
  return value !== null && typeof value === 'object' ? (value as T) : undefined;
}

/** Resolve the agent's `tenancy` option. With no (or an old) context, tenancy is off. */
export function resolveAgentTenancy(option: AgentTenancyOption | undefined): ResolvedAgentTenancy {
  const accessor = reader();
  const off: ResolvedAgentTenancy = { enabled: false, nullRows: 'tenantless' };
  if (option === false) return off;
  if (accessor === undefined) return off;
  const own = typeof option === 'object' ? option : {};
  let context: { enabled?: boolean; kinds?: string[] } | undefined;
  try {
    context = accessor.tenancy?.();
  } catch {
    context = undefined;
  }
  const enabled =
    own.enabled === undefined || own.enabled === 'inherit'
      ? context?.enabled === true
      : own.enabled;
  const kinds = own.kinds ?? context?.kinds;
  return {
    enabled,
    ...(kinds !== undefined ? { kinds: [...kinds] } : {}),
    nullRows: own.nullRows ?? 'tenantless',
  };
}

/**
 * How the current request (or job) must be scoped. Tenancy off → `system` (nothing filtered). A
 * tenant of a kind the agent does not honour reads as `tenantless`.
 */
export function currentTenantFilter(tenancy: ResolvedAgentTenancy): TenantFilter {
  if (!tenancy.enabled) return { mode: 'system' };
  const accessor = reader();
  // A `required: true` context throws here when there is no tenant: the caller refuses.
  {
    const filter = accessor?.tenantFilter?.(
      tenancy.kinds !== undefined ? { kinds: tenancy.kinds } : undefined,
    );
    if (filter === undefined || filter === null || typeof filter !== 'object') {
      return { mode: 'system' };
    }
    if (filter.mode === 'tenant') {
      const kind = filter.tenant?.kind;
      if (tenancy.kinds !== undefined && !tenancy.kinds.includes(kind)) {
        return { mode: 'tenantless' };
      }
    }
    return filter;
  }
}

/** The tenant id to stamp on a write right now: the tenant's id in `tenant` mode, else `null`. */
export function currentTenantRef(tenancy: ResolvedAgentTenancy): string | null {
  const filter = currentTenantFilter(tenancy);
  return filter.mode === 'tenant' ? filter.tenant.id : null;
}

/**
 * Whether a row stamped `rowTenant` is visible under `filter` (the matching rule every Agora lib
 * applies). Invisible rows are answered as not found.
 */
export function tenantVisible(
  filter: TenantFilter,
  rowTenant: string | null | undefined,
  nullRows: 'tenantless' | 'shared' = 'tenantless',
): boolean {
  const row = rowTenant ?? null;
  switch (filter.mode) {
    case 'system':
    case 'all':
      return true;
    case 'tenantless':
      return row === null;
    case 'tenant':
      return row === filter.tenant.id || (row === null && nullRows === 'shared');
  }
}

/** A tenant set to scope reads by: these ids, plus rows with no tenant when `includeNull`. */
export interface TenantScope {
  tenants: readonly string[];
  includeNull: boolean;
}

/** The {@link TenantScope} of a filter, or `undefined` for "no filtering" (`system` / `all`). */
export function scopeOfFilter(
  filter: TenantFilter,
  nullRows: 'tenantless' | 'shared' = 'tenantless',
): TenantScope | undefined {
  switch (filter.mode) {
    case 'system':
    case 'all':
      return undefined;
    case 'tenantless':
      return { tenants: [], includeNull: true };
    case 'tenant':
      return { tenants: [filter.tenant.id], includeNull: nullRows === 'shared' };
  }
}

/** Whether `tenantRef` is inside `scope` (`undefined` scope = everything). */
export function inScope(
  scope: TenantScope | undefined,
  tenantRef: string | null | undefined,
): boolean {
  if (scope === undefined) return true;
  const ref = tenantRef ?? null;
  return ref === null ? scope.includeNull : scope.tenants.includes(ref);
}

/** Display labels for tenant ids, from context's label resolver; ids map to themselves otherwise. */
export async function tenantLabels(ids: string[], kind?: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = Object.fromEntries(ids.map((id) => [id, id]));
  const tenancy = slot<TenancySlot>(TENANCY);
  if (tenancy?.version !== 1 || typeof tenancy.tenantLabels !== 'function') return labels;
  try {
    const resolved = await tenancy.tenantLabels(ids, kind);
    for (const id of ids) {
      const label = resolved?.[id];
      if (typeof label === 'string' && label !== '') labels[id] = label;
    }
  } catch {
    // labels are display only
  }
  return labels;
}

/**
 * `actor` with `tenantRef` filled from the active tenant when tenancy is on and the actor has none.
 * A resolver that set `tenantRef` wins.
 */
export function withTenantRef(actor: Actor, tenancy: ResolvedAgentTenancy | undefined): Actor {
  if (tenancy === undefined || !tenancy.enabled || actor.tenantRef !== undefined) return actor;
  const tenantRef = currentTenantRef(tenancy);
  return tenantRef === null ? actor : { ...actor, tenantRef };
}

/** An actor resolver whose actors carry the active tenant (see {@link withTenantRef}). */
export function tenantFillingResolver(
  resolver: ActorResolver,
  tenancy: ResolvedAgentTenancy,
): ActorResolver {
  if (!tenancy.enabled) return resolver;
  const wrapped = Object.create(resolver) as ActorResolver;
  wrapped.resolve = async (req: unknown) => {
    const actor = await resolver.resolve(req);
    return actor !== null && typeof actor === 'object' ? withTenantRef(actor, tenancy) : actor;
  };
  return wrapped;
}
