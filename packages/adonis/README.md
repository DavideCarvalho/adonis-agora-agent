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
  `app/agent_tools`, RAG (pgvector or Qdrant retrievers), a governed read-only SQL tool, and a
  React chat hook.

`read` tools auto-execute, `action` tools gate on human approval (HITL), and `agent` tools delegate
to another named agent.

## Install

```sh
pnpm add @adonis-agora/agent
node ace configure @adonis-agora/agent
```

`configure` registers the provider, wires an Assembler `init` hook that generates the typed
`app/agent_tools` barrel (falls back to a runtime scan if absent), publishes `config/agent.ts`, and
publishes three migrations — the base agent tables, additive run-tracking, and a pgvector RAG-chunk
table (delete whichever you don't use, e.g. the pgvector migration if you retrieve via Qdrant instead;
run `node ace migration:run` for the rest).

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
| `react` (`^18` / `^19`) | `useAgentChat` (`@adonis-agora/agent/react`) |

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

Drive it from the browser with the framework-free client or the React hook:

```tsx
import { useAgentChat } from '@adonis-agora/agent/react'

function Chat() {
  const { messages, status, send } = useAgentChat({ basePath: '/agent' })
  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>{m.role}: {m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</p>
      ))}
      <button disabled={status === 'streaming'} onClick={() => send('hi')}>Send</button>
    </div>
  )
}
```

or, without React:

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
