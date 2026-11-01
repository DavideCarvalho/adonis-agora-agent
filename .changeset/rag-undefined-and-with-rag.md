---
'@adonis-agora/agent': minor
---

An `undefined` filter value now matches nothing in every store, and `removeWhere` refuses it with `UnsafeRemovalError`. On pgvector it used to match every row, and `removeWhere({ tenantId: undefined })` deleted the table.

`withRag`: models sharing a store no longer see each other, through a `ragEntity` metadata key. **Chunks indexed before this have no such key and stop being found until `ragIndex` runs again.** A row deleted inside a transaction loses its chunks after the commit, not before it.

`PgVectorStore.replaceDocument` swaps a document's chunks in one transaction, and `withRag` uses it when the store has it.
