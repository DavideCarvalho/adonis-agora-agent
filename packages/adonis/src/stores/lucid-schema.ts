import type { LucidDatabaseLike } from './lucid.js';

/**
 * The six agent table names. They match the cross-adapter snake_case contract the reference Drizzle
 * store uses, so a dashboard or migration can point at any adapter and see the same physical schema.
 */
export const AGENT_TABLES = {
  threads: 'agent_thread',
  messages: 'agent_message',
  toolCalls: 'agent_tool_call',
  tokenUsage: 'agent_token_usage',
  modelPricing: 'agent_model_pricing',
  runs: 'agent_run',
} as const;

/**
 * `CREATE TABLE IF NOT EXISTS` DDL for the six agent tables plus their indexes, one statement per
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
      "executed_at" BIGINT NULL
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
 * Does `table` already have `column`? Probed with a zero-row `SELECT` rather than `information_schema`
 * (absent on SQLite) or a `PRAGMA` (SQLite-only): every dialect rejects an unknown column at parse
 * time, and `WHERE 1 = 0` means no rows are ever read.
 *
 * Deliberately NOT "attempt the ALTER and swallow the error": that pattern also swallows a permission
 * failure, a lock timeout, and a typo, leaving a schema that is still wrong and a migration that
 * reported success.
 */
async function hasColumn(db: LucidDatabaseLike, table: string, column: string): Promise<boolean> {
  try {
    await db.rawQuery(`SELECT "${column}" FROM "${table}" WHERE 1 = 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently provision the six agent tables through Lucid's async raw runner (`CREATE TABLE IF
 * NOT EXISTS`), then additively repair a database that predates run tracking by ALTERing in the
 * `run_id` columns its three older tables are missing.
 *
 * Both halves matter, and for different populations. A fresh database gets everything from the
 * `CREATE TABLE` statements and never reaches a repair branch — which is what makes a non-empty
 * `repairs` result mean "this schema was out of date", not "boot happened". A database created before
 * run tracking shipped has all three tables already, so every `CREATE TABLE IF NOT EXISTS` no-ops and
 * only the repair adds the columns the store now writes on every turn.
 *
 * Returns the `<table>.<column>` repairs actually issued, so a caller can report them. Works on every
 * Lucid dialect. For an AdonisJS app prefer the published migration
 * (`node ace configure @adonis-agora/agent`); this helper is what that migration calls, and what the
 * stores call themselves when `autoCreateTables` is on.
 */
export async function createAgentTables(db: LucidDatabaseLike): Promise<string[]> {
  const statements = createTableStatements();

  // Order matters, in three phases rather than one pass. Tables first, then the `run_id` repair, then
  // indexes — because `createTableStatements` includes `CREATE INDEX ... ON "agent_message" ("run_id")`,
  // and on a legacy database that index would be issued against a table whose `run_id` the repair has
  // not added yet. `CREATE INDEX IF NOT EXISTS` does not save it: the guard is on the INDEX existing,
  // not on the column, so the statement still fails to parse with "no such column: run_id".
  for (const stmt of statements) {
    if (stmt.startsWith('CREATE TABLE')) await db.rawQuery(stmt);
  }

  const repairs: string[] = [];
  for (const table of RUN_ID_COLUMNS) {
    if (await hasColumn(db, table, 'run_id')) continue;
    await db.rawQuery(`ALTER TABLE "${table}" ADD COLUMN "run_id" VARCHAR(255) NULL`);
    repairs.push(`${table}.run_id`);
  }

  for (const stmt of statements) {
    if (stmt.startsWith('CREATE INDEX')) await db.rawQuery(stmt);
  }

  return repairs;
}

/**
 * `DROP TABLE IF EXISTS` for the six agent tables, in reverse dependency order so a dialect that
 * enforces the `REFERENCES` clauses never refuses a drop for a child that still exists. The mirror of
 * {@link createAgentTables}, and what the published migration's `down()` calls.
 */
export function dropTableStatements(): string[] {
  const t = AGENT_TABLES;
  return [t.runs, t.tokenUsage, t.toolCalls, t.messages, t.modelPricing, t.threads].map(
    (table) => `DROP TABLE IF EXISTS "${table}"`,
  );
}

/** Drop the six agent tables. Destructive and irreversible — this erases every thread and every ledger row. */
export async function dropAgentTables(db: LucidDatabaseLike): Promise<void> {
  for (const stmt of dropTableStatements()) {
    await db.rawQuery(stmt);
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
 * Idempotently ensure the six agent tables exist, memoized per db client. This is what the stores
 * call on first use when `autoCreateTables` is on (the default) — whichever store touches the
 * connection first provisions the shared schema, so pricing seeds and governance reads work even
 * before the first agent run.
 */
export function ensureAgentTables(db: LucidDatabaseLike): Promise<void> {
  const key = db as unknown as object;
  let ready = provisioned.get(key);
  if (ready === undefined) {
    ready = createAgentTables(db)
      .then(() => undefined)
      .catch((error) => {
        provisioned.delete(key);
        throw error;
      });
    provisioned.set(key, ready);
  }
  return ready;
}
