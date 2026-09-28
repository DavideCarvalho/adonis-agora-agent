---
'@adonis-agora/agent': minor
---

pgvector: batched upserts, full-text hybrid search, mixed dimensions

`PgVectorStore` now upserts in multi-row `INSERT … ON CONFLICT` statements (`upsertBatchSize`, default 100; duplicate ids in one call keep the last), and gains opt-in `nullableEmbeddings` (`embedding: []` → `NULL`), mixed-dimension tables (`dimension: [768, 1536]`, one partial HNSW index per width, searches compare like with like), and pgvector ≥ 0.8 `iterativeScan` / `efSearch` (`SET LOCAL` inside a Lucid transaction, skipped on older pgvector). New `PgLexicalVectorStore` (Postgres full-text `searchText`), `LexicalVectorStore` / `isLexicalVectorStore` and `LexicalRetriever`; `retrievers.pgvector({ fullText: {} })` returns a `HybridRetriever` of both legs. `HybridRetriever` gains `retrieveWithUsage`, so embedding spend from its legs still reaches the ledger. Everything is off by default.
