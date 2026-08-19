/**
 * Type-checks the PUBLISHED migration stubs the way a consumer app does: a scratch AdonisJS-shaped
 * app that depends on `@adonis-agora/agent` and `@adonisjs/lucid` by NAME, with the rendered stub as
 * a real `database/migrations/*.ts`, compiled by a real `tsc --noEmit`.
 *
 * WHY THIS EXISTS. The package's own typecheck compiles `src/` against its own interfaces, and the
 * stub is not part of any tsconfig `include` — it is a `.stub` template. So a stub could reference an
 * API shape that the library's INTERNAL types accept while the real `@adonisjs/lucid` types reject,
 * and every gate in this repo would stay green. That is exactly what happened: the stub passed
 * `db.connection(name)` (a `QueryClientContract`) into a parameter typed `LucidDatabaseLike`, whose
 * `rawQuery` declared `bindings?: unknown[]` — not assignable in either direction to Lucid's
 * `RawQueryBindings`. Consumers got a migration that did not compile.
 *
 * Only a compile against the REAL Lucid types can catch that, which is what this does.
 *
 * The stubs are rendered by the REAL configure engine (`test/helpers/render-stub.mjs`), not by a
 * regex over the `{{{ }}}` header. A harness that renders differently from the generator is not
 * testing the generator — and this one used to, which is how four unrenderable stubs stayed green.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `migration-stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStub } from '../../helpers/render-stub.mjs';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The migration stubs a consumer receives from `node ace configure`. */
const STUBS = ['create_agent_tables', 'create_agent_rag_chunks'];

const appRoot = mkdtempSync(join(tmpdir(), 'agent-stub-typecheck-'));
try {
  mkdirSync(join(appRoot, 'database/migrations'), { recursive: true });
  mkdirSync(join(appRoot, 'node_modules/@adonis-agora'), { recursive: true });

  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'agent-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );

  // Resolve the package by NAME through its `exports` map, so the stub is checked against the
  // PUBLISHED `dist/**/*.d.ts` — the types a consumer actually gets — not against `src/`.
  symlinkSync(pkgRoot, join(appRoot, 'node_modules/@adonis-agora/agent'));
  for (const dep of ['@adonisjs', 'better-sqlite3', 'luxon']) {
    symlinkSync(join(pkgRoot, 'node_modules', dep), join(appRoot, 'node_modules', dep));
  }
  symlinkSync(join(pkgRoot, 'node_modules/@types'), join(appRoot, 'node_modules/@types'));

  // An AdonisJS app's compiler options: NodeNext + strict, which is what the framework's own
  // `@adonisjs/tsconfig` sets and what makes the contravariant `rawQuery` mismatch a hard error.
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          experimentalDecorators: true,
        },
        include: ['database/**/*.ts'],
      },
      null,
      2,
    ),
  );

  for (const [index, name] of STUBS.entries()) {
    // Rendered by the REAL engine, so this harness also fails if the stub cannot be generated at all —
    // which is precisely what a regex renderer here could never see.
    const { contents } = await renderStub(`database/migrations/${name}.stub`);
    writeFileSync(join(appRoot, `database/migrations/17852000000${index}0_${name}.ts`), contents);
  }

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error(
      'stub typecheck: FAILED — the published migration does not compile in a consumer app',
    );
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log('stub typecheck: OK');
