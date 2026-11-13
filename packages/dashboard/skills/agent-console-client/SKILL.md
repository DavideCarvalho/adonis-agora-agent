---
name: agent-console-client
description: >-
  Serve and consume the @adonis-agora/agent governance console: the embedded provider
  from node ace configure @adonis-agora/agent vs the standalone @adonis-agora/
  agent-dashboard provider (register only ONE — duplicate-route error), the shared
  config('agent').dashboard block { enabled, path, authorize, accessDenied, viewer, signOut } where authorize
  gates the console AND /agent/governance/* (open outside production, 403 in production when
  omitted), the governanceQueries: false mount refusal,
  and the framework-free AgentClient from @adonis-agora/agent-dashboard/client
  (spendByModel/spendByActor/usageTrend/quotaToday/recentThreads/recentToolCalls/
  pendingApprovals/approveToolCall) with injected-config apiBase resolution.
  Use for "dashboard blank or won't mount", "governance console 404", "build a custom
  governance UI", "approve HITL calls from the browser".
metadata:
  type: core
  library: "@adonis-agora/agent-dashboard"
  library_version: "1.0.0-rc.0"
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
threads, tool calls, quota, and the HITL approvals inbox. With tenancy on, those reads are
scoped to the viewer's organization (the header Organization picker keeps the choice in
`?tenant=`; `tenants` on the `authorize` result widens it). Since agent@0.21.0 the same SPA
ships EMBEDDED in `@adonis-agora/agent`; this package remains for standalone installs and
for its framework-free browser client.

## Setup

Most apps need nothing: `node ace configure @adonis-agora/agent` registers an embedded
provider that serves the SPA at `<path>/dashboard`. `dashboard.authorize` gates the console
AND the `/agent/governance/*` routes its panels read; omitted, both are open outside production
and answer 403 in production:

```ts
// config/agent.ts
import { defineConfig } from '@adonis-agora/agent'

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  store: 'lucid',
  stores: { lucid: stores.lucid() },
  actorResolver: new AuthActorResolver(),
  dashboard: { authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false },
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
// List reads return one page, `{ data, meta }`; `meta.nextCursor` goes back as `after`.
const { data: approvals, meta } = await client.pendingApprovals({ first: 50 })
const failed = await client.listRuns({ status: 'failed', from: '2026-03-01' })

// HITL decisions from your own UI:
await client.approveToolCall(runId, toolCallId)
await client.rejectToolCall(runId, toolCallId, 'not this account')

// Pricing table maintenance:
await client.upsertPrice({ modelId: 'gpt-4o-mini', inputPricePer1m: 0.15, outputPricePer1m: 0.6 })
```

Non-2xx responses throw `AgentApiError` carrying the HTTP status for branching. With
tenancy on, governance reads send the page's `?tenant=` automatically (`tenant` option;
`client.tenants()` reads `GET /governance/tenants` for the picker).

Source: `packages/dashboard/src/client/agent-client.ts`, `packages/dashboard/src/client/index.ts`.

### Pattern 2 — redirect to login with `{ redirectTo }`

`authorize` receives `ctx` (and the actor, when one resolves). Return `{ redirectTo }` for a
signed-out visitor: a page navigation gets a 302, an API call gets
`401 { error: 'unauthenticated', redirectTo }`. `authorizeByRoles({ loginPath })` from
`@adonis-agora/authz` does exactly this:

```ts
// config/agent.ts
import { authorizeByRoles } from '@adonis-agora/authz'

export default defineConfig({
  // ...
  dashboard: { authorize: authorizeByRoles({ roles: ['ADMIN'], loginPath: '/login' }) },
})
```

`onUnauthenticated` was removed in 1.0 — this replaces it.

Source: `packages/adonis/src/dashboard/gate.ts` (`evaluateDashboardGate`,
`answerDashboardDenial`).

### Pattern 3 — diagnose a dead or refusing console

`decideDashboardMount(enabled, governanceQueries)` refuses to mount only when `enabled:
false` (silent, intentional) or `governanceQueries: false` (boot warning naming it). Every
other app gets the console. A `403` on every request in production with the boot warning
"console has no `authorize` configured" means `dashboard.authorize` is missing.

Source: `packages/adonis/src/dashboard/define_config.ts` (`decideDashboardMount`),
`packages/adonis/src/console-authorize.ts` (`NO_CONSOLE_AUTHORIZE_WARNING`).

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

### HIGH — shipping to production without `dashboard.authorize`

```ts
// Wrong — open in dev, then every console page and governance call is 403 in production.
dashboard: { enabled: true }
```

```ts
// Correct — one authorize gates the console and the data it reads.
dashboard: { authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false },
```

Mechanism: omitted `authorize` means open outside production and closed in production; the
console is not read-only (Approvals decides HITL calls, Pricing writes rates), so decide who
may use it.
Source: `packages/adonis/src/dashboard/gate.ts` (`evaluateDashboardGate`).

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

Mechanism: the provider injects the exact mounted base as a JSON data block
(`<script type="application/json" id="agent-dashboard-config">{"apiBase":…}</script>`)
when serving index.html; absent that, `deriveApiBase(location.pathname)` strips the
trailing `/dashboard` segment — `/api/agent/dashboard` → `/api/agent`.
Source: `packages/dashboard/src/client/api-base.ts` (`resolveApiBase`, `deriveApiBase`).

See also: `agent-governance/SKILL.md` — the `dashboard.authorize` gate this console and
its data routes share; `agent-setup/SKILL.md` — seeding prices so `upsertPrice` rows matter.
