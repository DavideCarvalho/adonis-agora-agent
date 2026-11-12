import type { TenantFilter, TenantScope } from '../agora/tenancy.js';
import type { ConsoleTenants } from '../console-authorize.js';

/** What the console may show a viewer, with tenancy on. */
export interface ConsoleTenantScope {
  /** The tenants the viewer may pick from: every one (`'*'`) or these ids (empty = none). */
  allowed: ConsoleTenants;
  /** What the reads are scoped to right now; `undefined` = every tenant, rows with none included. */
  scope: TenantScope | undefined;
  /** The organization the viewer picked (`?tenant=`), when it is one they may see. */
  selected: string | null;
  /** `?tenant=` named a tenant outside `allowed`: the reads are empty, and the attempt is logged. */
  forged: boolean;
}

/**
 * Resolve what a console viewer sees under tenancy:
 *
 * 1. `authorize` granted no `tenants` → the viewer's own active tenant (none → nothing, and the
 *    console asks to choose an organization).
 * 2. `tenants: [...]` → those; `'*'` → every tenant, plus rows with none.
 * 3. `?tenant=<id>` narrows to one of them; an id outside them reads as empty (`forged`).
 */
export function resolveConsoleTenantScope(input: {
  granted: ConsoleTenants | undefined;
  own: TenantFilter;
  selected?: string | undefined;
  nullRows?: 'tenantless' | 'shared';
}): ConsoleTenantScope {
  const nullRows = input.nullRows ?? 'tenantless';
  const allowed: ConsoleTenants =
    input.granted ??
    (input.own.mode === 'tenant'
      ? [input.own.tenant.id]
      : input.own.mode === 'tenantless'
        ? []
        : '*');
  const selected =
    typeof input.selected === 'string' && input.selected !== '' ? input.selected : null;
  if (selected !== null) {
    const ok = allowed === '*' || allowed.includes(selected);
    return ok
      ? {
          allowed,
          scope: { tenants: [selected], includeNull: nullRows === 'shared' },
          selected,
          forged: false,
        }
      : { allowed, scope: { tenants: [], includeNull: false }, selected: null, forged: true };
  }
  if (allowed === '*') return { allowed, scope: undefined, selected: null, forged: false };
  return {
    allowed,
    scope: { tenants: allowed, includeNull: allowed.length > 0 && nullRows === 'shared' },
    selected: null,
    forged: false,
  };
}
