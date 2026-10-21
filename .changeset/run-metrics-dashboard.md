---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

A run's time to first token, failure code and model are stored, and the governance dashboard and the Telescope tab chart them:

- **Stored on the run.** `agent_run` gains nullable `ttft_ms`, `error_code` and `model_id`, added by `createAgentTables`' schema repair (run at boot; with `autoCreateTables: false`, re-run the `create_agent_tables` migration). `RecordRunEndInput` takes `ttftMs`, `errorCode` and `modelId`. A completed run records its time to first token and last model; a failed one records the same stable code its stream `error` frame carries (`quota_exceeded`, `model_no_output`, `run_failed`…), next to the `error` text as before. A run found dead, or failed by OpenCode, is `run_failed`. `RunSummaryRow` carries the three as optional fields.
- **Tool timing.** A tool call's `execution_ms` is now filled, measured inside its `tool:<id>` checkpoint: how long the tool ran, not how long a replay took to read it back. A replayed call writes none.
- **Read-model.** `RunReliability` gains optional `latency: { ttft, duration }` (`{ samples, p50Ms, p95Ms }`, nearest-rank, over completed turns a person started; a delegation's child run is left out) and `failuresByCode` (`{ code, count }[]`, most frequent first; a failure from before codes is `unknown`). `PerToolStatRow` gains optional `p50ExecutionMs` / `p95ExecutionMs`. `summarizeLatency` / `summarizeRunMetrics` are exported; `GenuiLatency` is now an alias of the shared `Latency`.
- **Dashboard.** Reliability shows time to first token and turn duration (p50 / p95) and a failures-by-code donut and table; Tools shows p50 / p95 per tool.
- **Telescope.** A new "Run latency" section: TTFT and turn-duration distributions (p50 / p95 / p99) from `run.finished`, and failures by code from `run.failed` (`agent.latency`, `agent.failuresByCode`). Active runs now subtract `run.failed` and `run.cancelled` too, and the tool-call counters skip a call re-published on replay.
