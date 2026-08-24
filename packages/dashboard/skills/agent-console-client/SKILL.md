---
name: agent-console-client
description: >-
  Serve and consume the @adonis-agora/agent governance console: the embedded provider
  from node ace configure @adonis-agora/agent vs the standalone @adonis-agora/
  agent-dashboard provider (register only ONE — duplicate-route error), the shared
  config('agent').dashboard block { enabled, path, authorize, onUnauthenticated },
  decideDashboardMount refusal reasons (no-governance-gate vs no-governance-queries),
  and the framework-free AgentClient from @adonis-agora/agent-dashboard/client
  (spendByModel/spendByActor/usageTrend/quotaToday/recentThreads/recentToolCalls/
  pendingApprovals/approveToolCall) with window.__AGENT_DASHBOARD_BASE__ resolution.
  Use for "dashboard blank or won't mount", "governance console 404", "build a custom
  governance UI", "approve HITL calls from the browser".
metadata:
  type: core
  library: "@adonis-agora/agent-dashboard"
  library_version: "0.7.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/dashboard/README.md"
  - "DavideCarvalho/adonis-agent:packages/dashboard/src/client/agent-client.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/dashboard/define_config.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/governance/dashboard.mdx"
---

# The governance console & browser client

`@adonis-agora/agent-dashboard` is a read-only React SPA over `@adonis-agora/agent`'s
cross-actor `/agent/governance/*` read routes — spend by model/actor, usage trend,
threads, tool calls, quota, and the HITL approvals inbox. Since agent@0.21.0 the same SPA
ships EMBEDDED in `@adonis-agora/agent`; this package remains for standalone installs and
for its framework-free browser client.

## Setup

Most apps need nothing: `node ace configure @adonis-agora/agent` registers an embedded
provider that serves the SPA at `<path>/dashboard` once `governanceAuthorize` exists:

```ts
// config/agent.ts — the gate is what makes the console mount at all.
import { defineConfig } from '@adonis-agora/agent'

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  store: 'lucid',
  stores: { lucid: stores.lucid() },
  actorResolver: new AuthActorResolver(),
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
  // dashboard: { enabled: true, path: '/agent/dashboard', authorize: (actor) => actor.roles?.includes('ADMIN') ?? false },
})
```

Standalone install (independent release cadence):

```bash
pnpm add @adonis-agora/agent-dashboard
node ace add @adonis-agora/agent-dashboard
```

```ts
// adonisrc.ts — AFTER the agent provider; register only ONE of the two.
providers: [
  () => import('@adonis-agora/agent/agent_provider'),
  () => import('@adonis-agora/agent-dashboard'),
]
```

Both providers read the SAME `config('agent').dashboard` block, so switching between them
needs no config change.

Source: `packages/dashboard/README.md`, `packages/adonis/README.md` ("Dashboard").

## Core patterns

### Pattern 1 — drive the governance API with `AgentClient`

The framework-free fetch client mirrors the read surface plus pricing and HITL actions;
it sends `credentials: 'same-origin'`, so the host's session cookie gates every call
exactly as the routes do server-side:

```ts
import { AgentClient } from '@adonis-agora/agent-dashboard/client'

const client = new AgentClient({ baseUrl: '/agent' })

const byModel = await client.spendByModel({ fromDay: '2026-03-01', toDay: '2026-03-07' })
const trend = await client.usageTrend({ fromDay: '2026-03-01', toDay: '2026-03-07' })
const quota = await client.quotaToday()
const approvals = await client.pendingApprovals({})

// HITL decisions from your own UI:
await client.approveToolCall(runId, toolCallId)
await client.rejectToolCall(runId, toolCallId, 'not this account')

// Pricing table maintenance:
await client.upsertPrice({ modelId: 'gpt-4o-mini', inputPricePer1m: 0.15, outputPricePer1m: 0.6 })
```

Non-2xx responses throw `AgentApiError` carrying the HTTP status for branching.

Source: `packages/dashboard/src/client/agent-client.ts`, `packages/dashboard/src/client/index.ts`.

### Pattern 2 — redirect to login via `onUnauthenticated`

The one denial `authorize` never sees is a failed actor resolution. Set a response header
inside the hook (typically a redirect); the gate detects it and skips its default
`401 { error }` JSON write:

```ts
// config/agent.ts
export default defineConfig({
  // ...
  dashboard: {
    onUnauthenticated: (ctx) => ctx.response.redirect('/login'),
  },
})
```

Return normally without touching the response and the default JSON is written instead —
the hook is safe to omit or use purely for logging.

Source: `packages/adonis/src/dashboard/define_config.ts`
(`AgentDashboardUnauthenticatedHook`).

### Pattern 3 — diagnose a dead console from the boot warning

`decideDashboardMount(enabled, governanceAuthorize, governanceQueries)` produces three
distinct refusals, each logged with wording that names the responsible knob:

| Condition | Reason | Fix |
| --- | --- | --- |
| `enabled: false` | `disabled` | intentional; no warning |
| no `governanceAuthorize` | `no-governance-gate` | set the gate (or `() => true` deliberately) |
| `governanceQueries: false` | `no-governance-queries` | remove the `false` / wire a read-model |

The two non-disabled warnings are deliberately DIFFERENT strings so an operator staring
at a 404 can tell from the log alone which knob is responsible.

Source: `packages/adonis/src/dashboard/define_config.ts` (`decideDashboardMount`,
warning constants).

## Common mistakes

### HIGH — registering both dashboard providers

```ts
// Wrong — embedded AND standalone serve <path>/dashboard.
providers: [
  () => import('@adonis-agora/agent/agent_provider'),
  () => import('@adonis-agora/agent/dashboard_provider'),
  () => import('@adonis-agora/agent-dashboard'),
]
```

```ts
// Correct — exactly one of the two.
providers: [
  () => import('@adonis-agora/agent/agent_provider'), // its embedded dashboard_provider rides along
]
```

Mechanism: both mounts claim the same route path, so boot throws AdonisJS's duplicate
route error — the app fails to start rather than double-serving.
Source: `packages/dashboard/README.md` ("Register only ONE of the two providers"),
`packages/adonis/README.md`.

### MEDIUM — setting only `dashboard.enabled: true` and expecting panels to load

```ts
// Wrong — enabled is necessary but NOT sufficient; every panel but Quota reads gated routes.
dashboard: { enabled: true }
```

```ts
// Correct — the data gate is governanceAuthorize on the AGENT config.
governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
dashboard: { enabled: true },
```

Mechanism: without a gate the console refuses to mount entirely (boot warning naming the
knob) because it would otherwise load and fail on every panel — serving a shell that can
only 404 its own data is worse than not serving it.
Source: `packages/adonis/src/dashboard/define_config.ts` (`decideDashboardMount`,
`NO_GOVERNANCE_GATE_WARNING`).

### LOW — hard-coding `/agent` as the client base in a custom UI

```ts
// Wrong — breaks the moment the app mounts the agent under a prefix like /api/agent.
const client = new AgentClient({ baseUrl: '/agent' })
```

```ts
// Correct — reuse the same resolution the SPA uses: injected value wins, else derive.
import { resolveApiBase } from '@adonis-agora/agent-dashboard/client'
const client = new AgentClient({ baseUrl: resolveApiBase() })
```

Mechanism: the provider injects the exact mounted base as `window.__AGENT_DASHBOARD_BASE__`
when serving index.html; absent that, `deriveApiBase(location.pathname)` strips the
trailing `/dashboard` segment — `/api/agent/dashboard` → `/api/agent`.
Source: `packages/dashboard/src/client/api-base.ts` (`resolveApiBase`, `deriveApiBase`).

See also: `agent-governance/SKILL.md` — the `governanceAuthorize` gate this console
consumes through; `agent-setup/SKILL.md` — seeding prices so `upsertPrice` rows matter.
