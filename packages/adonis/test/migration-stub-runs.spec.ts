import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * The stub no longer carries DDL — it calls `createAgentTables` / `dropAgentTables`. That trades one
 * risk for another: a DDL snapshot could go stale but could never fail to RUN, whereas a stub that
 * calls into the library breaks the moment that API moves. A stub that does not run is worse than a
 * stale one, so this asserts it runs: real `MigrationRunner`, real SQLite file, real store write,
 * then rollback.
 *
 * Three scenarios, because "it runs" is not one question. The bug that started this was a stub that
 * ran perfectly against an empty database and threw against a provisioned one — and `autoCreateTables`
 * defaults to `true`, so provisioned is the normal state, not the edge case.
 *
 * Each scenario is its OWN child process, for two independent reasons. `@adonisjs/lucid/services/db`
 * (what gives the stub the `Database` manager) resolves `container.make(Database)` when its module
 * body evaluates and is then cached for the life of the process, so two scenarios in one process
 * would leave the second migrating the first's database — which is not hypothetical, it is how the
 * first version of this harness produced a passing legacy scenario against a database nothing had
 * touched. And the harness resolves `@adonis-agora/agent` by name from a scratch app directory, which
 * lands on the BUILT `dist` rather than on `src` the way an in-process vitest import would.
 */
describe('the agent migration stub runs (built artifact, real migrator)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-migration/run.mjs', import.meta.url));
  const distIndex = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

  const scenarios: [scenario: string, what: string][] = [
    [
      'empty',
      'creates every table on an empty database, round-trips a thread, and rolls back clean',
    ],
    [
      'provisioned',
      'is a no-op against a database `autoCreateTables` already provisioned (the bug that started this)',
    ],
    ['legacy', 'repairs the `run_id` columns into a database that predates run tracking'],
  ];

  // Same reasoning as `configure-export.spec.ts`: this spec only means something against a built
  // package, CI starts from a fresh checkout, and `pnpm test` gates the publish. So a missing `dist/`
  // is a hard failure under CI and a convenience skip on a developer machine.
  if (!existsSync(distIndex)) {
    if (process.env.CI) {
      it('runs the published migration stub', () => {
        expect.fail(
          [
            `${distIndex} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated migration actually executes; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/agent build` first', () => {});
    }
  } else {
    // Boots an AdonisJS app, creates a SQLite file, runs a migration: ~2s cold, more under full suite
    // load. 60s is a ceiling, not a target — loose enough never to flake, tight enough that a
    // genuinely hung migration (the `pool: { max: 1 }` deadlock this harness is built to catch) still
    // fails instead of hanging the run.
    it.each(scenarios)(
      '%s: %s',
      async (scenario) => {
        const { stdout } = await execFileAsync(process.execPath, [harness, scenario], {
          timeout: 55_000,
        });
        expect(stdout).toContain(`stub migration harness [${scenario}]: OK`);
      },
      60_000,
    );
  }
});
