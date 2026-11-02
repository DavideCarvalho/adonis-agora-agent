---
'@adonis-agora/agent': patch
---

`QdrantStore.removeWhere` now waits for the changes already called in the same store instance, as `MemoryVectorStore.removeWhere` does, so it no longer misses chunks a replace is still writing. `QdrantStore.updateMetadata` takes its turn with `replaceDocument` and `remove` on the document, so it can't write metadata from the old version over the new one. Across processes neither waits.
