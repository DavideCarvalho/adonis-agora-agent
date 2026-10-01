---
'@adonis-agora/agent': minor
---

**Detached sub-agents — the chat stays free.** A `delegatesTo` edge can run its delegate in the background: `{ agent: 'researcher', detached: true }` synthesizes `start_researcher`, whose call returns a receipt (`{ detached: true, status: 'started', agent, runId, note }`) and lets the turn end. The delegate runs on its own stream and parks its approvals under its own run id; when it finishes, its answer is posted into the same thread as a message of its own, stamped `runId` and `agentName`, and the delegating tool call settles `delivered`. A failure or a Stop (cancel the receipt's `runId`) posts a message and settles `failed` / `cancelled`. Both runners: inline (a nested loop nobody awaits) and durable (`ctx.startChild`, one `spawn:` position from the workflow body). On the client, `useAgentChat({ background: true })` tracks them (`chat.background.runs`, polling while one runs).

Replay-safe for runs already in flight: the detached branch is settled inside the call's `persist:toolcall` checkpoint and the delivery position exists only on a detached child's own run, so a run parked on an earlier release replays the shape it recorded (a spec parks runs on 0.56.0 and resumes them on this release, over SQLite and Postgres). Flip an edge to `detached` once every process runs this release.

Messages carry an optional `agentName` (`StoredMessage`, `AppendMessageInput`); the Lucid store adds `agent_message.agent_name`, repaired in by `createAgentTables` on an existing database and written only when set.

**Staged-attachment inventory.** `AttachmentStagingStore.list` (implemented by `attachmentStores.media()` and `.memory()`), `GET /agent/attachments` (the caller's own staged files, metadata only), and `AgentService.listAttachments` / `collectableAttachments(actor, { olderThan })` — the staged files no message references and old enough not to be in flight, for a sweep you run (the library never deletes). A message waiting in a thread's queue counts as a reference. Refuses with `AttachmentInventoryError` (`501`) rather than guessing when either half cannot be answered.
