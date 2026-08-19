---
'@adonis-agora/agent': minor
---

Fix the published migration, which threw against any database the library had already provisioned.

`node ace configure @adonis-agora/agent` published `create_agent_tables` as raw DDL —
`this.schema.createTable('agent_thread', ...)` with no existence guard. But `autoCreateTables`
defaults to `true`, and the first use of any of the three stores that share those tables (the agent
store, the pricing store, the governance read-model) provisions them. So in any app that had run the
agent even once before migrating, `node ace migration:run` died with `table "agent_thread" already
exists`. Reported from a real consumer upgrade.

The stub now delegates to `createAgentTables` / `dropAgentTables` instead of reproducing the DDL, with
`disableTransactions = true` (the helper takes its own pooled connection, which would otherwise
deadlock against `pool: { max: 1 }`). Drift stops being something to test for and becomes impossible:
the migration and the auto-created schema are the same code.

The separate `create_agent_run_tracking` stub is gone — one schema, one migration. Its `run_id` columns
were already inline in the table DDL for a fresh database, and `createAgentTables` now also ALTERs them
into a database provisioned before run tracking shipped, so collapsing the two loses no upgrade path.
That repair also fixes `autoCreateTables` on such a database, where the missing columns were previously
never added at all.

`create_agent_rag_chunks` had the same unguarded `createTable`; it now provisions through
`PgVectorStore.ensureSchema()`.

`createAgentTables` now resolves to the list of repairs it applied (it returned nothing before). Callers that only `await` it are unaffected.

**No action needed.** Migrations you have already run stay applied; this only changes what `configure`
generates from here on. If your `migration:run` was failing, re-run `node ace configure` and delete the
old `create_agent_tables` / `create_agent_run_tracking` files it had published.
