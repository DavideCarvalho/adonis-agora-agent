---
'@adonis-agora/agent': patch
---

Fix the published migration, which did not type-check in a consumer app.

`create_agent_tables` passes `db.connection(this.db.connectionName)` — a `QueryClientContract` — into
`createAgentTables`, whose parameter was typed `LucidDatabaseLike`. That interface declared
`rawQuery(sql, bindings?: unknown[])`, and `unknown[]` is assignable in **neither** direction to
Lucid's `RawQueryBindings` (`StrictValues[] | { [key: string]: StrictValues }`): not inward, because
`unknown` is not a `StrictValues`; not outward, because the named-bindings object is not an array. A
method parameter is checked bivariantly, so failing both directions failed the check outright. Only
the `Database` manager satisfied the interface, since its own `bindings` is `any`.

So `node ace configure @adonis-agora/agent` produced a migration that threw `TS2345` under an app's
`tsc`. `create_agent_rag_chunks` broke identically.

The bindings type is now `readonly unknown[] | Record<string, unknown>` — a supertype of
`RawQueryBindings`, so every real Lucid client matches while the interface stays structural and
`@adonisjs/lucid` stays an optional peer. The schema helpers, `PgVectorStore`, and the SQL data
satellite now take a new, narrower `LucidRawRunner` (just `rawQuery`), which is all any of them
actually use — asking for less is what lets a per-connection client qualify at all.

This keeps `migration:run --connection=x` working. The workaround of passing the bare `Database`
manager compiles but always provisions the default connection.

New exported types: `LucidRawRunner`, `LucidRawBindings`. `LucidDatabaseLike` is unchanged in
capability (it now extends `LucidRawRunner`) and still exported.
