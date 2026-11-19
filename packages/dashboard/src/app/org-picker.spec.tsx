import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type ConsoleTenantsView } from '../client/agent-client.js';
import { pickScopeOption, scopeButton, scopeOptionNames } from './combo-test-utils.js';
import { OrgNotice, OrgPicker } from './OrgPicker.js';
import { AgentClientContext } from './use-governance.js';

function withTenants(view: ConsoleTenantsView, ui: ReactNode) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }));
  const client = new AgentClient({ baseUrl: '/agent', fetch: fetchFn as never });
  render(<AgentClientContext.Provider value={client}>{ui}</AgentClientContext.Provider>);
  return fetchFn;
}

afterEach(() => {
  window.history.replaceState(null, '', '/agent/dashboard');
});

describe('<OrgPicker>', () => {
  it('renders nothing with tenancy off', async () => {
    const { container } = render(<div />);
    withTenants(
      { enabled: false, all: false, tenants: [], selected: null },
      <OrgPicker onChange={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Organization')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('a fixed chip for one organization', async () => {
    withTenants(
      { enabled: true, all: false, tenants: [{ id: 'a', label: 'Acme' }], selected: null },
      <OrgPicker onChange={() => {}} />,
    );
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(document.querySelector('[data-tenant-chip]')?.textContent).toBe('OrganizationAcme');
    expect(screen.queryByRole('button', { name: /^Organization/ })).toBeNull();
  });

  it('a "none" chip when the viewer has no organization', async () => {
    withTenants(
      { enabled: true, all: false, tenants: [], selected: null },
      <OrgPicker onChange={() => {}} />,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-tenant-chip]')?.textContent).toBe('Organizationnone'),
    );
  });

  it('a picker for several: All organizations first; the choice goes to ?tenant=', async () => {
    const onChange = vi.fn();
    withTenants(
      {
        enabled: true,
        all: true,
        tenants: [
          { id: 'a', label: 'Acme' },
          { id: 'b', label: 'Beta' },
        ],
        selected: null,
      },
      <OrgPicker onChange={onChange} />,
    );
    const select = await scopeButton('Organization');
    expect(select.getAttribute('aria-haspopup')).toBe('listbox');
    expect(select.textContent).toBe('OrganizationAll organizations');
    expect(await scopeOptionNames(select)).toEqual(['All organizations', 'Acmea', 'Betab']);
    // Matches the id too, not just the label.
    await pickScopeOption(select, /Beta/, 'b');
    expect(window.location.search).toBe('?tenant=b');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('autocompletes a long list by label or id; All organizations clears ?tenant=', async () => {
    window.history.replaceState(null, '', '/agent/dashboard?tenant=org-07');
    const onChange = vi.fn();
    const tenants = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { id: `org-${n}`, label: `Tenant ${n}` };
    });
    withTenants(
      { enabled: true, all: true, tenants, selected: 'org-07' },
      <OrgPicker onChange={onChange} />,
    );
    const select = await scopeButton('Organization');
    expect(select.textContent).toBe('OrganizationTenant 07');
    await pickScopeOption(select, /Tenant 11/, 'org-11');
    expect(window.location.search).toBe('?tenant=org-11');
    expect(onChange).toHaveBeenLastCalledWith('org-11');
    await pickScopeOption(select, 'All organizations', 'all');
    expect(window.location.search).toBe('');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('governance reads send ?tenant=; the notice asks to choose one when there is none', async () => {
    window.history.replaceState(null, '', '/agent/dashboard?tenant=b');
    const fetchFn = withTenants(
      { enabled: true, all: false, tenants: [], selected: null },
      <OrgNotice />,
    );
    expect(await screen.findByText('Choose an organization to see its data.')).toBeTruthy();
    expect(String((fetchFn.mock.calls as unknown as unknown[][])[0]?.[0])).toBe(
      '/agent/governance/tenants?tenant=b',
    );
  });
});
