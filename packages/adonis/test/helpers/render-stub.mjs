/**
 * Renders a published `.stub` through the SAME engine `node ace configure` uses.
 *
 * Every harness here used to strip the `{{{ exports() }}}` header with a regex and treat the
 * remainder as the output. That is not what the generator does, and the difference is not cosmetic:
 * `codemods.makeUsingStub` runs the body through Tempura, which compiles it into a JS **template
 * literal**. So a bare backtick in the body closes that literal and a bare `${` opens an
 * interpolation — either one throws at render time. A regex renderer cannot see that, which is
 * exactly how four stubs that could never be generated passed every gate in this repo.
 *
 * `prepare()` is the render step of `generate()` without the disk write, so it exercises the real
 * template compilation, the real `exports()` header evaluation, and the real destination path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

/** Absolute path to the SOURCE stubs directory. */
export const stubsRoot = fileURLToPath(new URL('../../stubs/', import.meta.url));

/** Absolute path to the BUILT stubs directory — the copy `copy:stubs` produces and consumers install. */
export const distStubsRoot = fileURLToPath(new URL('../../dist/stubs/', import.meta.url));

/**
 * The stubs `configure.ts` publishes, in the order it publishes them. Kept in sync with `configure.ts`
 * by `stub-render.spec.ts`, so a stub added there without a test here is a failure rather than a gap.
 */
export const PUBLISHED_STUBS = [
  'config/agent.stub',
  'config/mcp.stub',
  'database/migrations/create_agent_tables.stub',
  'database/migrations/create_agent_rag_chunks.stub',
];

/**
 * Boot the minimum AdonisJS app the stubs engine needs. The app root is a scratch directory: the
 * headers call `app.configPath()` / `app.migrationsPath()`, which only resolve paths — nothing is
 * written, because callers use `prepare()`.
 */
async function bootApp() {
  const appRoot = mkdtempSync(join(tmpdir(), 'agent-stub-render-'));
  const app = new AppFactory().create(pathToFileURL(`${appRoot}/`), () => {});
  await app.init();
  await app.boot();
  return { app, appRoot };
}

/**
 * Render one stub the way `configure` does. Returns `{ contents, destination }`.
 * Throws whatever the real engine throws — which is the point.
 */
export async function renderStub(stubPath, stubState = {}, source = stubsRoot) {
  const { app, appRoot } = await bootApp();
  try {
    const stub = await (await app.stubs.create()).build(stubPath, { source });
    const prepared = await stub.prepare(stubState);
    return { contents: prepared.contents, destination: prepared.destination };
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

/**
 * Render every published stub in one booted app. Returns a `Map<stubPath, { contents, destination }>`.
 * Pass `distStubsRoot` as `source` to render what was actually BUILT rather than what is in `stubs/`.
 */
export async function renderAllStubs(stubState = {}, source = stubsRoot) {
  const { app, appRoot } = await bootApp();
  try {
    const rendered = new Map();
    for (const stubPath of PUBLISHED_STUBS) {
      const stub = await (await app.stubs.create()).build(stubPath, { source });
      const prepared = await stub.prepare(stubState);
      rendered.set(stubPath, { contents: prepared.contents, destination: prepared.destination });
    }
    return rendered;
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}
