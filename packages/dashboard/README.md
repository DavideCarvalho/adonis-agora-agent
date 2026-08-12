# @adonis-agora/agent-dashboard

A read-only **governance console** for [`@adonis-agora/agent`](../adonis) — a dependency-light React
SPA served by a thin AdonisJS provider. It visualizes the agent's own governance read-model: spend by
model and by actor, the daily usage/cost trend, recent threads and tool calls, and today's quota.

Part of the Agora ecosystem, themed with the Agora design tokens (AdonisJS violet on a dusk-ink
canvas, warm-paper in light).

## What it shows

All data comes from the agent provider's **real** routes — the SPA is a pure consumer:

| View       | Route(s) consumed                                                            |
| ---------- | ---------------------------------------------------------------------------- |
| Overview   | `GET /agent/governance/spend/model`, `spend/actor`, `usage/trend`            |
| Threads    | `GET /agent/governance/threads/recent`                                       |
| Tool calls | `GET /agent/governance/tool-calls/recent`                                    |
| Quota      | `GET /agent/quota/today`                                                      |

## Install

As of `@adonis-agora/agent@0.21.0`, **you don't need to install this package at all**:
`node ace configure @adonis-agora/agent` registers an embedded dashboard provider that serves this
exact SPA (bundled straight into `@adonis-agora/agent`'s own `dist/` at build time) at
`<agentPath>/dashboard` — no separate install, no separate provider registration. See the
[`@adonis-agora/agent` README's Dashboard section](../adonis/README.md#dashboard).

This package still ships and installs standalone, for apps that configured it before the embedded
provider existed, or that want its independent release cadence:

```sh
pnpm add @adonis-agora/agent-dashboard
node ace add @adonis-agora/agent-dashboard
```

Register the provider (after the agent provider) in `adonisrc.ts`:

```ts
providers: [
  () => import('@adonis-agora/agent/agent_provider'),
  () => import('@adonis-agora/agent-dashboard'),
]
```

The dashboard reads `config/agent.ts` for the agent `path` and `actorResolver`, mounts the SPA at
`<agentPath>/dashboard` (default `/agent/dashboard`), and gates every request through the **same**
actor resolver as the governance routes. Toggle or relocate it with an optional block — the SAME block
the embedded provider reads, so switching between the two needs no config change:

```ts
// config/agent.ts
export default defineConfig({
  // ...
  dashboard: { enabled: true, path: '/agent/dashboard' },
})
```

Register only ONE of the two providers (the embedded one from `@adonis-agora/agent`, or this
package's): mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

## Browser client

The framework-free fetch client is exported for reuse:

```ts
import { AgentClient } from '@adonis-agora/agent-dashboard/client'

const client = new AgentClient({ baseUrl: '/agent' })
const spend = await client.spendByModel({ fromDay: '2026-03-01', toDay: '2026-03-07' })
```
