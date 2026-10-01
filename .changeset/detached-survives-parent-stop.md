---
'@adonis-agora/agent': patch
---

A detached delegation now survives a Stop on the turn that started it (durable runner). It used to
be a `ctx.startChild` child, and the engine cascades a parent's cancel to every run it spawned — so
stopping the visible turn after it had handed work off also cancelled the background run, and the
delegating card could stay "started". It is now started as a run of its own from a journaled
`detach:<toolCallId>` step (behind `ctx.patched('agent:detached-unlinked')`, deterministic id
`<runId>.detached.<toolCallId>`, the parent's namespace); `parentRunId` stays on its input. A run
that journaled its `spawn:` on 0.58.0 replays it unchanged, and when such a run's Stop still
cascades, `DurableAgentRunner.cancel` settles the cascaded child's card `cancelled` (once).
`DurableAgentContext` gained an optional `engine` (the provider sets it; otherwise the engine passed
to `registerAgentWorkflow` is used). Parity with `@dudousxd/nestjs-agent` 1.19.3.
