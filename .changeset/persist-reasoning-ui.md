---
'@adonis-agora/agent': minor
---

Assistant messages now keep what their step streamed: `reasoning` (the model's thinking), `reasoningMs` (how long it thought) and `ui` (components the model turn pushed), on `StoredMessage`, `AppendMessageInput` and `ModelTurnResult`. The loop reads them off the frames inside the model call's own checkpoint (`observeTurnFrames` / `withTurnFrames`), so a durable replay persists the same values, and `step-finish` carries `reasoningMs` live — the same fields `@dudousxd/nestjs-agent` persists, so the shared React client replays a reloaded thread the way it streamed.

The Lucid store adds three nullable `agent_message` columns (`reasoning`, `reasoning_ms`, `ui`), ALTERed in by `createAgentTables` on first use; with `autoCreateTables: false`, add a migration that calls `createAgentTables` again after upgrading. Forks copy them.
