---
'@adonis-agora/agent': minor
---

Resumable streams, message feedback and thread rename, matching `@dudousxd/nestjs-agent`:

- Under `streamProtocol: 'agent'` every event frame carries an SSE `id:` (its 1-based position in the run, the same on every attach). `GET /agent/chat/:runId/stream?after=<n>` — or `Last-Event-ID` — sends only the frames above `n`, and answers `404` when nothing is buffered under the run any more (new optional `TokenStreamSink.has`, implemented by the in-process, in-memory and Redis sinks), so the shared React client resumes a dropped stream instead of re-rendering it, and stops waiting on one nobody will write.
- `POST /agent/messages/:id/feedback` `{ value: 'up' | 'down' | null, comment? }` rates a message (owner only; `StoredMessage.feedback`; not copied to forks). Lucid adds a nullable `agent_message.feedback` column; `AgentStore` gains optional `threadOfMessage` and `setMessageFeedback`.
- `PATCH /agent/threads/:id` `{ title }` renames a thread.
