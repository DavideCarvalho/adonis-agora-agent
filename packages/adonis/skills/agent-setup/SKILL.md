---
name: agent-setup
description: >-
  Set up @adonis-agora/agent in an AdonisJS app: node ace configure @adonis-agora/agent,
  defineConfig in config/agent.ts (model via aiSdkModel from @adonis-agora/agent/ai-sdk,
  stores.lucid()/stores.memory(), quota: { limits }, pricingStores +
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
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/react.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/react/index.ts"
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

  // Identity. Omitted → endpoints PUBLIC, one anonymous actor per browser (HttpOnly cookie).
  // This line requires login instead (ctx.auth.user; 401 without).
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

You can skip it: the Lucid store provisions and repairs its own tables as the app starts
(`autoCreateTables` defaults to true; an ace command or a hand-built store does it on first
use), so an upgrade that adds a column needs no app migration. The published migration
delegates to the same `createAgentTables` helper, so the two schemas can never drift.
Only with `autoCreateTables: false` does an upgrade need a migration that calls
`createAgentTables` again.

Source: `packages/adonis/docs/getting-started.mdx`,
`packages/adonis/docs/stores/lucid.mdx`.

## Core patterns

### Pattern 1 — set a budget with `quota: { limits }`

Budgets are **opt-in**: omitting `quota` means usage is reported (`GET /agent/quota`) but
never enforced. With limits, a send while a window is exhausted is refused with `429`
`{ code: 'quota_exceeded', period }` before the turn starts — no tokens spent.

```ts
export default defineConfig({
  // ...
  quota: { limits: { day: { tokens: 200_000 }, month: { usd: 20 } } },
})
```

Spend (`usd`) is the provider-reported cost the ledger recorded. A budget of your own is a
`QuotaProvider` (`report({ actor })`) passed as `quota`. `quotas.ledger` / `quotas.memory`,
`LedgerQuotaStore` and `GET /agent/quota/today` were removed in 0.46.

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

Or fill the table from the open [models.dev](https://models.dev) catalog instead of
hand-copying rates — `<provider>/<model>` is required, and a model missing from the
catalog throws rather than being skipped:

```ts
import { seedPricesFromModelsDev } from '@adonis-agora/agent'

await seedPricesFromModelsDev(pricing, ['openai/gpt-4o-mini'])
```

Price the model under the id the provider **publishes** (`gpt-4o-mini`), not the dated
snapshot it answers with (`gpt-4o-mini-2024-07-18`). The ledger records the reported id,
and the fold resolves it back down to the alias — exact id first, then route prefix, then
a trailing date suffix. Only date-shaped suffixes are stripped: a `-002` could be a
different model at a different price, so it stays unpriced and stays visible.

Cache tokens are subsets of `inputTokens`, subtracted before the input rate applies.
Rollups (`spendByModel`/`spendByActor`) are sums, so an unpriced row contributes `$0.00`
even though the ledger row keeps `cost_usd: null` — if a total looks implausibly low,
check the pricing table first.

Source: `packages/adonis/docs/governance/quota-and-cost.mdx`,
`packages/adonis/src/spi/pricing-store.ts` (`seedModelPrices`, `estimateCost`,
`resolveModelPrice`), `packages/adonis/src/pricing/models-dev.ts`.

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

### Pattern 4 — a React chat with `@adonis-agora/agent/react`

The React layer is `@dudousxd/nestjs-agent-react` re-exported (an optional peer — install it with
`@ai-sdk/react` and `ai`), plus an `AgentProvider` that already sends the session cookie and
shield's CSRF token. No controller, no fetch code:

```tsx
import { AgentProvider, useAgentChat } from '@adonis-agora/agent/react'

export default function ChatPage() {
  return (
    <AgentProvider>
      <Chat />
    </AgentProvider>
  )
}

function Chat() {
  const { transcript, composer, queue } = useAgentChat({ threadId, agent: 'support' })
  // transcript.items[].blocks — text / tools (approvals) / elicitation / ui
  // queue.items — messages sent while a turn was running, waiting server-side
  // composer.text / setText / submit() / canSend / files
}
```

`useAgentChat({ threadId })` loads the thread and re-attaches to a turn still streaming on it. A send
made mid-turn is queued (`whileRunning: 'block'` to refuse instead). `path` on the provider must
match `config/agent.ts`'s `path`.

## Common mistakes

### HIGH — calling `useAgentChat()` outside `<AgentProvider>`

```tsx
// Wrong — falls back to a bare client with no CSRF header: shield answers every POST with 403.
function Chat() { const chat = useAgentChat() }  // no provider above

// Correct — the provider reads XSRF-TOKEN (or <meta name="csrf-token">) per request.
<AgentProvider><Chat /></AgentProvider>
```

Outside React, `createAgentClient()` from the same entry builds the client with the same defaults.

### HIGH — omitting `actorResolver` in an app that has logins

```ts
// Wrong for an app with users — no resolver means the endpoints are PUBLIC: every browser
// is its own anonymous actor (anon:<sha256 of an HttpOnly cookie>), and your users'
// threads are not tied to their accounts.
export default defineConfig({ model: () => aiSdkModel(openai('gpt-4o-mini')) })
```

```ts
// Correct — one line requires login (reads ctx.auth.user; 401 without).
import { AuthActorResolver } from '@adonis-agora/agent'
export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  actorResolver: new AuthActorResolver(),
})
```

Mechanism: with no resolver the provider installs `AnonymousActorResolver` and logs a boot
notice that the endpoints are public. Right for a free public chat (set a `quota` there);
wrong for an app whose users log in.
Source: `packages/adonis/src/anonymous-actor-resolver.ts`,
`packages/adonis/docs/governance/authorization.mdx` ("No resolver: the endpoints are public").

### MEDIUM — shipping a public (anonymous) chat without a budget

```ts
// Wrong — no actorResolver (public) and no quota: model spend is unbounded.
export default defineConfig({ model })
```

```ts
// Correct — limits apply per actor, i.e. per browser in anonymous mode.
export default defineConfig({ model, quota: { limits: { day: { tokens: 50_000 } } } })
```

Mechanism: without `quota`, `GET /agent/quota` reports usage off the ledger but nothing
gates a send. With it, the chat route checks the report before starting the turn.
Source: `packages/adonis/docs/governance/quota-and-cost.mdx` ("Budgets").

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

### HIGH — sending attachment objects instead of `{ mediaId }` refs

```ts
// Wrong — 400: a send names uploads by id only; a url from the client is never trusted.
{ message, attachments: [{ mediaId, url, contentType, name }] }
```

```ts
// Correct — the configured store (attachments: attachmentStores.media()) resolves the url.
{ message, attachments: [{ mediaId }] }
```

Mechanism: the chat route refuses any key besides `mediaId`, then resolves each id through
`AttachmentStagingStore.resolve({ mediaId, actor })` (`403` for another actor's upload).
Limits come from the store (`attachmentStores.media({ maxBytes, allowedContentTypes })`);
`allowedContentTypes` replaces the default list and matches exactly.
Source: `packages/adonis/docs/authoring/attachments.mdx`.

See also: `agent-tools/SKILL.md` — registering tools the model can actually call;
`agent-governance/SKILL.md` — what `AuthActorResolver` feeds into.
