---
"@adonis-agora/agent": patch
---

Fix `tokenSinks.lucid()` failing an append with a duplicate-key (Postgres) or deadlock (MySQL) error when several writers stream into one run at once. Each append still takes `MAX(seq) + 1` in a single statement, but a writer that collides no longer re-enters the same race up to eight times: it appends inside a transaction holding a per-run lock (a Postgres advisory lock, a MySQL named lock), and the single-statement path yields to that lock, so contending writers take turns and every append lands. An uncontended append is still one statement.
