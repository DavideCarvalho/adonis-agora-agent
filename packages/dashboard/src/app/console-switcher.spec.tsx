import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSafeHref,
  moveIndex,
  parseConsoles,
  parseSearchGroups,
  readSwitcherConfig,
} from '../client/console-switcher.js';
import { detailFromHash } from './App.js';
import { ConsoleSearch } from './ConsoleSearch.js';
import { ConsoleSwitcher } from './ConsoleSwitcher.js';

function setConfig(config: unknown) {
  document.getElementById('agent-dashboard-config')?.remove();
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'agent-dashboard-config';
  block.textContent = JSON.stringify(config);
  document.head.appendChild(block);
}

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('agent-dashboard-config')?.remove();
});

const brand = <span>Agent brand</span>;

describe('console switcher data', () => {
  it('reads switcher/search from the data block, dropping unsafe endpoints', () => {
    setConfig({ apiBase: '/agent' });
    expect(readSwitcherConfig()).toEqual({});
    setConfig({
      apiBase: '/agent',
      switcher: { endpoint: '/agent/governance/consoles', others: 2 },
      search: { endpoint: '//evil' },
    });
    expect(readSwitcherConfig()).toEqual({
      switcher: { endpoint: '/agent/governance/consoles', others: 2 },
    });
  });

  it('keeps same-origin paths only; unknown icons are generic', () => {
    expect(isSafeHref('/durable')).toBe(true);
    expect(isSafeHref('//x')).toBe(false);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(
      parseConsoles({
        consoles: [
          { id: 'durable', title: 'Workflows', icon: 'weird', href: '/durable' },
          { id: 'x', title: 'X', icon: 'media', href: 'https://evil' },
        ],
      }),
    ).toEqual([{ id: 'durable', title: 'Workflows', icon: 'generic', href: '/durable' }]);
    expect(
      parseSearchGroups({
        groups: [{ id: 'a', title: 'A', icon: 'agent', hits: [{ title: 't', href: '//x' }] }],
      }),
    ).toEqual([]);
    expect(moveIndex(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(moveIndex(1, 'End', 3)).toBe(2);
  });

  it('deep links: #runs/<id> and #threads/<id>', () => {
    expect(detailFromHash('#runs/r%2F1')).toBe('r/1');
    expect(detailFromHash('#runs')).toBeNull();
    expect(detailFromHash('#threads/t1')).toBe('t1');
  });
});

describe('<ConsoleSwitcher>', () => {
  it('is a plain brand and makes no request without the field', () => {
    setConfig({ apiBase: '/agent' });
    const fetchFn = mockFetch({});
    const { container } = render(<ConsoleSwitcher brand={brand} />);
    expect(container.querySelector('[data-agora-switcher]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('stays a plain brand when the list is empty', async () => {
    setConfig({ switcher: { endpoint: '/agent/governance/consoles-empty', others: 1 } });
    const fetchFn = mockFetch({ version: 1, current: 'agent', consoles: [] });
    render(<ConsoleSwitcher brand={brand} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a menu: current console first (not a link), keyboard, Esc restores focus', async () => {
    setConfig({ switcher: { endpoint: '/agent/governance/consoles', others: 2 } });
    mockFetch({
      version: 1,
      current: 'agent',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'evil', title: 'Evil', icon: 'generic', href: '//evil.example' },
        { id: 'media', title: 'Media', icon: 'unknown', href: '/media/dashboard' },
      ],
    });
    render(<ConsoleSwitcher brand={brand} />);
    const button = await screen.findByRole('button', { name: /Agent brand/ });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/durable',
      '/media/dashboard',
    ]);
    expect(screen.getByText('Agents').closest('a')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('<ConsoleSearch>', () => {
  it('renders nothing without a search endpoint', () => {
    setConfig({ apiBase: '/agent' });
    const { container } = render(<ConsoleSearch />);
    expect(container.innerHTML).toBe('');
  });

  it('Ctrl-K opens it; results are grouped per console', async () => {
    setConfig({ search: { endpoint: '/agent/governance/consoles/search' } });
    const fetchFn = mockFetch({
      version: 1,
      query: 'r1',
      groups: [
        {
          id: 'agent',
          title: 'Agents',
          icon: 'agent',
          hits: [{ title: 'Run r1', href: '/agent/dashboard#runs/r1' }],
        },
      ],
    });
    render(<ConsoleSearch />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'r1' } });
    const hit = await screen.findByRole('option', { name: /Run r1/ });
    expect(hit.getAttribute('href')).toBe('/agent/dashboard#runs/r1');
    expect(String((fetchFn.mock.calls as unknown as unknown[][])[0]?.[0])).toBe(
      '/agent/governance/consoles/search?q=r1',
    );
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
