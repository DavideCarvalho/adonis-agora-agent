---
"@adonis-agora/agent": minor
---

Text channels: `channels.handle(adapter, { onTurnEnded })` is called always, once this process is done with a message (or with a run resumed after its question), whatever it came to — `outcome` is `replied` (possibly having sent nothing), `failed` (with `error` when the job failed after its retries), `timeout`, `blocked`, `parked`, `stopped` (unknown sender or `beforeTurn`, no turn), `handled` (an answer, a press, a decision) or `interrupted` (a durable engine took the job away). It gets `channel`, `conversation`, `actor`, `message` (`null` for a resumed run), `runId` and `threadId`. For stopping what the app started for the message — a "typing…" presence begun in the adapter's `acknowledge`, which before had no hook when a turn ended without an outbound message or a durable step moved to another process. Per attempt under a durable engine; what it throws is logged and ignored. New exported types: `ChannelTurnEnded`, `ChannelTurnOutcome`.
