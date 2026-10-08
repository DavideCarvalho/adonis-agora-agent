---
"@adonis-agora/agent": patch
---

`useAgentChat` stops reading action proposals from a server that does not serve them. The first `404`, `405` or `501` from `GET threads/:id/action-proposals` (other than the library's own "unknown thread") marks proposals unsupported for that client: no more polling or refetching, and `chat.proposals.unsupported` is `true`. Transient failures keep polling, with a wait that doubles per failure up to 30 s.
