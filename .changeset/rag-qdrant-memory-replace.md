---
'@adonis-agora/agent': patch
---

`QdrantStore` and `MemoryVectorStore` gain `replaceDocument`. Concurrent calls for one document take turns within a process. Qdrant has no lock, so separate processes can still overlap. On Qdrant the new chunks are written before the old ones are dropped, so a crash no longer loses the document.
