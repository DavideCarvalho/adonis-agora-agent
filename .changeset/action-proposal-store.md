---
'@adonis-agora/agent': minor
---

Add the optional ActionProposalStore capability with scoped replay-safe snapshots, atomic decisions and queued execution work, and fenced recoverable leases in memory and Lucid. This is the persistence foundation; independent conversation execution is not enabled yet.

Existing hosts using `autoCreateTables: false` must add a new migration that invokes `createAgentTables` on the chosen connection before using proposals. An already-recorded older migration will not run again.
