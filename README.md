# @adonis-agora/agent

Governed, durable-backed AI agent (chat + tool-calling + governance) for AdonisJS — part of the
[Agora](https://github.com/DavideCarvalho) ecosystem.

> **Status: Wave 1 — framework-agnostic core.** This package currently ships the provider-agnostic
> agent runtime only: the agent loop, the SPIs (model / store / quota / roles / sink / runner /
> governance), the tool registry, personas/agent registries, the Vercel AI SDK adapter, and
> in-memory testing doubles. The AdonisJS provider, HTTP routes, and Lucid store land in Wave 2.

## Install

```sh
pnpm add @adonis-agora/agent
```

### Peer dependencies

Every peer is **optional** — install only the ones the features you use need. Nothing here is
pulled in for you, so a core-only install stays small.

| Peer | Range | Needed for |
| --- | --- | --- |
| `zod` | `^4.0.0` | Tool input/output schemas |
| `ai` | `^7.0.0` | The Vercel AI SDK adapter (`/ai-sdk`) |
| `@adonisjs/core` | `^7.3.0` | The AdonisJS provider / HTTP surface |
| `@adonisjs/lucid` | `^22.4.0` | The Lucid-backed store |
| `@adonisjs/redis` | `^9.2.0 \|\| ^10.0.0 \|\| ^11.0.0` | Redis-backed quota / rate limiting |
| `@adonis-agora/durable` | `>=0.8.0 <1.0.0` | Running the agent loop as a durable workflow |
| `@adonis-agora/authz`, `@adonis-agora/telescope`, `@adonis-agora/diagnostics` | `>=…<1.0.0` | Governance roles, telemetry, the diagnostics bus |
| `@qdrant/js-client-rest`, `node-sql-parser`, `react` | see `package.json` | Vector search, the SQL data tool, the React bindings |

**zod 4 is required** (since `@adonis-agora/agent@0.31.0`). The previous `^3.23.0 || ^4.0.0` range
was a promise this package could not keep: `@adonis-agora/durable` types its public step API with
zod 4, and a zod 3 schema does not satisfy zod 4's `ZodType` — an app on zod 3 was already broken
against the published ecosystem, it just failed later and less clearly. The surface agent uses
(`z.object` / `z.string()` / `z.infer`) is unchanged across the major, so upgrading is mechanical.

## Entry points

| Import                        | What it exposes                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| `@adonis-agora/agent`         | `runAgentLoop`, SPIs, `ToolRegistry`, `AgentRegistry`, personas, types |
| `@adonis-agora/agent/ai-sdk`  | `aiSdkModel` — adapts a Vercel AI SDK v7 `LanguageModel` to `ModelProvider` |
| `@adonis-agora/agent/testing` | `FakeModelProvider`, in-memory store / sink / quota / governance doubles |
| `@adonis-agora/agent/types`   | The public type surface                                               |

## The agent loop

`runAgentLoop(deps, input, hooks)` drives one provider-agnostic agent turn (model → tools → model).
The `hooks` seam (`step` / `awaitApproval` / `openSink` / `runAgent`) lets the same loop body run
either in-process or as a replay-safe durable workflow. `read` tools auto-execute, `action` tools
gate on human approval, and `agent` tools delegate to another named agent.

A call's kind is resolved *inside* its `persist:toolcall:<callId>` checkpoint and returned from it,
so a replay reads the recorded kind out of the journal rather than asking its own `ToolRegistry` —
the branch cannot change with the process that resumes the run. A turn whose calls are all `read`
runs their invocations concurrently, so the turn costs the slowest call rather than their sum, while
the checkpoints on either side stay sequential in call order.

`historyWindow` bounds how much of a thread rides into a turn — a message count, a token budget, or
both, optionally folding what it left out into a leading summary.

## License

MIT
