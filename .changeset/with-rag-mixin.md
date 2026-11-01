---
"@adonis-agora/agent": minor
---

Add `withRag`, a Lucid model mixin that declares RAG on the model: `doc.ragIndex()`, `doc.ragRemove()` and `Model.ragSearch(query, { scope })`. A declared `scope` is mandatory on search and a `filter` cannot override it. Deleting through the model removes the chunks; saving never indexes. `PgVectorStore` gains `vectorType: 'halfvec'`.
