---
'@adonis-agora/agent': minor
---

A tool is handed an idempotency key.

`ctx.idempotencyKey` is `<runId>:<toolCallId>` — the same for every execution of one tool call, and
for no other — and `ctx.toolCallId` names the call. A tool's side effect and the checkpoint that
records it are two writes: under the durable runner a worker that dies between them leaves a call
the journal does not know ran, and recovery runs it again (an in-step transient retry re-invokes it
too). The library cannot make an application's write atomic with its journal, so it hands the tool
the value that makes the second attempt recognisable — pass it on as the downstream idempotency key
(a provider's `Idempotency-Key`, a unique column on the inserted row, the `id` of a workflow the
tool starts). Both are absent where a tool runs outside a turn (the MCP server, a direct
`registry.invoke`). Same wire as `@dudousxd/nestjs-agent-core`.
