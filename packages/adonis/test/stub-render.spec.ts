import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  distStubsRoot,
  PUBLISHED_STUBS,
  renderAllStubs,
  stubsRoot,
} from './helpers/render-stub.mjs';

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
      if (output === undefined) {
        expect.fail(`${stubPath} did not render`);
      }
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
    expect(rendered.get('database/migrations/create_agent_tables.stub')?.contents).toContain(
      '`createAgentTables`',
    );
    expect(rendered.get('database/migrations/create_agent_rag_chunks.stub')?.contents).toContain(
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

/**
 * `dist/stubs/**` must be the same set, with the same bytes, as `stubs/**`.
 *
 * `copy:stubs` is a plain `cp` chain in the build script — outside the compiler's knowledge, and
 * invisible to `assert-build-output.mjs`, which walks `package.json` `exports` and stubs are not
 * exported. So nothing fails if it skips a file. The two config stubs are worse than the migrations:
 * they are copied by NAME (`cp stubs/config/agent.stub …`), so a third config stub ships only if
 * someone also remembers to edit the build script.
 *
 * Set equality alone would not be enough. The failure this family of bugs actually produced was a
 * CONTENT divergence — a de-backticking pass that left the source looking fine while the published
 * copy was the broken one. So this compares bytes, and then renders the BUILT copy through the real
 * engine: rendering the source proves nothing about what a consumer installs.
 */
describe('dist/stubs is a faithful copy of stubs/', () => {
  /** Every `.stub` under a root, as forward-slashed paths relative to it. */
  function stubFiles(root: string): string[] {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.stub'))
      .map((entry) => entry.split('\\').join('/'))
      .sort();
  }

  // Same policy as the other dist-dependent specs: under CI a missing build is a failure (where
  // `pnpm test` gates the publish), on a developer machine it is a convenience skip.
  if (!existsSync(distStubsRoot)) {
    if (process.env.CI) {
      it('compares dist/stubs against stubs/', () => {
        expect.fail(
          `${distStubsRoot} does not exist, so this spec cannot check anything. Run \`pnpm build\` before \`pnpm test\`.`,
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/agent build` first', () => {});
    }
  } else {
    it('ships exactly the stubs that exist in source', () => {
      expect(
        stubFiles(distStubsRoot),
        'dist/stubs differs from stubs/ — `copy:stubs` in package.json missed a file',
      ).toEqual(stubFiles(stubsRoot));
    });

    it('ships them byte for byte', () => {
      for (const file of stubFiles(stubsRoot)) {
        expect(
          readFileSync(join(distStubsRoot, file), 'utf8'),
          `dist/stubs/${file} differs from the source — the published copy is the one consumers get`,
        ).toBe(readFileSync(join(stubsRoot, file), 'utf8'));
      }
    });

    it('renders the BUILT copy, not just the source', async () => {
      // The source rendering above says nothing about what `node ace configure` reaches at runtime,
      // which resolves `stubsRoot` inside `dist/`.
      const rendered = await renderAllStubs({}, distStubsRoot);
      for (const stubPath of PUBLISHED_STUBS) {
        expect(
          rendered.get(stubPath)?.contents.length,
          `${stubPath} rendered empty from dist`,
        ).toBeGreaterThan(0);
      }
    });
  }
});
