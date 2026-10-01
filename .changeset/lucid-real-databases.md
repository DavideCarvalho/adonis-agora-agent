---
'@adonis-agora/agent': minor
---

The Lucid stores work on **MySQL**, and every Lucid store suite now runs on SQLite, Postgres 16
and MySQL 8.4 (`pnpm test:db`, testcontainers; required in CI). Fixed along the way:

- **MySQL could not create the tables.** The schema DDL quoted identifiers `"like this"`, which MySQL
  reads as string literals, and used `CREATE INDEX IF NOT EXISTS`, which MySQL lacks, so
  `createAgentTables` — the published migration and `autoCreateTables` — failed on the first
  statement. The same quoting broke the Lucid token sink's insert and purge. The DDL is now rendered
  per dialect (`forDialect`): backticks, `LONGTEXT` instead of 64 KB `TEXT`, indexes looked up in
  `information_schema` first, and `ENGINE=InnoDB` with `utf8mb4_bin` so `actor_ref = 'alice'` does not
  match `'ALICE'`.
- **Foreign keys are table constraints.** MySQL ignores a column-level `REFERENCES`, so deleting a
  thread never cascaded there. New tables get table-level `FOREIGN KEY … ON DELETE CASCADE` on every
  dialect (same behaviour on Postgres/SQLite).
- **Message order.** A transcript was ordered by `created_at` alone, so two messages written in the
  same millisecond (a turn's assistant and tool messages) came back in whatever order the database
  chose. `agent_message` gains `seq BIGINT NOT NULL DEFAULT 0`, assigned on append and copied in order
  on fork; rows from before hold 0 and sort first. `autoCreateTables` adds it; with
  `autoCreateTables: false`, add a migration whose `up()` calls `createAgentTables` again.
- **`claimActiveStream`** admits the holder re-claiming its own thread on a MySQL connection without
  `FOUND_ROWS`, which reports changed rather than matched rows.
- **The Lucid token sink** retries a writer InnoDB rolled back as a deadlock victim — how MySQL
  settles two replicas appending to one run at once — like a duplicate key.
