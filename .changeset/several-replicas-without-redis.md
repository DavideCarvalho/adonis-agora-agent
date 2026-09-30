---
'@adonis-agora/agent': minor
---

Several replicas without Redis: `tokenSinks.lucid()` keeps a run's stream in the app's SQL database, and `ask` / `intake` are now reachable from `config/agent.ts` (#234).

A run parked on a person was already replica-safe under the durable runner (`durable: true` parks on a journaled signal, not a promise in one process). What a Redis-less deployment was missing is a stream every replica can read, and a way to turn the question surfaces on through the provider.

```ts
export default defineConfig({
  // …
  durable: true,
  sink: tokenSinks.lucid(),
  defaultAgent: { ask: true },
})
```

- `LucidTokenStreamSink` / `tokenSinks.lucid({ connection, tableName, pollIntervalMs, idlePollIntervalMs, flushMs, ttlSeconds, autoPurge, autoCreateTables, db })` — frames are rows of `agent_stream_frame` (`run_id`, `seq`, `frame`, `created_at`), numbered per run with no gaps; subscribers poll (250 ms, 1 s once a run goes quiet) and replay from the first row, so a subscriber on another replica, a late one and one arriving after the end all see the same stream. Consecutive `text` frames written within `flushMs` (50 ms) are stored as one frame, so a streamed answer is a handful of inserts rather than one per token; SSE event ids are counted from the stored frames and an `after` cursor resumes exactly on any replica. Rows lapse `ttlSeconds` (1 h) after a run's last write: `purgeExpired()` deletes them, and a replica calls it on its own after a run ends (`autoPurge`). Slower to deliver than Redis and it writes to your database on every answer — keep `tokenSinks.redis()` when Redis is there.
- `agent_stream_frame` is one of the nine tables of `createAgentTables()` / `AGENT_TABLES.streamFrames` (dropped by `dropAgentTables()`); the sink also creates it for itself at startup. `streamFrameTableStatement()` and `ensureStreamFrameTable()` are exported. With `autoCreateTables: false`, add a migration that calls `createAgentTables` again.
- `AgentDefinition.ask` and `AgentDefinition.intake` (`defaultAgent`, `agents[]`) are threaded through `AgentDepsFactory.forAgent()` into the loop, for the inline and the durable runner alike. They were only settable on `AgentLoopDeps`, so an app using the provider could not offer the `ask` tool at all.
- `SinkWriter.flush?()` — optional; `childSinkWriter`'s `end()` now calls it, so a delegated run's gathered text is written before its parent's next frame. Sinks that hold nothing back need no change.
