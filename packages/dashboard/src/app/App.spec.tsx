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
