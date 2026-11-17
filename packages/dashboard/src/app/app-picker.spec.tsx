import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type ConsoleAppsView } from '../client/agent-client.js';
import { AppPicker } from './AppPicker.js';
import { AgentClientContext } from './use-governance.js';

function withApps(view: ConsoleAppsView, onChange = vi.fn()) {
  const fetchFn = vi.fn(
    async (_url: string) => new Response(JSON.stringify(view), { status: 200 }),
  );
  const client = new AgentClient({ baseUrl: '/agent', fetch: fetchFn as never });
  render(
    <AgentClientContext.Provider value={client}>
      <AppPicker onChange={onChange} />
    </AgentClientContext.Provider>,
  );
  return { fetchFn, client, onChange };
}

afterEach(() => {
  window.history.replaceState(null, '', '/agent/dashboard');
});

describe('<AppPicker> (federated console)', () => {
  it('renders nothing when the console shows only this app', async () => {
    withApps({ local: { label: 'Hub' }, apps: [], selected: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('puts the picked app in ?app=, drops ?tenant=, and every governance call and decision carries it', async () => {
    window.history.replaceState(null, '', '/agent/dashboard?tenant=org-1#runs');
    const { fetchFn, client, onChange } = withApps({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: null,
    });
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'entre-textos' } });
    expect(window.location.search).toBe('?app=entre-textos');
    expect(window.location.hash).toBe('#runs');
    expect(onChange).toHaveBeenCalledWith('entre-textos', { picked: true });

    fetchFn.mockClear();
    await client.spendByModel({ fromDay: '2026-11-01', toDay: '2026-11-02' }).catch(() => {});
    await client.approveToolCall('run-1', 'call-1').catch(() => {});
    await client.quotaToday?.().catch(() => {});
    const urls = fetchFn.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('/agent/governance/spend/model?');
    expect(urls[0]).toContain('app=entre-textos');
    expect(urls[1]).toBe('/agent/tool-call/approve?app=entre-textos');
    // The viewer's own quota is this app's: no `app=`.
    if (urls[2] !== undefined) expect(urls[2]).not.toContain('app=');

    fireEvent.change(select, { target: { value: '' } });
    expect(window.location.search).toBe('');
  });

  /** A server that answers `selected` from the URL, granting only `entre-textos`. */
  function server(onChange = vi.fn()) {
    const fetchFn = vi.fn(async () => {
      const app = new URLSearchParams(window.location.search).get('app');
      const view: ConsoleAppsView = {
        local: { label: 'Hub' },
        apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
        selected: app === 'entre-textos' ? app : null,
      };
      return new Response(JSON.stringify(view), { status: 200 });
    });
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchFn as never });
    render(
      <AgentClientContext.Provider value={client}>
        <AppPicker onChange={onChange} />
      </AgentClientContext.Provider>,
    );
    return { fetchFn, onChange };
  }

  it("shows the server's app, not a forged ?app= it does not serve", async () => {
    window.history.replaceState(null, '', '/agent/dashboard?app=forged#runs');
    server();
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(''));
  });

  it('follows back/forward, and tells the console the app moved', async () => {
    window.history.replaceState(null, '', '/agent/dashboard#runs');
    const { onChange } = server();
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'entre-textos' } });
    await waitFor(() => expect(select.value).toBe('entre-textos'));

    // "Back": the URL is this app's again, and the browser says so with a popstate.
    act(() => {
      window.history.replaceState(null, '', '/agent/dashboard#runs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(select.value).toBe(''));
    expect(onChange).toHaveBeenLastCalledWith(null, { picked: false });
    // "Forward".
    act(() => {
      window.history.replaceState(null, '', '/agent/dashboard?app=entre-textos#runs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(select.value).toBe('entre-textos'));
    expect(onChange).toHaveBeenLastCalledWith('entre-textos', { picked: false });
  });
});
