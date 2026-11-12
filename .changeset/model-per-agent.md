---
'@adonis-agora/agent': major
---

A model per agent and per persona. `AgentDefinition` and `Persona` take `model`, an id of the model catalog (`aiSdkModels({ … })` or `models` in `config/agent.ts`). A turn runs on the send's `model`, else the thread's pinned model, else the persona's `model`, else the agent's `model`, else the catalog's default; a catalog `locked` model still wins over all of them.

- An agent or persona `model` that a fixed catalog does not list fails boot, naming each one.
- On each turn the configured model passes the same catalog check as a pick: one the catalog does not offer the caller refuses the send with `400 model_not_allowed` (it does not fall back to another model).
- `GET <path>/models?agent=&persona=` answers that agent's (or persona's) model as `default`, and `useAgentChat`'s `models.defaultModel` / `models.selected` follow the chat's agent and persona.
- A delegation (`ask_<target>` / `start_<target>`) runs the target on its own model (its `model`, or the catalog's lock or default for it), never on the caller's pick or pin. A target model the catalog does not offer the caller refuses the delegation.
- The resolved model rides the run's input (and a delegation's checkpoint), so a durable replay, a resumed run and a queued message keep it, and usage rows are labelled with it when the provider reports no model id.

Breaking: `AgentDefinition.modelId` is removed, with no alias. It only labelled usage; use `model` (see "Migrating to 1.0").
