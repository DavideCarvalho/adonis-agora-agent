import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TABLES, createTableStatements } from '../src/index.js';
import { renderStub as renderThroughEngine } from './helpers/render-stub.mjs';

/**
 * The published migration stub used to be a hand-copied snapshot of the library's DDL, and a snapshot
 * of a schema the library also provisions itself is a copy that can only rot. It had already gone
 * wrong in two directions at once.
 *
 * It reproduced `this.schema.createTable('agent_thread', ...)` with no existence guard, so it THREW on
 * any database where the tables already existed — which is the normal case, not the exotic one:
 * `autoCreateTables` defaults to `true`, and the first use of any of the three stores that share these
 * tables provisions them. A consumer hit exactly that wall upgrading a real app. And it took TWO files
 * to express one schema (`create_agent_tables` plus an additive `create_agent_run_tracking`), so the
 * `run_id` columns lived in a different file from the tables they belong to.
 *
 * So the stub no longer holds DDL: it calls `createAgentTables` / `dropAgentTables`. Drift becomes
 * structurally impossible rather than diff-tested, and this spec guards the property that MAKES it
 * impossible — that the stub delegates and does not re-inline. That the stub actually RUNS, against
 * both an empty database and one the library already provisioned, is a separate and now more important
 * question: see `migration-stub-runs.spec.ts`.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, '..', 'stubs', 'database', 'migrations');

/**
 * The migration a consumer actually receives, rendered by the REAL engine rather than by a regex over
 * the `{{{ }}}` header. These assertions are about the generated file, so they must run against what
 * the generator generates — a harness that renders differently is not testing the generator, which is
 * how four unrenderable stubs once passed every gate here.
 */
async function renderStub(name: string): Promise<string> {
  const { contents } = await renderThroughEngine(`database/migrations/${name}.stub`);
  return contents as string;
}

/**
 * The stub's executable statements, with comments removed. The negative assertions below are about
 * what the migration DOES, and the stub's own docblock necessarily quotes the DDL it no longer
 * contains in order to explain why — so matching raw text would fail on the explanation rather than
 * on a regression.
 */
async function renderStubCode(name: string): Promise<string> {
  return (await renderStub(name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the agent migration stub delegates instead of copying the DDL', async () => {
  const stub = await renderStub('create_agent_tables');
  const code = await renderStubCode('create_agent_tables');

  it('declares no tables and no columns of its own', () => {
    // A `createTable` / `table.string(...)` in here would mean a THIRD copy of the schema is back:
    // lucid-schema.ts, the stub, and every consumer's frozen migration file.
    expect(code).not.toMatch(/\bcreateTable\(/);
    expect(code).not.toMatch(/\balterTable\(/);
    expect(code).not.toMatch(/\btable\.(string|integer|bigInteger|text|double|increments)\(/);
  });

  it('names no agent table literally', () => {
    // The table names are the library's too. A stub that spelled one out would be a second place to
    // change when a table is renamed.
    for (const table of Object.values(AGENT_TABLES)) {
      expect(code, `the stub should not hard-code the table name "${table}"`).not.toContain(table);
    }
  });

  it('calls createAgentTables in up() and dropAgentTables in down()', () => {
    expect(stub).toMatch(/async up\(\)\s*\{\s*await createAgentTables\(/);
    expect(stub).toMatch(/async down\(\)\s*\{\s*await dropAgentTables\(/);
  });

  it('takes the Database manager from services/db, scoped to the migration connection', () => {
    // `createAgentTables` needs a client that checks out its OWN connection. A migration's `this.db`
    // is the migrator's (transaction) client, so the manager is imported and `this.db` is kept only
    // for the connection NAME — which is what makes `migration:run --connection=x` provision x.
    expect(stub).toMatch(/^import db from '@adonisjs\/lucid\/services\/db'$/m);
    expect(stub).toMatch(/db\.connection\(this\.db\.connectionName\)/);
    expect(stub).not.toMatch(/createAgentTables\(this\.db\)/);
  });

  it('opts out of the migrator transaction', () => {
    // Required, not stylistic: on a `pool: { max: 1 }` connection the migrator's transaction would
    // hold the only connection while the manager's client waited for a free one, and the migration
    // would die on the acquire timeout. `migration-stub-runs.spec.ts` runs exactly that pool.
    expect(stub).toMatch(/static disableTransactions = true/);
  });
});

describe('the pgvector migration stub delegates too', async () => {
  const stub = await renderStub('create_agent_rag_chunks');
  const code = await renderStubCode('create_agent_rag_chunks');

  it('provisions through PgVectorStore rather than its own createTable', () => {
    // Same bug class as the agent tables stub: an unguarded `createTable` throws against a database
    // where `ensureSchema: true` already ran. `PgVectorStore` owns the column names and the index
    // operator class its own queries depend on.
    expect(code).not.toMatch(/this\.schema\.createTable\(/);
    expect(stub).toMatch(/new PgVectorStore\(/);
    expect(stub).toMatch(/ensureSchema\(\)/);
    expect(stub).toMatch(/static disableTransactions = true/);
  });

  it('scopes the DDL to the migration connection', () => {
    // Same reason as the agent tables stub: without this, `migration:run --connection=x` provisions
    // the DEFAULT connection instead of x. Passing a per-connection client is only possible because
    // the store asks for `LucidRawRunner`; when it asked for the wider `LucidDatabaseLike`, this line
    // did not type-check and the obvious "fix" was to drop back to the bare manager and lose `--connection`.
    expect(stub).toMatch(/db\.connection\(this\.db\.connectionName\)/);
  });
});

describe('one stub, one schema', () => {
  it('publishes no separate run-tracking migration', () => {
    // `create_agent_run_tracking.stub` existed only to ALTER in the `run_id` columns the base stub was
    // written before. `createAgentTables` now creates them inline on a fresh database AND repairs them
    // on an old one, so a second file would be a second copy of the same facts.
    const stubs = readdirSync(migrationsDir).filter((entry) => entry.endsWith('.stub'));
    expect(stubs.sort()).toEqual(['create_agent_rag_chunks.stub', 'create_agent_tables.stub']);
  });

  it('carries the run_id columns in the table DDL itself', () => {
    // The property that lets the two stubs collapse into one: a fresh database needs no ALTER at all.
    const ddl = createTableStatements().join('\n');
    for (const table of [AGENT_TABLES.messages, AGENT_TABLES.toolCalls, AGENT_TABLES.tokenUsage]) {
      const createStatement = createTableStatements().find((statement) =>
        statement.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`),
      );
      expect(createStatement, `no CREATE TABLE for ${table}`).toBeDefined();
      expect(createStatement).toContain('"run_id"');
    }
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${AGENT_TABLES.runs}"`);
  });

  it('guards every CREATE with IF NOT EXISTS', () => {
    // The whole reason the old stub broke. One unguarded CREATE and the migration throws against a
    // database the library auto-created — which is the default configuration.
    for (const statement of createTableStatements()) {
      expect(statement, `unguarded DDL: ${statement.slice(0, 60)}`).toMatch(
        /^CREATE (TABLE|INDEX) IF NOT EXISTS/,
      );
    }
  });
});
