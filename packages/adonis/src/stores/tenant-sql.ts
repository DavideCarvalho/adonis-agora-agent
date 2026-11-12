import type { StoreTenantScope } from '../spi/agent-store.js';

/**
 * The SQL predicate a tenant scope reads as, over `column` (already quoted, e.g. `"tenant_ref"` or
 * `r."tenant_ref"`): `IN (…)`, `OR … IS NULL` when the scope includes rows with no tenant, and a
 * predicate matching nothing when the scope is empty.
 */
export function tenantPredicate(
  scope: StoreTenantScope,
  column = '"tenant_ref"',
): { sql: string; bindings: string[] } {
  const parts: string[] = [];
  if (scope.tenants.length > 0) {
    parts.push(`${column} IN (${scope.tenants.map(() => '?').join(', ')})`);
  }
  if (scope.includeNull) parts.push(`${column} IS NULL`);
  if (parts.length === 0) return { sql: '1 = 0', bindings: [] };
  return { sql: `(${parts.join(' OR ')})`, bindings: [...scope.tenants] };
}
