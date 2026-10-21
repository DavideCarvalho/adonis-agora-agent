---
'@adonis-agora/agent': minor
---

More of a run on its diagnostics, so an observer can chart failures, cost and slow tools without reading the store:

- **`agora:agent:run.failed`** when the loop throws, with the same stable `code` the stream's `error` frame carries (`quota_exceeded`, `model_no_output`, `run_failed`…) and `durationMs`. Never the error itself. A durable control-flow signal (suspend on an approval or a question) is not an ending and publishes nothing.
- **`agora:agent:run.cancelled`** when the run's abort signal fired.
- **`run.finished`** also carries `costUsd` (when any step's cost is known), `modelId` (the last model call's), and who the run is: `agentName`, `actorId`, `tenantRef`, and `parentRunId` on a delegation's child run. `run.failed` and `run.cancelled` carry the same.
- **`tool-call`** carries `toolCallId`, and `durationMs` when this process ran the tool. A call whose checkpoint the durable runtime read back from the journal is published again with `replayed: true` and no duration, so counting observers can skip it.
