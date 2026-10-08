---
'@adonis-agora/agent': patch
---

Text channels: a message is answered under a single `durable:work` worker. A durable channel job runs inside the worker's tick, which ends only when the job does; with a dispatcher that only persists a started run, the turn the job started (and any delegate it spawned) waited for the next tick while the job waited for the turn — until `timeoutMs`, when the turn was cancelled and the person got the "something went wrong" text. While it reads a turn, a durable channel job now executes in its own process whatever of that turn is still `pending` (taking the run's lease, so a run another worker holds is left to it). New optional `AgentRunner.drive(runId)` (implemented by the durable runners) and `AgentService.drive(runId)`.
