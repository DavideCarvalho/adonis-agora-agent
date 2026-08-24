---
name: agent-setup
description: >-
  Set up @adonis-agora/agent in an AdonisJS app: node ace configure @adonis-agora/agent,
  defineConfig in config/agent.ts (model via aiSdkModel from @adonis-agora/agent/ai-sdk,
  stores.lucid()/stores.memory(), quotas.ledger/quotas.memory, pricingStores +
  seedModelPrices + estimateCost, tokenSinks.redis multi-replica SSE sink,
  AuthActorResolver identity seam), auto-created agent tables vs the published migration,
  the cost fold (null vs $0.00), and route mounting under config path. Use for "set up
  the agent", "config/agent.ts", "agent tables / migration", "costUsd is null or zero",
  "quota not enforced", "401 on every agent route".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "0.25.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/getting-started.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/config-reference.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/define_config.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/stores/factory.ts"
---

# Setting up @adonis-agora/agent

`@adonis-agora/agent` is a governed AI agent module for AdonisJS: one `defineConfig`
call in `config/agent.ts` wires a provider-agnostic agent loop, persistence, budgeting,
and the `/agent/*` HTTP+SSE routes. Only `model` is required — everything else is a
fail-closed default that this skill walks through.

## Setup

Install and let the configure hook wire everything:

```bash
pnpm add @adonis-agora/agent
node ace configure @adonis-agora/agent
```

`configure` registers `@adonis-agora/agent/agent_provider` and
`@adonis-agora/agent/dashboard_provider` in `adonisrc.ts`, registers the Assembler init
hook that generates the typed `app/agent_tools` barrel, publishes `config/agent.ts`,
`config/mcp.ts`, and two migrations (the agent tables; a Postgres-only pgvector RAG chunk
table you can delete). Then add the model peer and write your config:

```bash
pnpm add ai zod @ai-sdk/openai
```

```ts
// config/agent.ts
import { defineConfig, stores, AuthActorResolver } from '@adonis-agora/agent'
import { aiSdkModel } from '@adonis-agora/agent/ai-sdk'
import { openai } from '@ai-sdk/openai'

export default defineConfig({
  // A lazy thunk keeps the provider SDK peer imported only at boot.
  model: () => aiSdkModel(openai('gpt-4o-mini')),

  store: 'lucid',
  stores: {
    memory: stores.memory(), // single-process; tests and scratch apps
    lucid: stores.lucid(),   // persists to SQL via @adonisjs/lucid
  },

  // Identity seam — fail-closed. Without a resolver every request throws → 401.
  actorResolver: new AuthActorResolver(),

  defaultAgent: {
    systemPrompt: 'You are a helpful assistant for our app.',
  },
})
```

Run the migration for the six agent tables (`agent_thread`, `agent_message`,
`agent_tool_call`, `agent_token_usage`, `agent_model_pricing`, plus the run-lifecycle
columns):

```bash
node ace migration:run
```

You can skip it: the Lucid store provisions its own tables on first use
(`autoCreateTables` defaults to true), and the published migration delegates to the same
`createAgentTables` helper, so the two schemas can never drift.

Source: `packages/adonis/docs/getting-started.mdx`,
`packages/adonis/docs/stores/lucid.mdx`.

## Core patterns

### Pattern 1 — enforce a daily spend budget with `quotas.ledger`

Quotas are **opt-in**: omitting `quota` disables budgeting entirely (fail-open).
Configuring one makes the gate fail-closed — `check()` runs before the first model call
and over-budget turns throw `QuotaExceededError` before any tokens are spent.

```ts
import { defineConfig, quotas } from '@adonis-agora/agent'

export default defineConfig({
  // ...
  quota: quotas.ledger({ limitTokens: 1_000_000 }), // enforced off the persisted usage ledger
})
```

`quotas.memory({ limitTokens })` is the single-process variant for tests. The `day`
(`YYYY-MM-DD`, UTC) is stamped once by the runner, so day-bucketing stays deterministic
under durable replay.

Source: `packages/adonis/docs/governance/quota-and-cost.mdx`.

### Pattern 2 — price turns with a `pricingStore` + `seedModelPrices`

With a Lucid main store, pricing mirrors the same connection automatically (table
auto-created) — no extra config. Cost per turn resolves in order: provider-reported
(a gateway) wins, else an estimate from the current price rows fetched once per run,
else `null` — never a fabricated `0`. Seed prices once (e.g. from an Ace command):

```ts
import db from '@adonisjs/lucid/services/db'
import { seedModelPrices, LucidPricingStore } from '@adonis-agora/agent'

const pricing = new LucidPricingStore(db.connection())
await seedModelPrices(pricing, [
  {
    modelId: 'gpt-4o-mini',
    inputPricePer1m: 0.15,
    outputPricePer1m: 0.6,
    cacheWritePricePer1m: 0.19, // optional — falls back to the input rate
    cacheReadPricePer1m: 0.015, // optional — falls back to the input rate
  },
])
```

Cache tokens are subsets of `inputTokens`, subtracted before the input rate applies.
Rollups (`spendByModel`/`spendByActor`) are sums, so an unpriced row contributes `$0.00`
even though the ledger row keeps `cost_usd: null` — if a total looks implausibly low,
check the pricing table first.

Source: `packages/adonis/docs/governance/quota-and-cost.mdx`,
`packages/adonis/src/spi/pricing-store.ts` (`seedModelPrices`, `estimateCost`).

### Pattern 3 — multi-replica SSE with `tokenSinks.redis`

The default sink buffers each run's stream in process memory, which is single-replica: a
run started on pod A can only be re-attached on pod A. Switching sinks keeps the whole
SSE envelope identical.

```ts
import { defineConfig, tokenSinks } from '@adonis-agora/agent'

export default defineConfig({
  // ...
  sink: tokenSinks.redis({ ttlSeconds: 3600 }), // replay keys self-expire (default 1h)
})
```

Requires `@adonisjs/redis` installed and configured unless you pass `client:` (a
bring-your-own `RedisStreamClient`). Pair with `durable: true` for cross-instance resume.

Source: `packages/adonis/src/stores/factory.ts` (`tokenSinks`),
`packages/adonis/docs/streaming-and-http.mdx` ("Single-replica by default" callout).

## Common mistakes

### HIGH — omitting `actorResolver` and shipping 401s everywhere

```ts
// Wrong — UnconfiguredActorResolver THROWS on every request; all routes answer 401.
export default defineConfig({ model: () => aiSdkModel(openai('gpt-4o-mini')) })
```

```ts
// Correct — read the authenticated principal; no identity is ever fabricated.
import { AuthActorResolver } from '@adonis-agora/agent'
export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  actorResolver: new AuthActorResolver(),
})
```

Mechanism: the provider installs `UnconfiguredActorResolver` by default, whose
`resolve()` unconditionally throws rather than invent a caller — the route replies 401
before the model ever runs.
Source: `packages/adonis/src/actor-resolver.ts` (`UnconfiguredActorResolver`),
`packages/adonis/docs/governance/authorization.mdx` ("No resolver, no service").

### MEDIUM — expecting quota enforcement after configuring only a store

```ts
// Wrong — no `quota` key means budgets are DISABLED (fail-open), even with a ledger full of usage.
export default defineConfig({ model, store: 'lucid', stores: { lucid: stores.lucid() } })
```

```ts
// Correct — opt in; the check then runs fail-closed before the first model call.
export default defineConfig({
  ...,
  quota: quotas.ledger({ limitTokens: 500_000 }),
})
```

Mechanism: the loop skips both `check` and `bump` entirely when `deps.quota` is
undefined — there is no implicit limit.
Source: `packages/adonis/docs/governance/quota-and-cost.mdx` ("Quota is opt-in, and off
means open"), `packages/adonis/src/agent-loop.ts` (`if (deps.quota !== undefined)`).

### HIGH — incrementing counters in a custom QuotaStore's `bump`

```ts
// Wrong — double-counts every turn when paired with the persisted usage ledger.
const store: QuotaStore = {
  async check(actorRef, day) { /* read my counter */ },
  async bump(actorRef, day, tokens) { await redis.incrBy(key, tokens) },
}
```

```ts
// Correct — a ledger-backed store leaves bump empty: recordUsage already wrote the tokens.
class LedgerQuota implements QuotaStore {
  async check(actorRef: string, day: string) { /* sum agent_token_usage */ }
  async bump(): Promise<void> {} // deliberate no-op — the ledger is the source of truth
}
```

Mechanism: `store.recordUsage(...)` has already persisted each turn's tokens;
`quotas.ledger.check` reads that ledger, so adding again in `bump` counts each turn twice.
Only a store keeping its OWN tally (`quotas.memory`, a bespoke Redis counter) should add.
Source: `packages/adonis/docs/governance/quota-and-cost.mdx` ("`bump` is a notification,
not necessarily an increment"), `packages/adonis/src/stores/ledger-quota.ts`.

### MEDIUM — reading `$0.00` rollups as "this model is free"

```ts
// Wrong — no prices seeded: usage rows persist costUsd null, but spendByModel sums them as 0.
await client.spendByModel({ fromDay: '2026-01-01', toDay: '2026-01-31' })
```

```ts
// Correct — seed current prices so estimates fold into costUsd.
await seedModelPrices(pricingStore, [{ modelId: 'gpt-4o-mini', inputPricePer1m: 0.15, outputPricePer1m: 0.6 }])
```

Mechanism: an unpriced turn is deliberately `null` ("unknown") in the ledger, but SUM
rollups cannot preserve null — every unpriced row adds `$0.00`, which reads exactly like
a free model. Per-run/per-usage rows keep their nulls.
Source: `packages/adonis/docs/governance/quota-and-cost.mdx` ("`null` in the ledger,
`0` in the rollups").

### MEDIUM — replacing the allowed attachment content types instead of extending

```ts
// Wrong — REPLACES the default list: png/jpeg/pdf/csv now get 415.
attachmentAllowedContentTypes: ['application/json']
```

```ts
// Types match EXACTLY (no wildcards); spread the defaults you still want.
attachmentAllowedContentTypes: [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
  'text/markdown', // your addition
],
```

Mechanism: passing `attachmentAllowedContentTypes` replaces the default list rather than
merging, and matching is exact — no `text/*` prefix rule — so anything absent is rejected
with 415.
Source: `packages/adonis/src/define_config.ts` (`AgentConfig.attachmentAllowedContentTypes`).

See also: `agent-tools/SKILL.md` — registering tools the model can actually call;
`agent-governance/SKILL.md` — what `AuthActorResolver` feeds into.
