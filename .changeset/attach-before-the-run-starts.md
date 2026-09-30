---
'@adonis-agora/agent': patch
---

A run is attachable from the moment it holds its thread, not from the moment a worker starts it.

A send, and a queue drain handing the thread to the next message, admit the run to its thread and only then start it. Under the durable runner the body runs in a worker, so for as long as the worker takes to pick it up the run had no row and no stream — and `GET <path>/chat/:runId/stream` and `POST <path>/chat/:runId/cancel` answered `404`. That is exactly when a client attaches: the settling turn's `queue` frame has just told it the queued message started. The React client reads that `404` as "already finished" and re-reads the thread, so the queued message vanished from the screen and its answer never streamed until a reload.

Now a run with no row yet is owned by the thread it holds (`AgentStore.threadHeldByRun`, optional; the Lucid and in-memory stores implement it), and `hasStream` counts a run that holds its thread and that the runner reports alive as about to stream, so the attach waits for the first frame instead of being turned away. A claim left behind by a process that died is still nothing to resume.
