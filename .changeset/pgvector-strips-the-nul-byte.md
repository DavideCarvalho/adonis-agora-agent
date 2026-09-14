---
'@adonis-agora/agent': patch
---

`PgVectorStore` strips the NUL byte (0x00) before it reaches Postgres, on writes and on reads

Postgres rejects the NUL byte in `text`/`jsonb` values outright (`invalid byte sequence for encoding "UTF8": 0x00`), but text extracted from PDFs sometimes carries one and upstream sources like Qdrant accept it fine — so a chunk that ingested cleanly elsewhere could fail `upsert` here with no way to write it. `upsert` (id, text, source, metadata — including nested metadata values, array items, and object keys) and `updateMetadata` (the patch, values and keys, plus the `documentId` lookup) now run every string through a new exported `stripNulBytes` helper first, so a stray NUL byte is dropped and the rest of the text is written unchanged. The same stripping now also applies on read: `remove`'s `documentId`, and the metadata filter (`search`, `listDocuments`, `listDocumentIds`, `removeWhere`) — keeping every lookup consistent with the already-stripped stored data.

`stripNulBytes` also fixes two edge cases in how it walks a value: only plain objects are recursed into (checked via `Object.getPrototypeOf`), so a `Date`, class instance, `Buffer`, etc. inside metadata passes through unchanged instead of being flattened into `{}`; and the result is built with `Object.fromEntries` rather than assignment onto a fresh `{}`, so a metadata key literally named `__proto__` round-trips as a real own property instead of silently hitting the inherited prototype accessor and being dropped.
