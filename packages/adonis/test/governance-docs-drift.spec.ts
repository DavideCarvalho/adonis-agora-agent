import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the documented access facts of the agent console — `dashboard.authorize` gates the console
 * AND the `/agent/governance/*` routes; omitted, it is open outside production and `403` in
 * production; `approvals/mine` is not gated by it — in the source AND in the published docs, and
 * keeps the removed `governanceAuthorize` option out of every page but the 1.0 migration guide.
 *
 * Asserts only on machine-stable tokens; text is flattened (and, for MDX, stripped of `*`/backtick
 * markers), so rewording and reflowing are free while dropping a fact is not.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const read = (...segments: string[]) => readFileSync(join(currentDir, '..', ...segments), 'utf8');

/** Collapse a JSDoc block or a wrapped string literal to one line: drop `*` gutters and wrapping. */
function flatten(text: string): string {
  return text
    .replace(/\s*\n\s*\*?\s?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `/** … *\/` block immediately preceding `marker`, flattened. */
function jsdocBefore(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`marker not found in source: ${marker}`);
  const end = source.lastIndexOf('*/', at);
  const start = source.lastIndexOf('/**', end);
  if (end === -1 || start === -1) throw new Error(`no JSDoc block precedes: ${marker}`);
  return flatten(source.slice(start + 3, end));
}

/** Flatten an MDX page and drop the markdown emphasis/code markers (`*` and backticks). */
function flattenMdx(text: string): string {
  return text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

const dashboardConfigSource = read('src', 'dashboard', 'define_config.ts');

const sites: [name: string, text: string][] = [
  [
    'AgentDashboardConfig.authorize JSDoc',
    jsdocBefore(dashboardConfigSource, 'authorize?: AgentDashboardAuthorize;'),
  ],
  [
    'docs/governance/authorization.mdx',
    flattenMdx(read('docs', 'governance', 'authorization.mdx')),
  ],
  ['docs/governance/dashboard.mdx', flattenMdx(read('docs', 'governance', 'dashboard.mdx'))],
];

describe.each(sites)('%s', (_name, text) => {
  it('says authorize gates the governance routes', () => {
    expect(text).toContain('/agent/governance/');
  });

  it('states the default: open outside production, refused in production', () => {
    expect(text.toLowerCase()).toContain('outside production');
    expect(text).toContain('403');
  });

  it('says `approvals/mine` is not gated by it', () => {
    expect(text).toContain('approvals/mine');
  });
});

/** Every `.mdx` page under `docs/`, relative to the package root. */
function docPages(): string[] {
  return readdirSync(join(currentDir, '..', 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.mdx'))
    .map((entry) => join('docs', entry))
    .sort();
}

describe('no page in docs/ teaches the removed governanceAuthorize option', () => {
  const pages = docPages().filter((page) => !page.endsWith('migrating-to-1-0.mdx'));

  it('finds pages to check (the walk is not silently empty)', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it.each(pages)('%s', (page) => {
    expect(read(page), page).not.toContain('governanceAuthorize');
  });
});
