---
'@adonis-agora/agent': minor
---

**Personas, at parity with `@dudousxd/nestjs-agent` 1.20** — durable, pinned on the thread, enforced
on every call, and able to take over an old agent's name. Same wire as Nest: `POST chat { persona }`,
`forwardedProps.persona`, `persona` on every message and on the thread.

- **Durable.** The service resolves the persona to an **id** before the run starts; only the id
  rides `AgentRunInput` (and a queued message). The loop looks the definition up once and freezes it
  — id, label, allow-list, resolved prompt — in a `persona:resolve` checkpoint, so a parked run
  resumes on the persona it started with even after the config rewrote or removed it. Only a run
  that names a persona spends that checkpoint. A run parked on 0.59 or earlier (which carried the
  whole `Persona` in its input) replays exactly as recorded, with no new checkpoint; a builder prompt
  its JSON input lost is looked up by id. `AgentRunInput.persona` is `string | Persona` (a whole
  persona is still applied as given, with no checkpoint).
- **Thread pin.** A send runs under its own `persona` → the thread's pin (when this agent declares
  it) → the agent's `defaultPersona` → none. A persona a send names is pinned on the thread (it was
  stored at creation and then ignored); one it fell back to is not. `PATCH /agent/threads/:id
  { persona }` pins one (`null` clears); `ThreadSummary.persona` is now `string | null`.
- **`400 persona_not_found`** (`PersonaNotFoundError`) for an id the agent does not declare — on a
  send before anything is created, on the AG-UI route, and on the patch. It used to fall back to no
  persona silently.
- **Enforced on invoke.** `allowedTools` narrowed only the offer; a call the model named anyway now
  fails `ToolRegistry.invoke` (`InvokeOptions.allowedTools` → `ToolForbiddenError`), and handoffs
  are held to the same list. Tools see `ctx.persona` (the frozen definition).
- **Queue.** A queued message stores the persona its send resolved (`agent_queued_message.persona`,
  added by `createAgentTables` on SQLite, Postgres and MySQL) and starts under it. One queued
  without it resolves one as it starts. `ChatQueueServiceOptions.resolveTarget` replaces
  `personaFor` (kept, deprecated).
- **Catalog.** `GET /agent/agents` lists each agent's `personas` (`{ id, label, description? }`)
  and its `defaultPersona`. `GET /agent/threads/personas/catalog` stays.
- **`Persona.aliases`.** Old agent names a persona took over resolve to that agent + persona
  everywhere an agent name is read — sends, a thread's `defaultAgent`, queued messages, and runs in
  flight under the old name (served with the persona applied as config). No data migration.
- `Persona.systemPrompt` is optional (omit → the base prompt) and `Persona.description` is new.
  Stores: `CreateThreadInput.persona` is optional, `UpdateThreadInput.persona`, optional
  `AgentStore.personaForThread`, `persona` on queued messages. Exports: `findPersona`,
  `defaultPersonaOf`, `intersectAllowLists`, `personaCatalogEntry`, `resolvePersonaAlias`,
  `PersonaNotFoundError`, `TurnPersona`, `PersonaCatalogEntry`, `InvokeOptions`.
