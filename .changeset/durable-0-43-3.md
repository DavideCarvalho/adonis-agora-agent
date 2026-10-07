---
'@adonis-agora/agent': minor
---

Requires `@adonis-agora/durable` 0.43.3 or later (peer `>=0.43.3 <1.0.0`). Earlier versions could run one durable run twice at once in a process — a resume landing while the run was still executing — so a tool step could run twice after a very fast approval. 0.43.3 serializes a run's executions per process; the OpenCode durable engine relies on it instead of guarding its steps itself.
