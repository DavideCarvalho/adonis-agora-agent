import { useEffect, useId, useState } from 'react';
import { UsersIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import { type ConsoleTenantsView, pageTenant } from '../client/agent-client.js';
import { fieldClass } from './ui.js';
import { useAgentClient } from './use-governance.js';

/** Put `tenant` in the page URL (`?tenant=`), keeping the hash. `null` removes it. */
export function setPageTenant(tenant: string | null): void {
  const url = new URL(window.location.href);
  if (tenant === null) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * The "Organization" header control, shown only with tenancy on: a fixed chip when the viewer sees
 * one organization, a picker when they may see several (or all, "All organizations" first). The
 * choice lives in the URL (`?tenant=`) and every governance read sends it; the server only ever
 * narrows to what the viewer was granted.
 */
export function OrgPicker({ onChange }: { onChange: (tenant: string | null) => void }) {
  const client = useAgentClient();
  const [view, setView] = useState<ConsoleTenantsView | null>(null);
  const [query, setQuery] = useState('');
  const id = useId();

  useEffect(() => {
    let live = true;
    client
      .tenants()
      .then((result) => {
        if (live) setView(result);
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (view === null || !view.enabled) return null;

  if (!view.all && view.tenants.length === 0) {
    return (
      <Badge variant="warn" role="status">
        No organization
      </Badge>
    );
  }

  if (!view.all && view.tenants.length === 1) {
    const only = view.tenants[0] as { id: string; label: string };
    return (
      <span
        className="inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 text-xs text-fg"
        title={only.id}
      >
        <UsersIcon className="shrink-0 text-faint" />
        <span className="sr-only">Organization</span>
        <span className="truncate">{only.label}</span>
      </span>
    );
  }

  const selected = view.selected ?? pageTenant() ?? '';
  const needle = query.trim().toLowerCase();
  const options = view.tenants.filter(
    (tenant) =>
      needle === '' ||
      tenant.id === selected ||
      tenant.label.toLowerCase().includes(needle) ||
      tenant.id.toLowerCase().includes(needle),
  );

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <label className="flex items-center text-faint" htmlFor={id}>
        <UsersIcon />
        <span className="sr-only">Organization</span>
      </label>
      {view.tenants.length > 8 && (
        <input
          className={`${fieldClass} hidden w-24 md:block`}
          type="search"
          aria-label="Filter organizations"
          placeholder="Filter…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <select
        id={id}
        className={`${fieldClass} min-w-0 flex-1 md:max-w-[14rem] md:flex-none`}
        value={selected}
        onChange={(event) => {
          const next = event.target.value === '' ? null : event.target.value;
          setPageTenant(next);
          onChange(next);
        }}
      >
        <option value="">All organizations</option>
        {options.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * The "choose an organization" notice, when tenancy is on and the viewer has none to see. Renders
 * nothing otherwise.
 */
export function OrgNotice() {
  const client = useAgentClient();
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let live = true;
    client
      .tenants()
      .then((view) => {
        if (live) setEmpty(view.enabled && !view.all && view.tenants.length === 0);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);
  if (!empty) return null;
  return (
    <div className="px-4 pt-5 md:px-6">
      <div
        className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-3 text-xs text-warn"
        role="status"
      >
        Choose an organization to see its data.
      </div>
    </div>
  );
}
