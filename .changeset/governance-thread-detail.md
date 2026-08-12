---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

Add a thread governance drill-down: `GET /agent/governance/threads/:id` and a `ThreadDetailView` you
reach by clicking a row in the console's Recent threads table.

`AgentGovernanceQueries` gets a new optional `threadDetail(threadId)` method returning the thread's
metadata plus a lifetime usage rollup (total tokens, cost, run/message counts) and its most recent
runs/messages — implemented in both `LucidGovernanceQueries` and `InMemoryGovernanceQueries`. It's
optional so a third-party or pre-existing adapter that predates it doesn't break: the route responds
`501` instead of the dashboard hitting a missing endpoint.

The Recent threads and Tool calls panels also gain "Load more" pagination instead of a fixed row cap.
