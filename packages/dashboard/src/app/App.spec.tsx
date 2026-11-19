import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, detailFromHash, sectionFromHash } from './App.js';

function setConfig(config: unknown) {
  document.getElementById('agent-dashboard-config')?.remove();
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'agent-dashboard-config';
  block.textContent = JSON.stringify(config);
  document.head.appendChild(block);
}

/** Every governance read answers an empty collection (`[]`, an empty cursor page, or zeroes). */
function stubApi() {
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/governance/tenants'))
      return json({ enabled: false, all: false, tenants: [], selected: null });
    if (url.includes('/recent') || url.includes('/governance/runs') || url.includes('/pending'))
      return json({
        data: [],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      });
    if (url.includes('/quota')) return json({ windows: [{ period: 'day', usedTokens: 7 }] });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('agent-dashboard-config')?.remove();
  window.history.replaceState(null, '', '/agent/dashboard');
});

describe('routing', () => {
  it('deep links: #runs/<id> and #threads/<id>', () => {
    expect(detailFromHash('#runs/r%2F1')).toBe('r/1');
    expect(detailFromHash('#runs')).toBeNull();
    expect(detailFromHash('#threads/t1')).toBe('t1');
    expect(sectionFromHash('#threads/t1')).toBe('threads');
    expect(sectionFromHash('#nope')).toBe('overview');
    expect(sectionFromHash('#constructor')).toBe('overview');
  });
});

describe('<App> shell', () => {
  it('groups the pages under MONITOR · ACTIVITY · GOVERNANCE · CONFIG and shows the viewer', async () => {
    setConfig({
      apiBase: '/agent',
      viewer: { label: 'Ann Lee', email: 'ann@x.test', role: 'admin' },
      signOut: { action: '/account/logout', csrfToken: 'tok' },
    });
    stubApi();
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Console' });
    for (const label of ['Monitor', 'Activity', 'Governance', 'Config']) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '#overview',
      '#reliability',
      '#runs',
      '#threads',
      '#tools',
      '#genui',
      '#approvals',
      '#quota',
      '#toolstats',
      '#pricing',
    ]);
    expect(screen.getByText('Ann Lee')).toBeTruthy();
    const form = document.querySelector('form[action="/account/logout"]');
    expect(form?.querySelector('input[name="_csrf"]')?.getAttribute('value')).toBe('tok');
    await waitFor(() => expect(screen.getByText('No usage recorded in this range.')).toBeTruthy());
  });

  it('moves the day range into the topbar, only on the ranged pages', async () => {
    setConfig({ apiBase: '/agent' });
    stubApi();
    render(<App />);
    expect(screen.getByLabelText('from day')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole('link', { name: 'Quota' }));
    });
    expect(window.location.hash).toBe('#quota');
    await waitFor(() => expect(screen.getByText('Tokens used today')).toBeTruthy());
    expect(screen.queryByLabelText('from day')).toBeNull();
  });
});

describe('<App> view state in the URL', () => {
  it('reads the section and record past the query', () => {
    expect(sectionFromHash('#runs?status=failed')).toBe('runs');
    expect(detailFromHash('#runs/r1?status=failed')).toBe('r1');
    expect(detailFromHash('#runs?status=failed')).toBeNull();
  });

  it('keeps the day range across pages and drops the old page filters', async () => {
    setConfig({ apiBase: '/agent' });
    const fetchFn = stubApi();
    window.history.replaceState(
      null,
      '',
      '/agent/dashboard#overview?from=2026-01-01&to=2026-01-07',
    );
    render(<App />);
    expect((screen.getByLabelText('from day') as HTMLInputElement).value).toBe('2026-01-01');
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([u]) => String(u).includes('2026-01-01'))).toBe(true),
    );

    fireEvent.change(screen.getByLabelText('to day'), { target: { value: '2026-01-10' } });
    await waitFor(() =>
      expect(window.location.hash).toBe('#overview?from=2026-01-01&to=2026-01-10'),
    );

    fireEvent.click(screen.getByRole('link', { name: 'Runs' }));
    await waitFor(() => expect(window.location.hash).toBe('#runs?from=2026-01-01&to=2026-01-10'));
    fireEvent.change(await screen.findByLabelText('status filter'), {
      target: { value: 'failed' },
    });
    await waitFor(() =>
      expect(window.location.hash).toBe('#runs?from=2026-01-01&to=2026-01-10&status=failed'),
    );

    fireEvent.click(screen.getByRole('link', { name: 'Generative UI' }));
    await waitFor(() => expect(window.location.hash).toBe('#genui?from=2026-01-01&to=2026-01-10'));
    expect((screen.getByLabelText('to day') as HTMLInputElement).value).toBe('2026-01-10');
  });
});

describe('<App> keeps the picked app and organization', () => {
  /** A server with two other apps and two organizations, answering `selected` from the URL. */
  function scopedApi() {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x');
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      const app = url.searchParams.get('app');
      if (url.pathname.endsWith('/governance/apps'))
        return json({
          local: { label: 'hub' },
          apps: [
            { id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'app' },
            { id: 'eduliberta', label: 'EduLiberta' },
          ],
          selected: app === 'entre-textos' || app === 'eduliberta' ? app : null,
        });
      if (url.pathname.endsWith('/governance/tenants'))
        return json({
          enabled: true,
          all: true,
          tenants: [
            { id: 'acme', label: 'Acme' },
            { id: 'globex', label: 'Globex' },
          ],
          selected: url.searchParams.get('tenant'),
        });
      if (url.pathname.includes('/recent') || url.pathname.endsWith('/governance/runs'))
        return json({
          data: [],
          meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
        });
      if (url.pathname.endsWith('/quota')) return json({ windows: [] });
      return json([]);
    });
    vi.stubGlobal('fetch', fetchFn);
    return fetchFn;
  }

  const appButton = () => screen.findByRole('button', { name: /^App/ });
  const orgButton = () => screen.findByRole('button', { name: /^Organization/ });
  async function pick(button: HTMLElement, option: RegExp) {
    act(() => {
      fireEvent.click(button);
    });
    const item = await screen.findByRole('option', { name: option });
    act(() => {
      fireEvent.mouseDown(item);
    });
  }

  it('?app= and the App picker survive the sidebar, the range, ⌘K pages and an organization pick', async () => {
    setConfig({ apiBase: '/agent' });
    const fetchFn = scopedApi();
    window.history.replaceState(null, '', '/agent/dashboard/#overview');
    render(<App />);
    await waitFor(async () => expect((await appButton()).textContent).toBe('Apphub'));

    await pick(await appButton(), /EduLiberta/);
    expect(window.location.search).toBe('?app=eduliberta');
    await waitFor(async () => expect((await appButton()).textContent).toBe('AppEduLiberta'));

    const stillPicked = async (hash: string) => {
      await waitFor(() => expect(window.location.hash).toBe(hash));
      expect(window.location.search).toContain('app=eduliberta');
      await waitFor(async () => expect((await appButton()).textContent).toBe('AppEduLiberta'));
    };

    fireEvent.click(screen.getByRole('link', { name: 'Runs' }));
    await stillPicked('#runs');
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    await stillPicked('#overview');
    fireEvent.change(screen.getByLabelText('from day'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(window.location.hash).toContain('from=2026-11-01'));
    await stillPicked(window.location.hash);

    await pick(await orgButton(), /Globex/);
    await waitFor(() => expect(window.location.search).toBe('?app=eduliberta&tenant=globex'));
    await waitFor(async () => expect((await orgButton()).textContent).toBe('OrganizationGlobex'));
    await stillPicked(window.location.hash);

    // Every governance read since the pick carried the app.
    const reads = fetchFn.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes('/governance/') && u.includes('tenant=globex'));
    expect(reads.length).toBeGreaterThan(0);
    for (const u of reads) expect(u).toContain('app=eduliberta');
  });

  it('the Organization picker follows back/forward to an entry with another ?tenant=', async () => {
    setConfig({ apiBase: '/agent' });
    scopedApi();
    window.history.replaceState(null, '', '/agent/dashboard/?app=eduliberta#overview');
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: 'Runs' }));
    await waitFor(() => expect(window.location.hash).toBe('#runs'));
    await pick(await orgButton(), /Globex/);
    await waitFor(async () => expect((await orgButton()).textContent).toBe('OrganizationGlobex'));

    // "Back" to the Overview entry, which has no ?tenant=.
    act(() => {
      window.history.replaceState(null, '', '/agent/dashboard/?app=eduliberta#overview');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(async () =>
      expect((await orgButton()).textContent).toBe('OrganizationAll organizations'),
    );
    expect((await appButton()).textContent).toBe('AppEduLiberta');
  });
});
