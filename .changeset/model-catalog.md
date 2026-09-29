---
'@adonis-agora/agent': minor
---

Model catalog, per-thread and per-send model, matching `@dudousxd/nestjs-agent`: `models` in `config/agent.ts` (a literal `ModelCatalogView` or a `ModelCatalog` deciding per caller) is served by `GET /agent/models?agent=`; `POST /agent/chat { model }` runs a turn on a catalog model and `PATCH /agent/threads/:id { model }` pins one on a thread (`null` unpins) — anything the catalog does not offer as available is a `400`. The pick reaches the provider as `ModelTurnArgs.model` (`aiSdkModel` gains `resolveModel`, and passes the id through verbatim for a gateway string), rides the run's input so a durable replay makes the same choice, and labels usage when the provider reports no model id. `GET /agent/agents` lists the registered agents for a picker (`AgentDefinition.description` is new). `ThreadSummary.model`; Lucid adds a nullable `agent_thread.model` column; `AgentStore` gains optional `updateThread`.
