import { useEffect, useState, useSyncExternalStore } from 'react';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { type ConsoleTenantsView, pageTenant } from '../client/agent-client.js';
import { useAgentClient } from './use-governance.js';

const TEXT = {
  noun: 'Organization',
  all: 'All organizations',
  some: 'Every organization you can see',
  search: 'Search organizations',
  empty: 'No organizations.',
};

/** Put `tenant` in the page URL (`?tenant=`), keeping the hash. `null` removes it. */
export function setPageTenant(tenant: string | null): void {
  const url = new URL(window.location.href);
  if (tenant === null) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * `?tenant=` as the page URL has it now, following the picker and back/forward (`popstate`). The
 * console reads every page again when it moves, so the picker and the data never disagree.
 */
export function usePageTenant(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    pageTenant,
    () => null,
  );
}

/**
 * The "Organization" header control, shown only with tenancy on: a fixed chip when the viewer sees
 * one organization (or none), a searchable picker (label or id) when they may see several (or all,
 * "All organizations" first). The
 * choice lives in the URL (`?tenant=`) and every governance read sends it; the server only ever
 * narrows to what the viewer was granted.
 */
export function OrgPicker({ onChange }: { onChange: (tenant: string | null) => void }) {
  const client = useAgentClient();
  const [view, setView] = useState<ConsoleTenantsView | null>(null);

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

  if (!view.all && view.tenants.length <= 1) {
    const only = view.tenants[0];
    return <ScopeChip noun={TEXT.noun} label={only ? only.label : 'none'} kind="tenant" />;
  }

  const selected = view.selected ?? pageTenant() ?? undefined;
  return (
    <ScopeMenu
      items={view.tenants}
      all={view.all}
      current={selected}
      text={TEXT}
      labelOf={(id) => view.tenants.find((tenant) => tenant.id === id)?.label ?? id}
      onChoose={(picked) => {
        const next = picked ?? null;
        setPageTenant(next);
        // A replaceState fires nothing: say the URL moved (usePageTenant follows it).
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        onChange(next);
      }}
    />
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
