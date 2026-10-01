import type { LucidRawRunner } from './lucid.js';

/**
 * The nine agent table names. They match the cross-adapter snake_case contract the reference Drizzle
 * store uses, so a dashboard or migration can point at any adapter and see the same physical schema.
 */
export const AGENT_TABLES = {
  threads: 'agent_thread',
  messages: 'agent_message',
  toolCalls: 'agent_tool_call',
  tokenUsage: 'agent_token_usage',
  modelPricing: 'agent_model_pricing',
  runs: 'agent_run',
  /** Messages sent while a turn was running, waiting to run after it (the chat queue). */
  queuedMessages: 'agent_queued_message',
  /** Confirm tokens already spent, by hash (`LucidConfirmTokenStore`, single-use confirmed writes). */
  confirmTokens: 'agent_confirm_token',
  /** A run's live stream, buffered for replay by the Lucid token sink (`tokenSinks.lucid()`). */
  streamFrames: 'agent_stream_frame',
} as const;

/**
 * `CREATE TABLE IF NOT EXISTS` for the Lucid token sink's frame buffer, under `table` (the sink takes
 * a `tableName`). One row per frame of a run's stream, numbered from 1 in write order; the row whose
 * `frame` is `NULL` is the end marker. `created_at` is what the sink's TTL purge reads. No foreign
 * key: a sink is usable with any store, and a delegated run writes under its ANCESTOR's run id.
 */
export function streamFrameTableStatement(table: string = AGENT_TABLES.streamFrames): string {
  return `CREATE TABLE IF NOT EXISTS "${table}" (
      "run_id" VARCHAR(255) NOT NULL,
      "seq" BIGINT NOT NULL,
      "frame" TEXT NULL,
      "created_at" BIGINT NOT NULL,
      PRIMARY KEY ("run_id", "seq")
    )`;
}

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the nine agent tables plus their indexes, one statement per
 * array element so each can be issued through Lucid's `rawQuery`. Portable across SQLite / Postgres /
 * MySQL: quoted identifiers, epoch-ms `BIGINT` timestamps, `INTEGER` booleans (0/1) and `TEXT` JSON
 * columns — no dialect-only types. A real deployment should prefer the bundled migration stub so the
 * schema is versioned; this helper lets a store stand itself up in tests and scripts.
 *
 * The tool-call PK is the model-supplied `toolCallId` (not a generated id), preserving the invariant
 * that a persisted tool call is addressable by exactly the id the model emitted.
 *
 * The `agent_run` table records each run (turn) lifecycle; `agent_message` / `agent_tool_call` /
 * `agent_token_usage` each carry a nullable `run_id` correlation column (logically referencing
 * `agent_run.id`, deliberately WITHOUT a DB-level foreign key — like the reference — so the additive
 * migration can `ALTER TABLE ADD COLUMN` portably and a row recorded before run tracking shipped can
 * keep a `null` run_id).
 */
export function createTableStatements(): string[] {
  const t = AGENT_TABLES;
  return [
    `CREATE TABLE IF NOT EXISTS "${t.threads}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "actor_ref" VARCHAR(255) NOT NULL,
      "tenant_ref" VARCHAR(255) NULL,
      "title" TEXT NOT NULL,
      "persona" VARCHAR(255) NOT NULL DEFAULT 'default',
      "transient" INTEGER NOT NULL DEFAULT 0,
      "pinned_at" BIGINT NULL,
      "summary" TEXT NULL,
      "summary_message_count" INTEGER NOT NULL DEFAULT 0,
      "active_stream_id" VARCHAR(255) NULL,
      "model" VARCHAR(255) NULL,
      "queue_pause" TEXT NULL,
      "default_agent" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL,
      "updated_at" BIGINT NOT NULL,
      "deleted_at" BIGINT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.threads}_actor_updated_idx" ON "${t.threads}" ("actor_ref", "updated_at")`,
    `CREATE TABLE IF NOT EXISTS "${t.messages}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "thread_id" VARCHAR(255) NOT NULL REFERENCES "${t.threads}" ("id") ON DELETE CASCADE,
      "role" VARCHAR(255) NOT NULL,
      "content" TEXT NOT NULL,
      "tool_calls" TEXT NULL,
      "tool_results" TEXT NULL,
      "attachments" TEXT NULL,
      "follow_ups" TEXT NULL,
      "usage" TEXT NULL,
      "persona" VARCHAR(255) NULL,
      "run_id" VARCHAR(255) NULL,
      "reasoning" TEXT NULL,
      "reasoning_ms" INTEGER NULL,
      "ui" TEXT NULL,
      "feedback" TEXT NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.messages}_thread_created_idx" ON "${t.messages}" ("thread_id", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "${t.messages}_run_idx" ON "${t.messages}" ("run_id")`,
    `CREATE TABLE IF NOT EXISTS "${t.toolCalls}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "message_id" VARCHAR(255) NOT NULL REFERENCES "${t.messages}" ("id") ON DELETE CASCADE,
      "tool_name" VARCHAR(255) NOT NULL,
      "tool_type" VARCHAR(255) NOT NULL,
      "input" TEXT NULL,
      "output" TEXT NULL,
      "status" VARCHAR(255) NOT NULL,
      "executed_by_ref" VARCHAR(255) NULL,
      "execution_ms" INTEGER NULL,
      "error" TEXT NULL,
      "run_id" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL,
      "executed_at" BIGINT NULL,
      "approver" VARCHAR(255) NULL,
      "expires_at" BIGINT NULL,
      "remember" INTEGER NULL,
      "decided_via" VARCHAR(64) NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.toolCalls}_run_idx" ON "${t.toolCalls}" ("run_id")`,
    `CREATE INDEX IF NOT EXISTS "${t.toolCalls}_status_created_idx" ON "${t.toolCalls}" ("status", "created_at")`,
    `CREATE TABLE IF NOT EXISTS "${t.tokenUsage}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "thread_id" VARCHAR(255) NOT NULL REFERENCES "${t.threads}" ("id") ON DELETE CASCADE,
      "actor_ref" VARCHAR(255) NOT NULL,
      "message_id" VARCHAR(255) NULL,
      "model_id" VARCHAR(255) NOT NULL,
      "purpose" VARCHAR(255) NOT NULL,
      "input_tokens" INTEGER NOT NULL,
      "output_tokens" INTEGER NOT NULL,
      "cache_write_tokens" INTEGER NULL,
      "cache_read_tokens" INTEGER NULL,
      "cost_usd" DOUBLE PRECISION NULL,
      "run_id" VARCHAR(255) NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.tokenUsage}_actor_created_idx" ON "${t.tokenUsage}" ("actor_ref", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "${t.tokenUsage}_run_idx" ON "${t.tokenUsage}" ("run_id")`,
    `CREATE TABLE IF NOT EXISTS "${t.modelPricing}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "model_id" VARCHAR(255) NOT NULL,
      "input_price_per_1m" DOUBLE PRECISION NOT NULL,
      "output_price_per_1m" DOUBLE PRECISION NOT NULL,
      "cache_write_price_per_1m" DOUBLE PRECISION NULL,
      "cache_read_price_per_1m" DOUBLE PRECISION NULL,
      "effective_from" BIGINT NOT NULL,
      "is_current" INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "${t.runs}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "thread_id" VARCHAR(255) NOT NULL REFERENCES "${t.threads}" ("id") ON DELETE CASCADE,
      "agent_name" VARCHAR(255) NULL,
      "parent_run_id" VARCHAR(255) NULL,
      "actor_ref" VARCHAR(255) NOT NULL,
      "tenant_ref" VARCHAR(255) NULL,
      "status" VARCHAR(255) NOT NULL,
      "started_at" BIGINT NOT NULL,
      "finished_at" BIGINT NULL,
      "step_count" INTEGER NOT NULL DEFAULT 0,
      "input_tokens" INTEGER NOT NULL DEFAULT 0,
      "output_tokens" INTEGER NOT NULL DEFAULT 0,
      "cost_usd" DOUBLE PRECISION NULL,
      "error" TEXT NULL,
      "durable" INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.runs}_started_idx" ON "${t.runs}" ("started_at")`,
    `CREATE INDEX IF NOT EXISTS "${t.runs}_actor_started_idx" ON "${t.runs}" ("actor_ref", "started_at")`,
    `CREATE INDEX IF NOT EXISTS "${t.runs}_status_started_idx" ON "${t.runs}" ("status", "started_at")`,
    `CREATE TABLE IF NOT EXISTS "${t.queuedMessages}" (
      "id" VARCHAR(255) PRIMARY KEY NOT NULL,
      "thread_id" VARCHAR(255) NOT NULL REFERENCES "${t.threads}" ("id") ON DELETE CASCADE,
      "actor" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "attachments" TEXT NULL,
      "agent_name" VARCHAR(255) NULL,
      "model" VARCHAR(255) NULL,
      "page_context" TEXT NULL,
      "interrupt" INTEGER NOT NULL DEFAULT 0,
      "position" INTEGER NOT NULL,
      "created_at" BIGINT NOT NULL,
      "updated_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.queuedMessages}_thread_position_idx" ON "${t.queuedMessages}" ("thread_id", "position")`,
    // The primary key IS the lock: two confirmations of one token race on the insert and one loses.
    `CREATE TABLE IF NOT EXISTS "${t.confirmTokens}" (
      "hash" VARCHAR(64) PRIMARY KEY NOT NULL,
      "actor_ref" VARCHAR(255) NOT NULL,
      "tool" VARCHAR(255) NOT NULL,
      "expires_at" BIGINT NOT NULL,
      "created_at" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "${t.confirmTokens}_expires_idx" ON "${t.confirmTokens}" ("expires_at")`,
    streamFrameTableStatement(t.streamFrames),
  ];
}

/**
 * The `run_id` correlation columns run tracking added to three pre-existing tables. They are inline in
 * {@link createTableStatements}, which is all a fresh database needs — but `CREATE TABLE IF NOT EXISTS`
 * cannot add a column to a table that already exists, so a database provisioned before run tracking
 * shipped needs them ALTERed in. Deliberately not DB foreign keys (SQLite cannot add a column WITH a
 * FK constraint), so a row written before run tracking keeps a `null` run_id.
 */
const RUN_ID_COLUMNS: readonly string[] = [
  AGENT_TABLES.messages,
  AGENT_TABLES.toolCalls,
  AGENT_TABLES.tokenUsage,
];

/**
 * Columns added to a table that already exists in a deployed database, so `CREATE TABLE IF NOT
 * EXISTS` can never reach them. Repaired the same way the `run_id` columns are, and for the same
 * reason: the store writes them on every turn.
 */
const ADDITIVE_COLUMNS: readonly { table: string; column: string; type: string }[] = [
  { table: AGENT_TABLES.runs, column: 'parent_run_id', type: 'VARCHAR(255) NULL' },
  { table: AGENT_TABLES.messages, column: 'reasoning', type: 'TEXT NULL' },
  { table: AGENT_TABLES.messages, column: 'reasoning_ms', type: 'INTEGER NULL' },
  { table: AGENT_TABLES.messages, column: 'ui', type: 'TEXT NULL' },
  { table: AGENT_TABLES.messages, column: 'feedback', type: 'TEXT NULL' },
  { table: AGENT_TABLES.threads, column: 'model', type: 'VARCHAR(255) NULL' },
  { table: AGENT_TABLES.threads, column: 'queue_pause', type: 'TEXT NULL' },
  { table: AGENT_TABLES.threads, column: 'default_agent', type: 'VARCHAR(255) NULL' },
  { table: AGENT_TABLES.toolCalls, column: 'approver', type: 'VARCHAR(255) NULL' },
  { table: AGENT_TABLES.toolCalls, column: 'expires_at', type: 'BIGINT NULL' },
  { table: AGENT_TABLES.toolCalls, column: 'remember', type: 'INTEGER NULL' },
  { table: AGENT_TABLES.toolCalls, column: 'decided_via', type: 'VARCHAR(64) NULL' },
];

/**
 * Does `table` already have `column`? Probed with a zero-row `SELECT` rather than `information_schema`
 * (absent on SQLite) or a `PRAGMA` (SQLite-only): every dialect rejects an unknown column at parse
 * time, and `WHERE 1 = 0` means no rows are ever read.
 *
 * Deliberately NOT "attempt the ALTER and swallow the error": that pattern also swallows a permission
 * failure, a lock timeout, and a typo, leaving a schema that is still wrong and a migration that
 * reported success.
 */
async function hasColumn(db: LucidRawRunner, table: string, column: string): Promise<boolean> {
  try {
    await db.rawQuery(`SELECT "${column}" FROM "${table}" WHERE 1 = 0`);
    return true;
  } catch {
    return false;
  }
}

/** Rows of a raw query result, whatever the driver wraps them in (`{ rows }`, `[rows, fields]`, rows). */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return Array.isArray(result[0])
      ? (result[0] as Record<string, unknown>[])
      : (result as Record<string, unknown>[]);
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * The names of the indexes this database already has, or `null` when the dialect offers no catalog
 * this knows how to read (then every `CREATE INDEX IF NOT EXISTS` is simply issued).
 *
 * This is what keeps an up-to-date schema LOCK-FREE. Postgres takes the table lock for
 * `CREATE INDEX IF NOT EXISTS` before it looks whether the index is there, and that lock conflicts
 * with any open transaction that wrote to the table — so the "no-op" statement waits for it. A test
 * suite that wraps everything in one global transaction never commits, and the wait never ends. A
 * catalog read takes no such lock, so an index that exists is never touched.
 *
 * Postgres first: it is the one dialect where a failed statement poisons an ambient transaction, and
 * there the first probe succeeds.
 */
async function existingIndexes(db: LucidRawRunner): Promise<Set<string> | null> {
  const probes = [
    // Every schema on the search path, not only the first: an unqualified `CREATE INDEX … ON "t"`
    // finds `t` wherever the path does, so that is where its index has to be looked for.
    'SELECT indexname AS name FROM pg_indexes WHERE schemaname = ANY (current_schemas(false))',
    `SELECT name FROM sqlite_master WHERE type = 'index'`,
  ];
  for (const probe of probes) {
    try {
      const rows = rowsOf(await db.rawQuery(probe));
      return new Set(rows.map((row) => String(row.name)));
    } catch {
      // Not this dialect — try the next catalog.
    }
  }
  return null;
}

/** Does `table` exist? Same zero-row probe as {@link hasColumn}. */
async function hasTable(db: LucidRawRunner, table: string): Promise<boolean> {
  try {
    await db.rawQuery(`SELECT 1 FROM "${table}" WHERE 1 = 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one DDL statement, tolerating exactly one failure: another process got there first. Several
 * processes boot at once (web + worker, or a rolling deploy) and each provisions the schema; `IF NOT
 * EXISTS` is not atomic across sessions (two concurrent `CREATE TABLE IF NOT EXISTS` on Postgres can
 * both pass the check and one then fails on the catalog's unique index), and `ADD COLUMN` has no
 * guard at all. So a failure is re-checked against the database: if what the statement was meant to
 * create is there now, the race was lost and the job is done. Anything else — a permission error, a
 * lock timeout, a typo — still throws.
 */
async function issue(
  db: LucidRawRunner,
  statement: string,
  done: () => Promise<boolean>,
): Promise<void> {
  try {
    await db.rawQuery(statement);
  } catch (error) {
    if (!(await done())) throw error;
  }
}

/**
 * Idempotently provision the nine agent tables through Lucid's async raw runner (`CREATE TABLE IF
 * NOT EXISTS`), then additively repair a database that predates run tracking by ALTERing in the
 * `run_id` columns its three older tables are missing.
 *
 * Both halves matter, and for different populations. A fresh database gets everything from the
 * `CREATE TABLE` statements and never reaches a repair branch — which is what makes a non-empty
 * `repairs` result mean "this schema was out of date", not "boot happened". A database created before
 * run tracking shipped has all three tables already, so every `CREATE TABLE IF NOT EXISTS` no-ops and
 * only the repair adds the columns the store now writes on every turn.
 *
 * Against a schema that is already current it issues no DDL that takes a table lock: an existing
 * index is found in the catalog instead of re-issued (see {@link existingIndexes}). And it is safe
 * with several processes provisioning at once (see {@link issue}).
 *
 * Returns the `<table>.<column>` repairs actually issued, so a caller can report them. Works on every
 * Lucid dialect. For an AdonisJS app prefer the published migration
 * (`node ace configure @adonis-agora/agent`); this helper is what that migration calls, and what the
 * stores call themselves when `autoCreateTables` is on.
 */
export async function createAgentTables(db: LucidRawRunner): Promise<string[]> {
  const statements = createTableStatements();

  // Order matters, in three phases rather than one pass. Tables first, then the `run_id` repair, then
  // indexes — because `createTableStatements` includes `CREATE INDEX ... ON "agent_message" ("run_id")`,
  // and on a legacy database that index would be issued against a table whose `run_id` the repair has
  // not added yet. `CREATE INDEX IF NOT EXISTS` does not save it: the guard is on the INDEX existing,
  // not on the column, so the statement still fails to parse with "no such column: run_id".
  for (const stmt of statements) {
    if (!stmt.startsWith('CREATE TABLE')) continue;
    const table = /^CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(stmt)?.[1] as string;
    await issue(db, stmt, () => hasTable(db, table));
  }

  const repairs: string[] = [];
  const addColumn = async (table: string, column: string, type: string) => {
    if (await hasColumn(db, table, column)) return;
    await issue(db, `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`, () =>
      hasColumn(db, table, column),
    );
    repairs.push(`${table}.${column}`);
  };
  for (const table of RUN_ID_COLUMNS) {
    await addColumn(table, 'run_id', 'VARCHAR(255) NULL');
  }
  for (const { table, column, type } of ADDITIVE_COLUMNS) {
    await addColumn(table, column, type);
  }

  const indexes = await existingIndexes(db);
  for (const stmt of statements) {
    if (!stmt.startsWith('CREATE INDEX')) continue;
    const index = /^CREATE INDEX IF NOT EXISTS "([^"]+)"/.exec(stmt)?.[1] as string;
    if (indexes?.has(index)) continue;
    await issue(db, stmt, async () => (await existingIndexes(db))?.has(index) ?? false);
  }

  return repairs;
}

/**
 * `DROP TABLE IF EXISTS` for the nine agent tables, in reverse dependency order so a dialect that
 * enforces the `REFERENCES` clauses never refuses a drop for a child that still exists. The mirror of
 * {@link createAgentTables}, and what the published migration's `down()` calls.
 */
export function dropTableStatements(): string[] {
  const t = AGENT_TABLES;
  return [
    t.confirmTokens,
    t.streamFrames,
    t.queuedMessages,
    t.runs,
    t.tokenUsage,
    t.toolCalls,
    t.messages,
    t.modelPricing,
    t.threads,
  ].map((table) => `DROP TABLE IF EXISTS "${table}"`);
}

/** Drop the nine agent tables. Destructive and irreversible — this erases every thread and every ledger row. */
export async function dropAgentTables(db: LucidRawRunner): Promise<void> {
  for (const stmt of dropTableStatements()) {
    await db.rawQuery(stmt);
  }
}

/** The slice of a Lucid query client the schema runner reads: is it a transaction, and on what dialect. */
interface ClientShape {
  isTransaction?: boolean;
  dialect?: { name?: string };
}

/** The slice of Lucid's `Database` manager that hands out clients and tracks global transactions. */
interface ManagerShape {
  primaryConnectionName: string;
  connectionGlobalTransactions: Map<string, ClientShape>;
  connection(name?: string): LucidRawRunner;
}

function isManager(db: unknown): db is ManagerShape {
  const candidate = db as Partial<ManagerShape> | null;
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    candidate.connectionGlobalTransactions instanceof Map &&
    typeof candidate.connection === 'function' &&
    typeof candidate.primaryConnectionName === 'string'
  );
}

/**
 * The client schema DDL should run on: one of its OWN, outside a global transaction the caller has
 * open (`db.beginGlobalTransaction()` — what `testUtils.db().withGlobalTransaction()` does for a Japa
 * suite). Inside that transaction the DDL would be rolled back with the test while the process still
 * remembers the schema as provisioned, and on Postgres the column probes — which fail by design on a
 * missing column — would abort the whole transaction.
 *
 * Lucid's manager answers every `connection()` with the global transaction while one is registered,
 * so the registration is lifted for the one synchronous call that builds a plain client and put back
 * before anything else can run.
 *
 * SQLite is left where it is: it has one writer, so a second connection could only wait for the very
 * transaction it is trying to avoid (and with a pool of one there is no second connection at all).
 * Its DDL is transactional and a failed probe does not abort anything, so running inside is correct.
 *
 * Anything that is not the `Database` manager — a client from `db.connection(name)`, a fake — is
 * returned as is: a plain client is already outside, and a transaction client cannot be escaped.
 */
export function schemaRunner(db: LucidRawRunner): LucidRawRunner {
  if (!isManager(db)) return db;
  const name = db.primaryConnectionName;
  const transaction = db.connectionGlobalTransactions.get(name);
  if (transaction === undefined) return db;
  if (/sqlite|libsql/i.test(transaction.dialect?.name ?? '')) return db;
  db.connectionGlobalTransactions.delete(name);
  try {
    return db.connection(name);
  } finally {
    db.connectionGlobalTransactions.set(name, transaction);
  }
}

/**
 * Provisioning promise memoized per db client, so the three Lucid-backed stores (the agent store,
 * the pricing store, the governance read-model) that share these tables run {@link createAgentTables}
 * exactly once against a given connection instead of racing six `CREATE TABLE IF NOT EXISTS` each.
 * Correctness never depends on the memo — the DDL is idempotent — it only avoids redundant round
 * trips. A failed provisioning is evicted so the next call retries rather than caching the rejection.
 */
const provisioned = new WeakMap<object, Promise<void>>();

/**
 * Idempotently ensure the nine agent tables exist, memoized per db client. This is what the stores
 * run when `autoCreateTables` is on (the default): the agent provider calls each store's
 * `ensureSchema()` once as the app starts, and a store used without the provider (a script, a test
 * that builds one by hand) falls back to it on first use — whichever store touches the connection
 * first provisions the shared schema, so pricing seeds and governance reads work even before the
 * first agent run. The DDL runs on {@link schemaRunner}'s client, never inside a global transaction.
 */
export function ensureAgentTables(db: LucidRawRunner): Promise<void> {
  const key = db as unknown as object;
  let ready = provisioned.get(key);
  if (ready === undefined) {
    ready = createAgentTables(schemaRunner(db))
      .then(() => undefined)
      .catch((error) => {
        provisioned.delete(key);
        throw error;
      });
    provisioned.set(key, ready);
  }
  return ready;
}

/**
 * Idempotently create the Lucid token sink's frame table, under whatever name the sink was given.
 * What the sink runs for itself (`autoCreateTables`), so it stands up next to ANY store — the
 * in-memory one included — without provisioning the other seven tables. {@link createAgentTables}
 * creates the same table under its default name, so the published migration covers it too.
 */
export async function ensureStreamFrameTable(
  db: LucidRawRunner,
  table: string = AGENT_TABLES.streamFrames,
): Promise<void> {
  const runner = schemaRunner(db);
  if (await hasTable(runner, table)) return;
  await issue(runner, streamFrameTableStatement(table), () => hasTable(runner, table));
}
