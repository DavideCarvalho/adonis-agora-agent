import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type ConsoleAppsView } from '../client/agent-client.js';
import { AppPicker, PickedAppNotice } from './AppPicker.js';
import { pickScopeOption, scopeButton, scopeOptionNames } from './combo-test-utils.js';
import { AgentClientContext } from './use-governance.js';

/** A server answering `view`, with `selected` from the URL's `?app=` when it lists that app. */
function withApps(view: ConsoleAppsView, onChange = vi.fn()) {
  const fetchFn = vi.fn(async (_url: string) => {
    const app = new URLSearchParams(window.location.search).get('app');
    const listed = view.apps.some((entry) => entry.id === app);
    const selected = view.selected ?? (listed ? app : null);
    return new Response(JSON.stringify({ ...view, selected }), { status: 200 });
  });
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
    expect(screen.queryByRole('button', { name: /^App/ })).toBeNull();
  });

  it('puts the picked app in ?app=, drops ?tenant=, and every governance call and decision carries it', async () => {
    window.history.replaceState(null, '', '/agent/dashboard?tenant=org-1#runs');
    const { fetchFn, client, onChange } = withApps({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: null,
    });
    const select = await scopeButton('App');
    expect(select.getAttribute('aria-haspopup')).toBe('listbox');
    expect(select.textContent).toBe('AppHub');
    await pickScopeOption(select, /Entre Textos/, 'entre');
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

    await waitFor(() => expect(select.textContent).toBe('AppEntre Textos'));
    await pickScopeOption(select, 'Hub');
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
    const select = await scopeButton('App');
    await waitFor(() => expect(select.textContent).toBe('AppHub'));
  });

  it('follows back/forward, and tells the console the app moved', async () => {
    window.history.replaceState(null, '', '/agent/dashboard#runs');
    const { onChange } = server();
    const select = await scopeButton('App');
    await pickScopeOption(select, /Entre Textos/);
    await waitFor(() => expect(select.textContent).toBe('AppEntre Textos'));

    // "Back": the URL is this app's again, and the browser says so with a popstate.
    act(() => {
      window.history.replaceState(null, '', '/agent/dashboard#runs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(select.textContent).toBe('AppHub'));
    expect(onChange).toHaveBeenLastCalledWith(null, { picked: false });
    // "Forward".
    act(() => {
      window.history.replaceState(null, '', '/agent/dashboard?app=entre-textos#runs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(select.textContent).toBe('AppEntre Textos'));
    expect(onChange).toHaveBeenLastCalledWith('entre-textos', { picked: false });
  });

  it('tags federated apps in the options and on the trigger', async () => {
    window.history.replaceState(null, '', '/agent/dashboard?app=entre-textos#runs');
    withApps({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
      selected: 'entre-textos',
    });
    const select = await scopeButton('App');
    const badge = await waitFor(() => {
      const found = document.querySelector('[data-app-mode="federated"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(badge.textContent).toBe('federated');
    expect(badge.getAttribute('title')).toContain('Actions are sent to Entre Textos');
    expect(await scopeOptionNames(select)).toEqual(['Hub', 'Entre Textosfederated']);
  });

  it('shows no tag for this app, nor for an older server that does not say', async () => {
    withApps({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: null,
    });
    await scopeButton('App');
    expect(document.querySelector('[data-app-mode]')).toBeNull();
  });
});

describe('<PickedAppNotice>', () => {
  function notice(view: ConsoleAppsView) {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }));
    const client = new AgentClient({ baseUrl: '/agent', fetch: fetchFn as never });
    render(
      <AgentClientContext.Provider value={client}>
        <PickedAppNotice />
      </AgentClientContext.Provider>,
    );
  }

  it("says where a federated app's data comes from and who runs its actions", async () => {
    window.history.replaceState(null, '', '/agent/dashboard?app=entre-textos');
    notice({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'none' }],
      selected: 'entre-textos',
    });
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe(
      "Federated: this console reads Entre Textos's data from Entre Textos's own store. Read-only here: change it in Entre Textos itself.",
    );
  });

  it('renders nothing for this app', async () => {
    notice({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
      selected: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
