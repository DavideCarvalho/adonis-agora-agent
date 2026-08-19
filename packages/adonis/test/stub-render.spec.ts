import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper, shared with the .mjs child-process harnesses.
import { PUBLISHED_STUBS, renderAllStubs, stubsRoot } from './helpers/render-stub.mjs';

/**
 * Every stub `node ace configure` publishes must actually render through the REAL engine.
 *
 * This gate exists because all four of them did not, in every published version. `codemods.makeUsingStub`
 * runs a stub body through Tempura, which compiles it into a JS **template literal** — so a bare
 * backtick in the body closes that literal and a bare `${` opens an interpolation, and either throws.
 * Our bodies were full of both, in ordinary JSDoc prose (`` `lucid` ``, `` `${documentId}#<n>` ``).
 *
 * `configure` therefore aborted on the FIRST stub, after `updateRcFile` had already succeeded — leaving
 * an app whose `adonisrc.ts` referenced the providers with no `config/agent.ts` for them to read.
 *
 * Nothing caught it because every harness here rendered stubs by stripping the `{{{ }}}` header with a
 * regex and using the remainder. A gate that renders differently from the generator is not testing the
 * generator. The fix is `test/helpers/render-stub.mjs`, which calls `prepare()` — `generate()`'s render
 * step without the disk write.
 *
 * Deliberately asserts on RENDERABILITY rather than on "no backticks in the body". Escaped backticks
 * (`` \` ``) and `\${` render to real backticks and a literal `${`, so the published files keep their
 * prose exactly; a lint-style ban would forbid something that works and would still miss whatever
 * else Tempura chokes on next.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const configurePath = join(currentDir, '..', 'configure.ts');

describe('every published stub renders through the real configure engine', () => {
  it('renders all of them without throwing', async () => {
    // `renderAllStubs` throws on the first failure, so a passing call IS the assertion. Awaiting it
    // outside an `expect` would still fail the test, but this reads as the check it is.
    await expect(renderAllStubs()).resolves.toBeInstanceOf(Map);
  });

  it('produces non-empty output with a resolved destination for each', async () => {
    const rendered = await renderAllStubs();
    for (const stubPath of PUBLISHED_STUBS) {
      const output = rendered.get(stubPath);
      expect(output, `${stubPath} did not render`).toBeDefined();
      expect(output.contents.length, `${stubPath} rendered empty`).toBeGreaterThan(0);
      expect(output.destination, `${stubPath} has no destination`).toMatch(/\.ts$/);
    }
  });

  it('renders the prose intact — escaping is a render concern, not a content one', async () => {
    // The escapes must not leak into what the consumer receives. If `\`` ever started rendering as a
    // literal backslash-backtick, the published files would be full of them and nothing else here
    // would notice.
    const rendered = await renderAllStubs();
    for (const [stubPath, { contents }] of rendered) {
      expect(contents, `${stubPath} leaked an escape into its output`).not.toContain('\\`');
      expect(contents, `${stubPath} leaked an escape into its output`).not.toContain('\\${');
    }
    // And the backticks really do survive, rather than having been quietly stripped.
    expect(rendered.get('database/migrations/create_agent_tables.stub').contents).toContain(
      '`createAgentTables`',
    );
    expect(rendered.get('database/migrations/create_agent_rag_chunks.stub').contents).toContain(
      '`${documentId}#<n>`',
    );
  });

  it('covers exactly the stubs `configure` publishes', () => {
    // A stub added to `configure.ts` but not to PUBLISHED_STUBS would ship ungated — which is the
    // shape of the original bug, not a hypothetical.
    const configure = readFileSync(configurePath, 'utf8');
    const published = [...configure.matchAll(/makeUsingStub\(\s*stubsRoot,\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect([...PUBLISHED_STUBS].sort()).toEqual(published.sort());
  });

  it('covers every stub file on disk', () => {
    // The other direction: a stub file that exists but is not published is dead weight, and one that
    // is published from somewhere other than `configure.ts` would slip past the check above.
    const onDisk = readdirSync(stubsRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.stub'))
      .map((entry) => relative('.', entry).split('\\').join('/'));
    expect(onDisk.sort()).toEqual([...PUBLISHED_STUBS].sort());
  });
});
