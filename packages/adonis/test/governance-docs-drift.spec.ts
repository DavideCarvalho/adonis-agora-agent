import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the documented facts about `governanceAuthorize` against drift, in the source AND in the
 * published docs.
 *
 * The mount split (no gate → `/agent/governance/*` is not mounted) left the old open-by-default
 * behaviour standing in two groups of doc sites: the JSDoc/boot-warning group (the public
 * `AgentConfig.governanceAuthorize` JSDoc, the two JSDoc blocks in `governance-gate.ts`, and the
 * provider's boot warning), and the published MDX pages — which are strictly worse, being indexed,
 * cross-linked, and read by someone deciding whether they need the gate at all. A doc that
 * contradicts the code is the artifact a reader trusts most and verifies least, and this repo has
 * already paid for that twice (`delegateInputSchema`'s "the loop validates against it", authkit's
 * `admin.impersonation` docblocks).
 *
 * Deliberately narrow. Prose cannot be diffed the way the sibling `adonis-durable` drift spec diffs
 * two column-name lists, so this asserts ONLY on machine-stable tokens — the config key, the literal
 * migration escape hatch `governanceAuthorize: () => true`, the route path `approvals/mine`, and a
 * "not mount" claim — plus negative assertions on the retired sentences. Text is flattened (and, for
 * MDX, stripped of `*`/backtick markers), so rewording, re-bolding, and reflowing are all free;
 * dropping a fact or resurrecting the false claim is not.
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

/**
 * The `/** … *\/` block immediately preceding `marker`, flattened. Anchored on the declaration rather
 * than on a line number so renaming the property (not just moving it) is what breaks the test.
 */
function jsdocBefore(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`marker not found in source: ${marker}`);
  const end = source.lastIndexOf('*/', at);
  const start = source.lastIndexOf('/**', end);
  if (end === -1 || start === -1) throw new Error(`no JSDoc block precedes: ${marker}`);
  return flatten(source.slice(start + 3, end));
}

/**
 * The argument text of every `callee(...)` call, bounded by bracket-depth matching from the opening
 * `(` to its partner — not by scanning to the next call — so a later call in the file cannot swallow
 * or truncate an earlier one. (The scan does not skip string contents; every bracket inside the
 * warning strings here is balanced, and an unbalanced one throws loudly rather than silently
 * mis-slicing.)
 */
function callArguments(source: string, callee: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${callee}(`, from);
    if (at === -1) return found;
    const open = at + callee.length;
    let depth = 1;
    let cursor = open + 1;
    while (depth > 0) {
      if (cursor >= source.length) throw new Error(`unbalanced brackets after ${callee}(`);
      const char = source[cursor];
      if (char === '(' || char === '{' || char === '[') depth++;
      else if (char === ')' || char === '}' || char === ']') depth--;
      cursor++;
    }
    found.push(source.slice(open + 1, cursor - 1));
    from = cursor;
  }
}

const defineConfigSource = read('src', 'define_config.ts');
const gateSource = read('src', 'governance-gate.ts');
const providerSource = read('providers', 'agent_provider.ts');

/** The provider's governance boot warning — the runtime voice the three doc sites must agree with. */
function governanceBootWarning(): string {
  const warnings = callArguments(providerSource, 'console.warn')
    .map(flatten)
    .filter((text) => text.includes('governance'));
  if (warnings.length !== 1) {
    throw new Error(`expected exactly one governance console.warn, found ${warnings.length}`);
  }
  // Non-null asserted: the guard above threw unless there is exactly one warning.
  return warnings[0]!;
}

/**
 * Flatten an MDX page the way {@link flatten} flattens a JSDoc block, and additionally drop the
 * markdown emphasis/code markers (`*` and backticks) — so bolding a phrase, wrapping a config key in
 * backticks, or reflowing a paragraph never breaks an assertion. Only dropping a fact does.
 */
function flattenMdx(text: string): string {
  return text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

const sites: [name: string, text: string][] = [
  [
    'AgentConfig.governanceAuthorize JSDoc',
    jsdocBefore(defineConfigSource, 'governanceAuthorize?: AgentGovernanceAuthorize;'),
  ],
  [
    'AgentGovernanceAuthorize JSDoc',
    jsdocBefore(gateSource, 'export type AgentGovernanceAuthorize'),
  ],
  [
    'evaluateGovernanceGate JSDoc',
    jsdocBefore(gateSource, 'export async function evaluateGovernanceGate'),
  ],
  ['agent provider boot warning', governanceBootWarning()],
  // The published pages. These are the pages a reader lands on from search or from the config
  // reference's cross-link, so they carry the SAME four facts as the source above.
  ['docs/governance/read-model.mdx', flattenMdx(read('docs', 'governance', 'read-model.mdx'))],
  [
    'docs/governance/authorization.mdx',
    flattenMdx(read('docs', 'governance', 'authorization.mdx')),
  ],
  ['docs/config-reference.mdx', flattenMdx(read('docs', 'config-reference.mdx'))],
];

/**
 * The retired claims, as patterns rather than exact sentences: the same falsehood was phrased three
 * different ways across the docs ("Omit `governanceAuthorize` and any authenticated actor may
 * read…", "Omit it and any resolved (authenticated) actor may read…", "Omit → any authenticated
 * actor may read governance"), so matching one literal string would have missed the other two.
 * `[^.]` keeps each match inside one sentence.
 */
const retiredClaims: [name: string, pattern: RegExp][] = [
  ['governance is readable without a gate', /(omit|without)[^.]{0,80}actor may read/],
  ['governance is readable by any resolved actor', /any resolved actor may read governance/],
  ['governance open to any resolved actor', /governance open to any resolved actor/],
  ['the routes mount, with only a warning', /startup warning when the [^.]{0,30}routes/],
];

describe.each(sites)('%s', (_name, text) => {
  it('states that the routes are not mounted without a gate', () => {
    expect(text.toLowerCase()).toMatch(/not mount/);
  });

  it('names the `governanceAuthorize` config key', () => {
    expect(text).toContain('governanceAuthorize');
  });

  it('offers `governanceAuthorize: () => true` as the explicit opt-in to the old behaviour', () => {
    expect(text).toContain('governanceAuthorize: () => true');
  });

  it('says `approvals/mine` is unaffected', () => {
    expect(text).toContain('approvals/mine');
    expect(text.toLowerCase()).toMatch(/unaffected|stays mounted/);
  });

  it.each(retiredClaims)('does not resurrect the retired claim: %s', (_claim, pattern) => {
    expect(text.toLowerCase()).not.toMatch(pattern);
  });
});

/** Every `.mdx` page under `docs/`, relative to the package root. */
function docPages(): string[] {
  return readdirSync(join(currentDir, '..', 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.mdx'))
    .map((entry) => join('docs', entry))
    .sort();
}

/**
 * The three pages above are where the claim lived, but nothing stops it reappearing on a fourth —
 * it already had leaked into `streaming-and-http.mdx`, `quota-and-cost.mdx` and `dashboard.mdx` in
 * weaker forms, none of which the plan that fixed the first three had listed. So sweep the whole
 * tree for the retired phrasings. Negative-only: a page that never mentions the gate stays free.
 */
describe('no page in docs/ resurrects the retired governance claims', () => {
  const pages = docPages();

  it('finds pages to check (the walk is not silently empty)', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it.each(pages)('%s', (page) => {
    const text = flattenMdx(read(page)).toLowerCase();
    for (const [claim, pattern] of retiredClaims) {
      expect(text, `${page} states the retired claim: ${claim}`).not.toMatch(pattern);
    }
  });
});
