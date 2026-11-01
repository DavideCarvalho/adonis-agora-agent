---
'@adonis-agora/agent': patch
---

`PgVectorStore.replaceDocument` takes an advisory lock per document, so replacing one document concurrently no longer leaves a mix of versions or deadlocks.
