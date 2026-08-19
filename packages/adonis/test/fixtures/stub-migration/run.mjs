/**
 * Runs the published migration stub the way a consumer app does, end to end, against BOTH database
 * states a real app is in — and asserts what it leaves behind.
 *
 * WHY A SEPARATE PROCESS. Two reasons, both load-bearing:
 *  1. `@adonisjs/lucid/services/db` — which the stub imports, and which is the whole reason the stub
 *     can call `createAgentTables` at all — resolves `container.make(Database)` against the app
 *     service when its module body evaluates. It only works inside a booted AdonisJS app, so this
 *     file boots one.
 *  2. The stub is resolved as a real dependency (`@adonis-agora/agent` through its `exports` map,
 *     i.e. the BUILT dist) from a scratch app directory with its own `node_modules`. Inside vitest
 *     the package would resolve to `src/`, which is not what ships.
 *
 * ONE SCENARIO PER PROCESS, selected by `process.argv[2]`. Not a stylistic split: the stub imports
 * `@adonisjs/lucid/services/db`, which resolves `make(Database)` once and is then cached by the ESM
 * loader for the life of the process. Running two scenarios in one process would leave the second
 * migration writing into the FIRST scenario's (already closed) database, and the second scenario would
 * pass by inspecting a database nothing had migrated. Found the hard way — the legacy scenario
 * "passed" its table checks while `agent_run` was never created.
 *
 * Exits 0 on success, non-zero with a message on failure. Driven by `migration-stub-runs.spec.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { Logger } from '@adonisjs/core/logger';
import { setApp } from '@adonisjs/core/services/app';
import { Database } from '@adonisjs/lucid/database';
import { MigrationRunner } from '@adonisjs/lucid/migration';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const stubPath = join(pkgRoot, 'stubs/database/migrations/create_agent_tables.stub');

/**
 * `pool.max = 1` on purpose. It is the tightest pool an app can configure (and what Adonis's own
 * SQLite guidance suggests), and it is the configuration that fails if the stub ever loses
 * `static disableTransactions = true`: the migrator's transaction would hold the only connection
 * while `createAgentTables` — which checks out its own — waited for one, and the migration would die
 * with "Timeout acquiring a connection". A larger pool would hide that regression entirely.
 */
const POOL_MAX = 1;

const AGENT_TABLES = [
  'agent_thread',
  'agent_message',
  'agent_tool_call',
  'agent_token_usage',
  'agent_model_pricing',
  'agent_run',
];

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

/** Render the stub exactly as `node ace configure` does: strip the header, keep every other byte. */
function renderStub() {
  const source = readFileSync(stubPath, 'utf8');
  const rendered = source.replace(/^\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (rendered === source) throw new Error('stub header not found — render assumption broken');
  return rendered;
}

/** A scratch consumer app that depends on the package by NAME, so it resolves through `exports` into dist/. */
function makeScratchApp() {
  const appRoot = mkdtempSync(join(tmpdir(), 'agent-stub-migration-'));
  mkdirSync(join(appRoot, 'database/migrations'), { recursive: true });
  mkdirSync(join(appRoot, 'node_modules/@adonis-agora'), { recursive: true });
  writeFileSync(
    join(appRoot, 'package.json'),
    '{ "name": "agent-stub-migration-app", "type": "module", "private": true }\n',
  );
  symlinkSync(pkgRoot, join(appRoot, 'node_modules/@adonis-agora/agent'));
  for (const dep of ['@adonisjs', 'better-sqlite3']) {
    symlinkSync(join(pkgRoot, 'node_modules', dep), join(appRoot, 'node_modules', dep));
  }
  // Written as `.js`: a scratch app has no TypeScript loader, and the stub's body carries no type
  // syntax, so the executed statements are byte-identical to what a consumer runs.
  const migrationName = '1785200000000_create_agent_tables';
  writeFileSync(join(appRoot, `database/migrations/${migrationName}.js`), renderStub());
  return { appRoot, migrationName };
}

function makeDatabase(dbFile) {
  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: dbFile },
          useNullAsDefault: true,
          pool: {
            min: 1,
            max: POOL_MAX,
            acquireTimeoutMillis: 5_000,
            // Durability pragmas, not correctness ones: this database is a scratch file that lives
            // for one assertion, and the default per-statement fsync dominates the runtime (~5s of
            // DDL becomes well under one). Neither pragma touches connection ACQUISITION, so the
            // `max: 1` deadlock this harness exists to catch behaves identically.
            afterCreate: (connection, done) => {
              connection.pragma('journal_mode = MEMORY');
              connection.pragma('synchronous = OFF');
              done(null, connection);
            },
          },
          migrations: { naturalSort: true },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter({ container: {} }),
  );
}

/** Boot a real AdonisJS app with `db` bound the way lucid's own database_provider binds it. */
async function bootApp(appRoot, db) {
  const app = new AppFactory().create(pathToFileURL(`${appRoot}/`), () => {});
  await app.init();
  // `services/db` resolves `make(Database)`, so binding only the `lucid.db` alias is not enough.
  app.container.singleton(Database, () => db);
  app.container.alias('lucid.db', Database);
  await app.boot();
  setApp(app);
  return app;
}

/**
 * A FRESH schema builder per probe: knex's builder is stateful, and reusing one instance replays its
 * accumulated statements and reports the first result (which reads as "the table is still there"
 * after a rollback that did drop it).
 */
const schemaOf = (db) => () => db.connection('primary').schema;

// ── scenario 1: an EMPTY database ────────────────────────────────────────────────────────────────
async function emptyDatabase() {
  const { appRoot, migrationName } = makeScratchApp();
  try {
    const db = makeDatabase(join(appRoot, 'app.sqlite'));
    const bootedApp = await bootApp(appRoot, db);
    const schema = schemaOf(db);

    const up = new MigrationRunner(db, bootedApp, { direction: 'up' });
    await up.run();
    if (up.error) throw up.error;
    check(
      up.status === 'completed',
      `[empty] migration:run status was "${up.status}", expected "completed"`,
    );

    for (const table of AGENT_TABLES) {
      check(await schema().hasTable(table), `[empty] table ${table} was not created`);
    }
    // The columns the second, now-deleted stub used to add. They must arrive with the tables.
    for (const table of ['agent_message', 'agent_tool_call', 'agent_token_usage']) {
      check(
        await schema().hasColumn(table, 'run_id'),
        `[empty] column ${table}.run_id was not created`,
      );
    }

    const recorded = await db.connection('primary').from('adonis_schema').select('name');
    check(
      recorded.length === 1 && recorded[0].name.endsWith(migrationName),
      `[empty] adonis_schema should hold exactly this migration, got ${JSON.stringify(recorded)}`,
    );

    // Present is not the same as usable: write and read a thread through the real store.
    const { LucidAgentStore } = await import('@adonis-agora/agent');
    const store = new LucidAgentStore(db.connection('primary'), { autoCreateTables: false });
    const thread = await store.createThread({
      actor: { id: 'u_1', roles: ['ADMIN'] },
      persona: 'default',
    });
    const threads = await store.listThreads('u_1');
    check(
      threads.some((row) => row.id === thread.id),
      '[empty] the store could not round-trip a thread through the migrated schema',
    );

    // ── migration:rollback ────────────────────────────────────────────────────────────────────
    const down = new MigrationRunner(db, bootedApp, { direction: 'down' });
    await down.run();
    if (down.error) throw down.error;
    for (const table of AGENT_TABLES) {
      check(!(await schema().hasTable(table)), `[empty] table ${table} survived the rollback`);
    }

    await db.manager.closeAll();
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

// ── scenario 2: a database autoCreateTables ALREADY provisioned ──────────────────────────────────
async function alreadyProvisionedDatabase() {
  const { appRoot } = makeScratchApp();
  try {
    const db = makeDatabase(join(appRoot, 'app.sqlite'));
    const bootedApp = await bootApp(appRoot, db);
    const schema = schemaOf(db);

    // Exactly what a real app does before it ever runs a migration: `autoCreateTables` defaults to
    // `true`, and the first use of the store provisions the shared schema. THIS is the state the old
    // stub threw against — `createTable('agent_thread')` on a table that is already there.
    const { LucidAgentStore } = await import('@adonis-agora/agent');
    const store = new LucidAgentStore(db.connection('primary'));
    const existing = await store.createThread({
      actor: { id: 'u_1', roles: ['ADMIN'] },
      persona: 'default',
    });
    check(
      await schema().hasTable('agent_thread'),
      '[provisioned] setup failed: autoCreateTables did not provision the tables',
    );

    const up = new MigrationRunner(db, bootedApp, { direction: 'up' });
    await up.run();
    if (up.error) throw up.error;
    check(
      up.status === 'completed',
      `[provisioned] migration:run status was "${up.status}", expected "completed" ` +
        `(error: ${up.error?.message ?? 'none'})`,
    );

    for (const table of AGENT_TABLES) {
      check(
        await schema().hasTable(table),
        `[provisioned] table ${table} is missing after migrating`,
      );
    }
    // A no-op migration must not have dropped and recreated anything.
    const threads = await store.listThreads('u_1');
    check(
      threads.some((row) => row.id === existing.id),
      '[provisioned] the migration destroyed data that existed before it ran',
    );

    await db.manager.closeAll();
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

// ── scenario 3: a database that predates run tracking ────────────────────────────────────────────
async function preRunTrackingDatabase() {
  const { appRoot } = makeScratchApp();
  try {
    const db = makeDatabase(join(appRoot, 'app.sqlite'));
    const bootedApp = await bootApp(appRoot, db);
    const schema = schemaOf(db);

    // The old five-table schema, as an app that configured before run tracking shipped still has it:
    // `agent_message` with no `run_id`, and no `agent_run` at all.
    const raw = db.connection('primary');
    await raw.rawQuery(
      `CREATE TABLE "agent_thread" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "actor_ref" VARCHAR(255) NOT NULL,
       "tenant_ref" VARCHAR(255) NULL, "title" TEXT NOT NULL, "persona" VARCHAR(255) NOT NULL DEFAULT 'default',
       "transient" INTEGER NOT NULL DEFAULT 0, "pinned_at" BIGINT NULL, "summary" TEXT NULL,
       "summary_message_count" INTEGER NOT NULL DEFAULT 0, "active_stream_id" VARCHAR(255) NULL,
       "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL, "deleted_at" BIGINT NULL)`,
    );
    await raw.rawQuery(
      `CREATE TABLE "agent_message" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "thread_id" VARCHAR(255) NOT NULL,
       "role" VARCHAR(255) NOT NULL, "content" TEXT NOT NULL, "tool_calls" TEXT NULL, "tool_results" TEXT NULL,
       "attachments" TEXT NULL, "follow_ups" TEXT NULL, "usage" TEXT NULL, "persona" VARCHAR(255) NULL,
       "created_at" BIGINT NOT NULL)`,
    );
    await raw.rawQuery(
      `CREATE TABLE "agent_tool_call" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "message_id" VARCHAR(255) NOT NULL,
       "tool_name" VARCHAR(255) NOT NULL, "tool_type" VARCHAR(255) NOT NULL, "input" TEXT NULL, "output" TEXT NULL,
       "status" VARCHAR(255) NOT NULL, "executed_by_ref" VARCHAR(255) NULL, "execution_ms" INTEGER NULL,
       "error" TEXT NULL, "created_at" BIGINT NOT NULL, "executed_at" BIGINT NULL)`,
    );
    await raw.rawQuery(
      `CREATE TABLE "agent_token_usage" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "thread_id" VARCHAR(255) NOT NULL,
       "actor_ref" VARCHAR(255) NOT NULL, "message_id" VARCHAR(255) NULL, "model_id" VARCHAR(255) NOT NULL,
       "purpose" VARCHAR(255) NOT NULL, "input_tokens" INTEGER NOT NULL, "output_tokens" INTEGER NOT NULL,
       "cache_write_tokens" INTEGER NULL, "cache_read_tokens" INTEGER NULL, "cost_usd" DOUBLE PRECISION NULL,
       "created_at" BIGINT NOT NULL)`,
    );
    check(
      !(await schema().hasColumn('agent_message', 'run_id')),
      '[legacy] setup failed: the legacy schema should NOT have run_id',
    );

    const up = new MigrationRunner(db, bootedApp, { direction: 'up' });
    await up.run();
    if (up.error) throw up.error;
    check(
      up.status === 'completed',
      `[legacy] migration:run status was "${up.status}", expected "completed"`,
    );

    // The additive half: the columns the deleted `create_agent_run_tracking` stub used to ALTER in.
    // Without this repair, collapsing the two stubs into one would have silently dropped the upgrade
    // path for every app provisioned before run tracking.
    for (const table of ['agent_message', 'agent_tool_call', 'agent_token_usage']) {
      check(
        await schema().hasColumn(table, 'run_id'),
        `[legacy] column ${table}.run_id was not repaired into the legacy schema`,
      );
    }
    check(await schema().hasTable('agent_run'), '[legacy] agent_run was not created');

    // And the repaired schema is actually usable by the store that needs those columns.
    const { LucidAgentStore } = await import('@adonis-agora/agent');
    const store = new LucidAgentStore(db.connection('primary'), { autoCreateTables: false });
    const thread = await store.createThread({
      actor: { id: 'u_1', roles: ['ADMIN'] },
      persona: 'default',
    });
    await store.recordRunStart({
      runId: 'run-1',
      threadId: thread.id,
      actor: { id: 'u_1', roles: ['ADMIN'] },
      agentName: 'default',
    });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'hi',
      runId: 'run-1',
    });
    check(
      typeof message.id === 'string',
      '[legacy] the store could not write a run-correlated message after the repair',
    );

    await db.manager.closeAll();
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

const SCENARIOS = {
  empty: emptyDatabase,
  provisioned: alreadyProvisionedDatabase,
  legacy: preRunTrackingDatabase,
};

const name = process.argv[2];
const scenario = SCENARIOS[name];
if (scenario === undefined) {
  console.error(
    `unknown scenario "${name}" — expected one of ${Object.keys(SCENARIOS).join(', ')}`,
  );
  process.exit(2);
}

await scenario();

if (failures.length > 0) {
  console.error(`stub migration harness [${name}]: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`stub migration harness [${name}]: OK`);
