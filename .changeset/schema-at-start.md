---
'@adonis-agora/agent': minor
---

The agent tables are provisioned as the app starts, on a connection of their own — an app never needs a migration for them, and a test suite's global transaction no longer hangs on them.

`autoCreateTables` (default `true`) used to run on the first agent call, inside whatever that caller had open. On Postgres `CREATE INDEX IF NOT EXISTS` takes the table lock before it checks for the index, and that lock waits for any open transaction that wrote to the table — so under a Japa global transaction (`testUtils.db().withGlobalTransaction()`) the "no-op" provisioning waited forever and the run hung. The way out was `autoCreateTables: false` plus a hand-written migration per upgrade.

- **Runs at start.** The provider's new `start` hook calls `ensureSchema()` on the store, the pricing store and the governance read-model — before the HTTP server takes a request and before a test runner opens a transaction. Not for ace commands (`migration:run` must not find the tables already made; `list:routes` must not need a database): there, and for a store built by hand, first use still provisions. A failure at start is a warning; first use retries.
- **Lock-free when current.** `createAgentTables` finds existing indexes in the catalog (`pg_indexes` / `sqlite_master`) instead of re-issuing them, so a schema that is up to date issues no DDL that locks a table.
- **Outside a global transaction.** `ensureAgentTables` runs its DDL on a plain client (`schemaRunner(db)`, exported), not on the transaction `db.beginGlobalTransaction()` registered — the schema is not rolled back with the test, and a failed column probe cannot abort it. SQLite stays on the transaction's connection (one writer).
- **Safe with several processes starting at once.** A `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` that loses the race to another process is re-checked against the database and counted as done; any other failure still throws.
- **`ensureSchema()`** on `LucidAgentStore`, `LucidPricingStore` and `LucidGovernanceQueries`. A custom store that exposes it is provisioned at start too.

`autoCreateTables: false` with the published migration (`createAgentTables` / `dropAgentTables`) is unchanged, for teams that version the schema.

**Upgrading.** If you turned `autoCreateTables` off only to avoid the hang, turn it back on and stop writing a migration per release. If your app still has a `create_agent_tables` migration with its own `this.schema.createTable(...)` (published before it delegated to the library), guard it or replace its body with `createAgentTables(...)`: a fresh test database is now provisioned before `testUtils.db().migrate()` runs, and an unguarded `createTable` throws on it.
