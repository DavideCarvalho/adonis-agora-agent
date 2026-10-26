---
'@adonis-agora/agent': minor
---

Streaming, governance and quota hot paths do less work:

- The default in-process token sink lets a run's frames go an hour after its last write, instead of keeping every stream the process ever served.
- The incremental output gate re-runs the processor chain once every half lookback window instead of on every streamed token, and keyword guardrails build their matcher once per word list. The streamed and stored text are unchanged.
- The Lucid and Redis token sinks coalesce consecutive reasoning deltas and one tool call's argument deltas, like answer text. The Redis sink now coalesces text too, pushes each frame in one MULTI round trip through the `@adonisjs/redis` adapter (`RedisStreamClient.append`, optional), and reads the end marker only once per subscription.
- SSE, AG-UI and A2UI routes let go of the run's subscription when the client disconnects; Lucid and Redis subscribers end when the run's data expired under them, and follow a run whose numbering started over instead of skipping its frames.
- A send reads the thread's pinned model as one column (`AgentStore.modelForThread`, optional).
- New indexes: `agent_message(thread_id, seq)`, `agent_tool_call(message_id)`, `agent_token_usage(thread_id)`, `agent_token_usage(created_at)`, `agent_run(thread_id, started_at)`, `agent_stream_frame(created_at, run_id)` — created by `createAgentTables` (and the sink's own provisioning) on the next boot or migration.
- Governance: the pending-approvals inbox is one joined statement with the actor filter in SQL, a new optional `countPendingApprovals` gives the Telescope stat an exact count, and the spend, trend, recent-threads, recent-tool-calls and thread-detail reads aggregate in SQL. The quota's day and month windows are summed in SQL. The Lucid sink's TTL purge reads the new `created_at` index instead of scanning the table.
- `useAgentChat` re-renders a streaming answer at most every 50 ms.
