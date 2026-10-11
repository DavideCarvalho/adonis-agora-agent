---
"@adonis-agora/agent": minor
"@adonis-agora/agent-dashboard": minor
---

Generative UI: the sandbox's code is checked before a call is accepted, and every UI call is recorded as telemetry for a new dashboard page.

- **Validated before accepted.** `ui__sandbox` (and a `Sandbox` inside a `ui__render` tree) parses its JSX with the frame's own transpiler plus acorn/acorn-jsx, and its HTML scripts, `on*=` handlers, `jsFunctions` and `jsExpressions` with acorn. It checks that `App` exists, refuses any bridge other than `agent.send` (`flippy.send(…)`, `window.x.send`, `agent.post`) and any `<Component>` the kit's docs do not have, and warns about undeclared props. The model gets a short error with line, column and a one-line fix: ``invalid Sandbox code: jsx line 12:5: `flippy.send` — the bridge is `agent.send(payload)` ``. A component of your own can do the same with `defineComponent({ check })`. The parsers load on first use, server side only. `validateSandboxCode` is exported.
- **An example per mode.** `ui__sandbox`'s description ends with one minimal valid call: JSX with the kit, or HTML. The JSX is a quoted JSON string. It adds about 70–77 prompt tokens (o200k), only on turns that offer `ui__sandbox`.
- **Telemetry.** Genui tools are marked `ToolSpec.genui` (`{ mode, telemetry? }`). For each UI call the loop records tool, channel, mode, model, attempt, validity (`first_try` / `retried` / `failed`), error category, the call's share of its step's tokens and cost, and the time from turn start to its first and complete frame. It goes through the new optional `AgentStore.recordGenuiCalls`, into the in-memory store, or into the Lucid store's library-owned table `agent_genui_call`, which its schema heal (`createAgentTables`, run at boot) creates.
- **OpenCode.** The UI calls OpenCode's code mode makes through the MCP endpoint are recorded too, with attempts counted per run (`GenuiRunRecorder`). There the tokens are not split per call and the frames are not timed.
- **Privacy.** A row is metadata only, with quoted values scrubbed from error messages. Nothing app-side needs migrating. `telemetry: { samplePayloads: true }` also stores the call's input, for debugging only. `telemetry: false` records nothing.
- **Dashboard.** A new "Generative UI" page, backed by `GET <governance>/genui` and the optional `AgentGovernanceQueries.genuiStats`, shows first-try success per tool and model, common errors, UI cost per turn and per day, and p50/p95 time to first and complete frame.
