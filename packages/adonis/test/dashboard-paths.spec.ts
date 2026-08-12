import { describe, expect, it } from 'vitest';
import {
  apiBaseFor,
  contentTypeFor,
  injectApiBase,
  injectBaseHref,
  mountPathFor,
  safeAssetSegments,
  trimSlashes,
} from '../src/dashboard/index.js';

/**
 * Moved verbatim from `@adonis-agora/agent-dashboard`'s `src/server/paths.spec.ts` when these helpers
 * moved into this package (`src/dashboard/paths.ts`) so both the embedded
 * (`providers/dashboard_provider.ts`) and standalone (`agent-dashboard`'s
 * `agent_dashboard_provider.ts`) dashboard providers share one implementation.
 */

describe('trimSlashes', () => {
  it('collapses and strips slashes', () => {
    expect(trimSlashes('/agent//')).toBe('agent');
    expect(trimSlashes('agent')).toBe('agent');
    expect(trimSlashes('/')).toBe('');
  });
});

describe('apiBaseFor', () => {
  it('returns an absolute single-leading-slash base', () => {
    expect(apiBaseFor('agent')).toBe('/agent');
    expect(apiBaseFor('/api/agent/')).toBe('/api/agent');
    expect(apiBaseFor('/')).toBe('/');
  });
});

describe('mountPathFor', () => {
  it('defaults to <agentPath>/dashboard', () => {
    expect(mountPathFor('agent')).toBe('/agent/dashboard');
    expect(mountPathFor('/api/agent/')).toBe('/api/agent/dashboard');
  });
  it('honors an explicit override', () => {
    expect(mountPathFor('agent', '/console')).toBe('/console');
  });
});

describe('contentTypeFor', () => {
  it('maps common extensions', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('main.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
  });
  it('falls back to octet-stream', () => {
    expect(contentTypeFor('mystery.xyz')).toBe('application/octet-stream');
  });
});

describe('safeAssetSegments', () => {
  it('normalizes clean paths', () => {
    expect(safeAssetSegments('assets/app.js')).toEqual(['assets', 'app.js']);
    expect(safeAssetSegments(['assets', 'x.css'])).toEqual(['assets', 'x.css']);
  });
  it('denies traversal attempts', () => {
    expect(safeAssetSegments('../secret')).toBeNull();
    expect(safeAssetSegments('assets/../../etc')).toBeNull();
    expect(safeAssetSegments('a\\b')).toBeNull();
  });
});

describe('injectApiBase', () => {
  it('inserts the base global before </head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectApiBase(html, '/agent');
    expect(out).toContain('window.__AGENT_DASHBOARD_BASE__="/agent"');
    expect(out.indexOf('__AGENT_DASHBOARD_BASE__')).toBeLessThan(out.indexOf('</head>'));
  });
});

describe('injectBaseHref', () => {
  it('inserts <base href="${mount}/"> as the first thing in <head>, before relative asset tags', () => {
    const html = '<html><head><script src="./assets/x.js"></script></head><body></body></html>';
    const out = injectBaseHref(html, '/agent/dashboard');
    expect(out).toContain('<base href="/agent/dashboard/">');
    // The base tag MUST precede the relative asset so the browser resolves `./assets/*` against it.
    expect(out.indexOf('<base ')).toBeLessThan(out.indexOf('./assets/x.js'));
  });

  it('preserves attributes on the <head> tag', () => {
    const out = injectBaseHref('<head lang="en"><title>x</title></head>', '/agent/dashboard');
    expect(out.startsWith('<head lang="en"><base href="/agent/dashboard/">')).toBe(true);
  });

  it('falls back to prepending when there is no <head>', () => {
    expect(injectBaseHref('<div>x</div>', '/agent/dashboard')).toBe(
      '<base href="/agent/dashboard/"><div>x</div>',
    );
  });
});
