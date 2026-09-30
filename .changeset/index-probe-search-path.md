---
'@adonis-agora/agent': patch
---

The index probe that keeps provisioning lock-free on Postgres now looks in every schema on the `search_path` (`current_schemas(false)`), not only the first. With the agent tables in a later schema (`search_path = app, public`, tables in `public`), the probe found no indexes and re-issued every `CREATE INDEX IF NOT EXISTS` — the statement that waits for an open transaction.
