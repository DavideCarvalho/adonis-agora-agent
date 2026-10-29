---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

One usage ledger for every AI cost, and where a run's time goes.

- `AgentService.recordUsage(input, { throwOnError? })` records AI spend from outside agent turns (transcription, TTS, batch embeddings, direct SDK calls) on `agent_token_usage`: `actorRef` (`null` → `PLATFORM_ACTOR_REF`, `'@platform'`), free-form `feature`, `modelId`, `provider`, tokens, `audioSeconds` / `characters` / `requests`, `costUsd` / `costSource`, optional `threadId` / `runId` / `tenantRef` / `metadata`. Never throws unless `throwOnError`; answers `{ recorded }`. Counts against the actor's quota (tokens in the token windows, cost in the USD windows, tokens bumped on the `QuotaStore`); platform cost counts against nobody.
- The ledger gains `feature`, `provider`, `tenant_ref`, `audio_seconds`, `characters`, `requests`, `metadata`, and a nullable `thread_id` (made nullable in place on Postgres/MySQL, by a table rebuild on SQLite; the foreign key and cascade stay). Agent-turn rows are labelled `agent:<agent name>`. `RecordUsageInput.threadId` is now optional and `UsagePurpose` gains `'external'`.
- Every ledger row is published as `agora:agent:usage.recorded` (amounts and attribution, never content).
- Governance: `spendByFeature` / `usageBreakdown` (cost by actor × feature) on `AgentGovernanceQueries`, `GET <path>/governance/spend/feature` and `/governance/usage/breakdown`; `RunUsageRow.feature`.
- Run timings: `agent_run` gains `queue_ms`, `model_ms`, `tools_ms`, `model_calls`, `tool_calls` and a per-step `timings` JSON. Queue time comes from the durable engine's run `createdAt` (≈0 inline), model time from the `llm.turn` span, tool time from the `tool.execution` measurement (`execution_ms`), wall-clock per step so parallel calls count once. Each figure is journaled with the step that measured it, so a resumed durable run counts every step once. `run.finished` carries `queueMs`, `modelMs`, `toolsMs`, `modelCalls`, `toolCalls`, `stepTimings`; `run.failed` / `run.cancelled` carry `queueMs` (and `run.failed` what it measured). `RunSummaryRow` and `RunDetail.timings` expose them.
- Dashboard: a "Spend by feature" panel on the Overview (agent turns and recorded usage side by side) and a "Where the time went" panel on the run trace (queue / model / tools / other, and each step).
