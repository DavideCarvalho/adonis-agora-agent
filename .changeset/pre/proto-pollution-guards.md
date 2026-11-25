---
"@adonis-agora/agent": patch
---

Security: close prototype-pollution paths (CWE-1321). An AG-UI `ACTIVITY_DELTA` patch whose path names `__proto__`, `constructor` or `prototype` no longer applies, and patches walk only an object's own members, so `add`/`remove` can no longer write to or delete from `Object.prototype`. A `"__proto__"` key in streamed tool-call arguments (`parsePartialJson`) or in a RAG metadata patch (`applyMetadataPatch`) is now a plain own key, as `JSON.parse` makes it, instead of replacing the object's prototype.
