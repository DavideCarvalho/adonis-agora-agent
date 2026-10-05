# @adonis-agora/agent

Governed, durable-backed AI agent (chat + tool-calling + governance) for **AdonisJS** — part of the
[Agora](https://github.com/DavideCarvalho) ecosystem.

The package is two things layered on top of each other:

- A **framework-agnostic agent loop** — `runAgentLoop(deps, input, hooks)` drives one model → tools →
  model turn against a set of SPIs (model / store / quota / roles / sink / runner / governance). The
  `hooks` seam (`step` / `awaitApproval` / `openSink` / `runAgent`) lets the same loop body run
  in-process or as a replay-safe durable workflow (via `@adonis-agora/durable`, optional peer).
- An **AdonisJS integration shell** — a service provider, `defineConfig`, HTTP routes (`/agent/*`,
  `/agent/governance/*`, `/agent/attachments`), Lucid-backed stores, tool discovery from
  `app/agent_tools`, RAG (pgvector or Qdrant retrievers, plus PageIndex-style tree navigation for
  long documents), a governed read-only SQL tool, and a React chat hook.

`read` tools auto-execute, `action` tools gate on human approval (HITL), and `agent` tools delegate
to another named agent.

## Component registries and server rendering

Tools support a `present` hook in both functional and decorated class forms. Register custom components per app, share React renderers between web screens and static exports, and generate paginated PNG/PDF tables and charts for your own delivery adapters.

See the [component rendering guide](./docs/authoring/component-rendering.mdx) for complete examples, schemas, text fallbacks, and capture configuration.


## Install

```sh
pnpm add @adonis-agora/agent
node ace configure @adonis-agora/agent
```

`configure` registers the provider, wires an Assembler `init` hook that generates the typed
`app/agent_tools` barrel (falls back to a runtime scan if absent), publishes `config/agent.ts`, and
publishes the migrations — the base agent tables, a pgvector RAG-chunk table, and the tree-navigation
tables (delete whichever you don't use, e.g. the pgvector migration if you retrieve via Qdrant instead,
or the trees migration if you don't navigate long documents; run `node ace migration:run` for the rest).

Only `ai` (or a hand-rolled `ModelProvider`) and a model factory are strictly required. Everything
else is an **optional peer**, imported lazily only when configured:

| Peer | Needed for |
|---|---|
| `ai` (`^7.0.0`) | `aiSdkModel` — the Vercel AI SDK v7 adapter (`@adonis-agora/agent/ai-sdk`) |
| `@adonisjs/lucid` (`^22.4.0`) | `stores.lucid()`, pricing, governance read-model, the data tool's `db` |
| `@adonisjs/redis` (`^9.2.0`) | `tokenSinks.redis()` — multi-replica SSE token streaming |
| `@adonis-agora/durable` (`^0.8.0`) | `durable: true` — replay-safe durable runs (`@adonis-agora/agent/durable`) |
| `@adonis-agora/authz` (`^0.4.0`) | `AuthzActorResolver` / `AuthzToolAuthorizer` (`@adonis-agora/agent/authz`) |
| `@adonis-agora/telescope` (`^0.4.0`) | the Telescope watcher extension (`@adonis-agora/agent/telescope`) |
| `@qdrant/js-client-rest` (`^1.11.0`) | `retrievers.qdrant({...})` |
| `node-sql-parser` (`^5.3.0`) | the governed `dataTool` (`@adonis-agora/agent/data`) |
| `react` (`^18` / `^19`), `@ai-sdk/react` and `ai` | `AgentProvider` / `useAgentChat` (`@adonis-agora/agent/react`) |

## Configure

Only `model` is required — pick a `store` by name (omit for the in-memory, single-process store):

```ts
// config/agent.ts
import { defineConfig, stores, AuthActorResolver } from '@adonis-agora/agent'
import { aiSdkModel } from '@adonis-agora/agent/ai-sdk'
import { openai } from '@ai-sdk/openai'

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')), // any Vercel AI SDK v7 `LanguageModel`
  store: 'lucid',
  stores: { lucid: stores.lucid(), memory: stores.memory() },
  actorResolver: new AuthActorResolver(), // defaults to one that THROWS — an identity is never fabricated
})
```

Pricing (`costUsd` on each turn) and the `/agent/governance/*` read routes both default to mirroring
`store` when it's `stores.lucid()` (same connection, table auto-created) — override with
`pricingStore` / `governanceQueries`, or `false` to disable. `sink` defaults to the in-process token
sink; pass `tokenSinks.redis({...})` so any pod can serve any run's SSE stream.

## Use

### Chat — the provider mounts the HTTP API for you

There's no controller to write: once configured, the provider itself mounts `POST /agent/chat` (starts
a run and SSE-pipes the token stream), `GET /agent/chat/:runId/stream` (re-attach), thread CRUD,
approve/reject for HITL `action` tools, quota, and — when `governanceQueries` is set — the
`/agent/governance/*` read routes. Every route resolves the actor itself (401 on failure); a
`threadId` passed to `chat` must belong to the caller.

Drive it from React with `@adonis-agora/agent/react` — the full headless layer (history, resume, a
message queue, approvals, attachments, threads), with the session cookie and shield's CSRF token
already wired:

```tsx
// npm i @ai-sdk/react ai
import { AgentProvider, useAgentChat } from '@adonis-agora/agent/react'

export default function ChatPage() {
  return (
    <AgentProvider>
      <Chat />
    </AgentProvider>
  )
}

function Chat() {
  const { transcript, composer, queue } = useAgentChat()
  return (
    <form onSubmit={(e) => (e.preventDefault(), void composer.submit())}>
      {transcript.items.map((item) => (
        <p key={item.id}>{item.role}: {item.text}</p>
      ))}
      {queue.items.map((m) => <p key={m.id}>(waiting) {m.text}</p>)}
      <input value={composer.text} onChange={(e) => composer.setText(e.target.value)} />
      <button disabled={!composer.canSend}>Send</button>
    </form>
  )
}
```

The hooks ship inside Agora. Its protocol remains compatible with Aviary, but installation and
releases are independent. Without React, use the framework-free stream client:

```ts
import { createAgentChatClient } from '@adonis-agora/agent/client'

const client = createAgentChatClient({ basePath: '/agent' })
const { parts } = await client.send({ body: { message: 'hi' }, onParts: (parts) => render(parts) })
```

### Write a governed tool

Tools are auto-discovered from `app/agent_tools`. `ReadTool` auto-executes; `ActionTool` requires
human approval before it runs:

```ts
// app/agent_tools/allocation_queue.ts
import { z } from 'zod'
import { ReadTool } from '@adonis-agora/agent'
import type { AiToolCtx } from '@adonis-agora/agent'

export default class AllocationQueue extends ReadTool<{}, Row[]> {
  static tool = {
    name: 'allocation_queue',
    description: 'Lists pending allocation requests for the current tenant.',
    input: z.object({}),
    ability: 'agent.coordinator.queue.read',
  }
  async execute(_input: {}, ctx: AiToolCtx): Promise<Row[]> {
    return db.from('allocations').where('tenant_ref', ctx.actor.tenantRef)
  }
}
```

An `ActionTool` writes somewhere, and that write and the checkpoint recording it are two writes: a
worker that dies between them re-runs the tool on recovery. `ctx.idempotencyKey`
(`<runId>:<toolCallId>`) is the same for every execution of one call — pass it on as the downstream
idempotency key (a provider's `Idempotency-Key`, a unique column, the `id` of a workflow the tool
starts) so the second attempt lands on the first.

### Governed read-only SQL

`@adonis-agora/agent/data` ships `dataTool` — a fail-closed SQL tool: it requires an explicit,
role-based table allowlist, rewrites in an optional per-row tenant scope (off the calling actor's
`tenantRef`), injects a row-count `LIMIT`, and truncates oversized results before they hit the model's
context. Register it as a static tool in `config/agent.ts` (`defineConfig({ tools: [dataTool({...})] })`)
or export it from an `app/agent_tools/` module:

```ts
import { dataTool } from '@adonis-agora/agent/data'
import db from '@adonisjs/lucid/services/db'

export const executeSql = dataTool({
  db,
  tableAccess: {
    roleGroups: { ADMIN: ['billing'] },
    tablesByGroup: { billing: ['orders', 'invoices'] },
  },
  tenant: { tenantColumn: 'tenant_ref', scopedTables: ['orders', 'invoices'] },
  maxRows: 200,
})
```

### Guardrails — PII, secrets, prompt injection, tool poisoning

`@adonis-agora/agent/guardrails` puts detectors and a rule engine on the loop's processor seams,
which `config/agent.ts` now takes as `inputProcessors` / `outputProcessors`:

```ts
// config/agent.ts
import { createGuardrails } from '@adonis-agora/agent/guardrails'

const guardrails = createGuardrails({
  pii: 'redact',                 // reversible: the model sees [EMAIL_1], the reader the address
  secrets: 'block',
  injection: { threshold: 0.6 }, // the prompt and every tool result; default action: block
  toolPoisoning: true,           // guardrails.screenTool, for `mcpServers[].screen`
  rules: (ctx) => rulesForTenant(ctx.actor?.tenantRef), // more rules, resolved per scan
  onEvent: (event) => audit(event),                     // hits carry fingerprints, never values
})

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  inputProcessors: [guardrails.input],
  outputProcessors: [guardrails.output],
  mcpServers: [{ name: 'docs', transport: { type: 'http', url }, screen: (t) => guardrails.screenTool(t) }],
})
```

A blocked prompt fails the run (`ProcessorFailedError` caused by a `GuardrailBlockedError`); a
blocked tool result is withheld and the turn goes on; a blocked answer or tool call is an
`OutputRejectedError`. `guardrails.wrapTool(name, handler)` restores placeholders into a tool's
arguments and runs the `tool_args` rules on them. The output processor declares `incremental`, so the
answer keeps streaming. The detectors (`detectPii` with Luhn/CPF/CNPJ/IBAN checks, `detectSecrets`,
`scoreInjection`, `scoreToolText`) and `scan` work on their own. The guardrail implementation ships locally in Agora; it does not require an Aviary core package.

### Framework-agnostic core (no AdonisJS)

`runAgentLoop(deps, input, hooks)` is the shared turn body both the in-process (`InlineAgentRunner`)
and the durable runner drive — `hooks` is what tells it which one it's in. Exercised directly (e.g. in
a test) with the in-memory doubles from `@adonis-agora/agent/testing`:

```ts
import { runAgentLoop, ToolRegistry, DefaultRolesPolicy } from '@adonis-agora/agent'
import {
  FakeModelProvider,
  echoScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@adonis-agora/agent/testing'

const sink = new InMemoryTokenStreamSink()
const { text } = await runAgentLoop(
  {
    model: new FakeModelProvider(echoScript('hi there')),
    store: new InMemoryAgentStore(),
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    day: '2026-07-21',
    systemPrompt: 'You are a helpful assistant.',
  },
  { threadId: 'thread-1', actor: { id: 'user-1', roles: ['USER'] }, userText: 'hi' },
  {
    runId: crypto.randomUUID(),
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => 'approve',
    step: (_name, fn) => fn(),
  },
)
```

## Dashboard

`node ace configure @adonis-agora/agent` also registers an embedded governance console — the
`@adonis-agora/agent-dashboard` React SPA, bundled straight into `@adonis-agora/agent`'s own `dist/`
at build time. **No separate install, no separate provider registration.** It mounts at
`<path>/dashboard` (default `/agent/dashboard`) once `governanceAuthorize` is configured — every panel
but Quota reads the cross-actor `/agent/governance/*` routes, and those don't exist without that gate
either, so the console refuses to mount (with a boot warning explaining why) rather than load and 404
on every panel:

```ts
// config/agent.ts
export default defineConfig({
  // ...
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
  // dashboard: { enabled: true, path: '/agent/dashboard', authorize: (actor) => actor.roles?.includes('ADMIN') ?? false },
})
```

See [Governance dashboard](./docs/governance/dashboard.mdx) for the full config shape.

<details>
<summary>Standalone install (still supported)</summary>

`@adonis-agora/agent-dashboard` also ships as its own installable package with its own provider, for
apps that want its independent release cadence or that configured it before the embedded provider
existed:

```sh
pnpm add @adonis-agora/agent-dashboard
node ace add @adonis-agora/agent-dashboard
```

It reads the SAME `config('agent').dashboard` block. Register only ONE of the two providers — mounting
both at the same path throws AdonisJS's "duplicate route" error at boot.

</details>

## Diagnostics

Runtime events flow through `@adonis-agora/agent/telescope`'s watcher when
[`@adonis-agora/telescope`](https://github.com/DavideCarvalho/adonis-telescope) is installed, alongside
the framework-agnostic `diagnostics` event types exported from the root entry point.

## Testing

`@adonis-agora/agent/testing` ships `FakeModelProvider` and in-memory doubles for the store, sink,
quota and governance SPIs, so the agent loop can be exercised deterministically without a DB, Redis,
or a real model provider.

## Links

- Repo: https://github.com/DavideCarvalho/adonis-agent
- Changelog: https://github.com/DavideCarvalho/adonis-agent/blob/master/packages/adonis/CHANGELOG.md
- Companion package (also embedded automatically, see [Dashboard](#dashboard) above): [`@adonis-agora/agent-dashboard`](https://github.com/DavideCarvalho/adonis-agent/tree/master/packages/dashboard)

## License

MIT
