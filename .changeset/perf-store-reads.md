---
'@adonis-agora/agent': patch
---

perf(lucid): cheaper thread, approval and dashboard reads

- Opening a thread (`getThread`) reads only the tool calls that carry an approval, instead of every
  call on the thread with its input and output payloads.
- `rememberedApprovals` is one joined statement instead of reading every message id of the thread
  and sending them back as an `IN (…)` list.
- `truncateFrom` (regenerate / edit) deletes the dropped tail in batches instead of two statements
  per message.
- `updateToolCall` reads only the row's key before updating it.
- The governance read-model's per-tool stats, run trace and thread drill-down select only the
  columns they report.
