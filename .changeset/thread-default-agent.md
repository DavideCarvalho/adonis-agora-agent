---
'@adonis-agora/agent': minor
---

A thread can have its own default agent — `PATCH <path>/threads/:id { defaultAgent }`

A send that names no `agent` now runs as the thread's `defaultAgent` when it has one, else the configured default (a send's own `agent` still wins). `null` clears it; a name no agent is registered under is a `400` (`UnknownAgentError`). Patching `model` in the same request checks the model against the agent the thread's next turn runs as. Thread summaries carry `defaultAgent`.

Before, the key was silently ignored. Matches `@dudousxd/nestjs-agent`, whose React client already sends it.

Stores: `UpdateThreadInput.defaultAgent`, and an optional `AgentStore.defaultAgentForThread(threadId)` (one scalar instead of the whole transcript on every send). `LucidAgentStore` stores it in a new nullable `agent_thread.default_agent` column — created by `createAgentTables` and added to an existing table by the same additive repair as earlier columns (no new migration to run). `InMemoryAgentStore` implements both. `AgentService.updateThreadSettings(actor, threadId, { defaultAgent?, model? })` is the service entry; `setThreadModel` delegates to it.
