import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type ConsoleTenantsView } from '../client/agent-client.js';
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
    expect(screen.queryByRole('combobox')).toBeNull();
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
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      'All organizations',
      'Acme',
      'Beta',
    ]);
    fireEvent.change(select, { target: { value: 'b' } });
    expect(window.location.search).toBe('?tenant=b');
    expect(onChange).toHaveBeenCalledWith('b');
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
