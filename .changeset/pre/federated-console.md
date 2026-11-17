---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

Federated console: the governance console can also show other apps' agents (runs, tool calls, threads, spend, approvals, pricing), with an **App** selector (`?app=` in the URL). Each app keeps its own tables and runs its own agent. `dashboard` gains `apps` (`label`, `governance`, `pricing`, `controlPlane: { connection, prefix }`, `timeoutMs`) and `appLabel`; the console reads the other app's governance read-model and prices from its tables (read-only, never created or altered), and sends approvals, rejections and price changes to that app over Redis, which answers with `consoleCommands: { connection, prefix }` in its `config/agent.ts` (one instance runs each command, claimed with `SET NX`). New `GET <path>/governance/apps`; `authorize` may grant `apps`. An unknown app answers 404, an app that does not answer 503 (naming it), a command it does not run 501, its own refusals keep their status (404, 403, 409, 410).
