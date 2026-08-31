import { describe, expect, it } from 'vitest';
import { CONFIG_ELEMENT_ID, deriveApiBase, resolveApiBase } from './api-base.js';

describe('deriveApiBase', () => {
  it('drops the trailing /dashboard mount segment', () => {
    expect(deriveApiBase('/agent/dashboard')).toBe('/agent');
    expect(deriveApiBase('/agent/dashboard/')).toBe('/agent');
    expect(deriveApiBase('/api/agent/dashboard')).toBe('/api/agent');
  });
  it('handles a root-mounted dashboard', () => {
    expect(deriveApiBase('/dashboard')).toBe('/');
  });
  it('best-effort cleans a non-dashboard path', () => {
    expect(deriveApiBase('/agent/')).toBe('/agent');
  });
});

describe('resolveApiBase', () => {
  /** A document carrying the provider's data block, as `injectApiBase` emits it. */
  const docWith = (text: string) =>
    ({
      getElementById: (id: string) => (id === CONFIG_ELEMENT_ID ? { textContent: text } : null),
    }) as unknown as Document;
  const noDoc = { getElementById: () => null } as unknown as Document;

  it('prefers the JSON data block the provider injects', () => {
    const win = {
      location: { pathname: '/agent/dashboard' },
      __AGENT_DASHBOARD_BASE__: '/stale',
    } as unknown as Window;
    expect(resolveApiBase(win, docWith('{"apiBase":"/custom/agent/"}'))).toBe('/custom/agent');
  });
  it('ignores a block that is not JSON, or carries no base', () => {
    const win = { location: { pathname: '/agent/dashboard' } } as unknown as Window;
    expect(resolveApiBase(win, docWith('{nope'))).toBe('/agent');
    expect(resolveApiBase(win, docWith('{"apiBase":""}'))).toBe('/agent');
  });
  it('prefers the injected base', () => {
    const win = {
      location: { pathname: '/agent/dashboard' },
      __AGENT_DASHBOARD_BASE__: '/custom/agent/',
    } as unknown as Window;
    expect(resolveApiBase(win, noDoc)).toBe('/custom/agent');
  });
  it('falls back to the location-derived base', () => {
    const win = { location: { pathname: '/agent/dashboard' } } as unknown as Window;
    expect(resolveApiBase(win, noDoc)).toBe('/agent');
  });
});
