---
'@adonis-agora/agent': patch
---

`QdrantStore.replaceDocument` calls in separate processes now converge on one version instead of leaving a mix, on Qdrant 1.16 or newer: chunks carry a `generation`, and no index needs migrating. A search can still briefly see both versions. In `MemoryVectorStore`, `remove` and `removeWhere` take their turn with `replaceDocument`.
