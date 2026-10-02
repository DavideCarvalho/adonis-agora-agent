---
'@adonis-agora/agent': minor
---

Add indexed worker-only proposal discovery to Lucid: claim queued or expired-lease work across
scopes and expire due pending cards in bounded batches. Every proposal mutation keeps discovery
metadata in the same fenced write. Mirror the shared worker-store conformance contract and add
bounded, version-fenced backfill for existing proposals after additive schema migration.

Stop old writers before applying the forward migration and repeating backfill batches, then start
the new workers. This capability does not itself enable the independent conversation runtime.
