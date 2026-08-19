import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles the PUBLISHED migration stubs inside a scratch consumer app, against the REAL
 * `@adonisjs/lucid` types.
 *
 * This is the gap that shipped a broken migration twice over. The package's own typecheck compiles
 * `src/` against its own structural interfaces, and a `.stub` is a template that no tsconfig
 * `include` covers — so the stub could hand a `QueryClientContract` to a parameter typed
 * `LucidDatabaseLike`, the library's internal types would be perfectly happy, and every gate in this
 * repo stayed green while consumers got a migration that would not compile.
 *
 * The specific failure: `LucidDatabaseLike.rawQuery` declared `bindings?: unknown[]`, which is
 * assignable in NEITHER direction to Lucid's `RawQueryBindings` — so only the `Database` manager
 * (whose own `bindings` is `any`) satisfied it. `db.connection(name)`, which is what scopes the DDL
 * for `migration:run --connection=x`, did not. Sibling specs assert the stub *delegates*
 * (`migration-stub-schema`) and that it *runs* (`migration-stub-runs`); neither can see a type error,
 * because both operate on JavaScript.
 *
 * Checks both published stubs — the pgvector one broke identically and was not in the original report.
 */
describe('the published migration stubs compile in a consumer app (real @adonisjs/lucid types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  // The harness resolves `@adonis-agora/agent` by name, so it checks the stub against the PUBLISHED
  // `dist/**/*.d.ts` — the declarations a consumer actually installs, not `src/`. That makes a built
  // package a precondition. Same policy as the sibling stub specs: hard failure under CI (where
  // `pnpm test` gates the publish), convenience skip on a developer machine.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated migration COMPILES for a consumer; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/agent build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Lucid + Adonis declaration graph is a few seconds; 90s is a ceiling that
    // will not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
