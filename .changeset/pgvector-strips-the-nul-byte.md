---
'@adonis-agora/agent': patch
---

`PgVectorStore` strips the NUL byte (0x00) before writing to Postgres

Postgres rejects the NUL byte in `text`/`jsonb` values outright (`invalid byte sequence for encoding "UTF8": 0x00`), but text extracted from PDFs sometimes carries one and upstream sources like Qdrant accept it fine — so a chunk that ingested cleanly elsewhere could fail `upsert` here with no way to write it. `upsert` (id, text, source, metadata — including nested metadata values, array items, and object keys) and `updateMetadata` (the patch, values and keys) now run every string through a new exported `stripNulBytes` helper first, so a stray NUL byte is dropped and the rest of the text is written unchanged.
