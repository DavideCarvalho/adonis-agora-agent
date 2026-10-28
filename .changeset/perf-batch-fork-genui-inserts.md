---
'@adonis-agora/agent': patch
---

perf(lucid): `forkThread` and `recordGenuiCalls` now write their rows with multi-row inserts (Lucid's `multiInsert`) instead of one INSERT per row — forking a 200-message thread goes from 201 statements to 6, recording 100 genui calls from 100 to 4. Rows, order and transaction are unchanged; consecutive rows are batched only when they set the same columns, and a client without `multiInsert` (a custom structural `LucidInsertBuilderLike`) keeps the per-row path. `LucidInsertBuilderLike` gains an optional `multiInsert` member.
