---
name: agent-tools
description: >-
  Author and register governed tools for @adonis-agora/agent: @AiTool decorated classes,
  BaseTool/ReadTool/ActionTool static-tool subclasses, defineTool functional tools,
  discovery from app/agent_tools via the .adonisjs/agent/tools.js barrel (toolsHook with
  source/importAlias/output) vs the runtime scan fallback, Standard Schema inputs
  (Zod/Valibot/ArkType), AiToolCtx actor scoping, constructor DI (@inject, lazy + cached),
  roles/ability fail-closed gating under defaultRoles, and the dataTool governed read-only
  SQL satellite. Use for "write a tool", "my tool is never called", "tool forbidden",
  "agent_tools barrel not generating", or "let the agent query the database".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "0.25.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/authoring/tools.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/authoring/data-satellite.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/ai-tool-ref.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/tool-discovery.ts"
---

# Writing governed tools for @adonis-agora/agent

A tool is a named capability with a typed input schema; the model decides *when* to call
it, the loop decides *whether it may* (role gate) and *how* (auto-execute vs human
approval). `read` auto-executes, `action` pauses for HITL approval. There are two ways to
author one — a class or a function — and both register the same way.

## Setup

Create `app/agent_tools/get_weather.ts`. The Assembler init hook registered by
`node ace configure @adonis-agora/agent` generates the `.adonisjs/agent/tools.js` barrel
at build/dev time, and the provider registers every export at boot:

```ts
// app/agent_tools/get_weather.ts
import { z } from 'zod'
import { ReadTool } from '@adonis-agora/agent'
import type { AiToolCtx } from '@adonis-agora/agent'

const input = z.object({ city: z.string() })
type Input = z.infer<typeof input>

export default class GetWeather extends ReadTool<Input, { tempC: number }> {
  // No `kind` — the base pins 'read'. Type-checks bare, no satisfies needed.
  static tool = {
    name: 'get_weather',
    description: 'Current weather for a city.',
    input,
    roles: ['MEMBER'], // omit → config.defaultRoles (['ADMIN'] by default)
  }

  async execute({ city }: Input, _ctx: AiToolCtx) {
    return { tempC: 21 }
  }
}
```

Prefer a function? `defineTool(options, execute)` returns a branded `{ spec, handler }`
discovery picks up identically — or pass it straight to `defineConfig({ tools: [...] })`.

## Core patterns

### Pattern 1 — mutating tools as `ActionTool` (HITL approval)

`kind: 'action'` records the call `pending_approval` and suspends the run until a client
posts approve/reject to `/agent/tool-call/approve|reject`. Dependencies come from the IoC
container — declare them in the constructor with `@inject()`:

```ts
// app/agent_tools/purge_cache.ts
import { inject } from '@adonisjs/core'
import { z } from 'zod'
import { ActionTool } from '@adonis-agora/agent'
import type { AiToolCtx } from '@adonis-agora/agent'

const input = z.object({ key: z.string() })
type Input = z.infer<typeof input>

@inject()
export default class PurgeCache extends ActionTool<Input, { purged: string }> {
  constructor(private readonly cache: CacheService) {
    super()
  }

  static tool = {
    name: 'purge_cache',
    description: 'Purge one cache key.',
    input,
    ability: 'cache.purge', // consumed by an ability-aware RolesPolicy (authz adapter)
  }

  async execute({ key }: Input, _ctx: AiToolCtx) {
    await this.cache.forget(key)
    return { purged: key }
  }
}
```

Class tools resolve lazily through the container on first invocation, then cached — so a
constructor needing a peer service fails nothing at boot.

Source: `packages/adonis/docs/authoring/tools.mdx` ("Constructor DI").

### Pattern 2 — let the agent query SQL with `dataTool` (fail-closed)

`dataTool` validates a single SELECT, enforces a REQUIRED role→group→table allow-list
(there is no allow-all), rewrites in an optional tenant scope, injects LIMIT, and
truncates oversized results before they hit the model's context:

```ts
// config/agent.ts
import { defineConfig, dataTool } from '@adonis-agora/agent'
import db from '@adonisjs/lucid/services/db'

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  tools: [
    dataTool({
      db: db.connection('readonly'),          // point at a read-only replica
      tableAccess: {                          // REQUIRED — fail-closed, no implicit allow-all
        roleGroups: { MEMBER: ['sales'], ADMIN: ['sales', 'ops'] },
        tablesByGroup: { sales: ['orders', 'products'], ops: ['audit_log'] },
      },
      tenant: { tenantColumn: 'tenant_id', scopedTables: ['orders'] },
      maxRows: 100,                           // LIMIT injected when the query has none
    }),
  ],
})
```

The model sees a tool named `executeSql` taking `{ sql: string }`. Two governance layers
stack: `roles`/`ability` gate whether the tool may be called at all; `tableAccess` +
`tenant` gate what a permitted call may read.

Source: `packages/adonis/docs/authoring/data-satellite.mdx`.

### Pattern 3 — move the scan directory with `toolsHook`

To keep tools in a shared package or differently-named directory, call the hook factory
yourself in `adonisrc.ts`:

```ts
// adonisrc.ts
import { defineConfig } from '@adonisjs/core'
import { toolsHook } from '@adonis-agora/agent/hooks/tools'

export default defineConfig({
  hooks: {
    init: [
      async () => ({
        default: toolsHook({ source: 'app/ai/tools', importAlias: '#ai_tools' }),
      }),
    ],
  },
})
```

Change `source` and `importAlias` together; leave `output` alone (default
`.adonisjs/agent/tools.ts`) — moving the output makes the provider silently fall back to
the runtime scan you were replacing.

Source: `packages/adonis/docs/authoring/tools.mdx` ("Configuring the generator"),
`packages/adonis/src/hooks/tools.ts` (`ToolsHookOptions`).

## Common mistakes

### CRITICAL — shipping tools without `roles` and calling them unreachable

```ts
// Wrong — no roles → inherits defaultRoles ['ADMIN']; MEMBER actors never see this tool.
static tool = { name: 'get_order', description: '...', input }
```

```ts
// Correct — declare who may invoke.
static tool = { name: 'get_order', description: '...', input, roles: ['MEMBER'] }
```

Mechanism: `definitionsFor` filters the offered tool list through the role gate BEFORE
each model turn, so a tool the actor cannot invoke is never described to the model — it
cannot call what it was never shown. This is why "the model didn't call my tool" is
usually an authorization default, not a prompt problem.
Source: `packages/adonis/docs/authoring/tools.mdx` (fail-closed callout),
`packages/adonis/src/tool-registry.ts` (`DefaultRolesPolicy.can`).

### HIGH — trusting an id from the model's arguments instead of `ctx.actor`

```ts
// Wrong — the MODEL chose this customerId; any caller can read anyone's orders.
async execute({ customerId }: Input) {
  return Order.query().where('customer_id', customerId)
}
```

```ts
// Correct — scope to the acting identity the resolver authenticated.
async execute(_input: Input, ctx: AiToolCtx) {
  return Order.query().where('customer_ref', ctx.actor.id)
}
```

Mechanism: tool arguments are untrusted model output; identity is single-sourced on
`ctx.actor` (`id`, `roles`, `tenantRef`) populated from the server-side actor resolver.
Source: `packages/adonis/docs/authoring/tools.mdx` ("The tool context"),
`packages/adonis/src/spi/tool.ts`.

### MEDIUM — renaming the generated barrel's output path

```ts
// Wrong — the provider imports .adonisjs/agent/tools.js; elsewhere = silently ignored.
toolsHook({ source: 'app/ai/tools', importAlias: '#ai_tools', output: '.adonisjs/mytools.ts' })
```

```ts
// Correct — change source + importAlias together; leave output at its default.
toolsHook({ source: 'app/ai/tools', importAlias: '#ai_tools' })
```

Mechanism: the provider imports the compiled barrel from the fixed
`.adonisjs/agent/tools.js`; a moved file is absent there, so boot falls back to scanning
`app/agent_tools` — which no longer holds your tools — and the agent runs with none of
them, logging only a quiet fallback.
Source: `packages/adonis/docs/authoring/tools.mdx` ("Point `output` elsewhere…"),
`packages/adonis/src/hooks/tools.ts` (`GENERATED_TOOLS_OUTPUT`).

### MEDIUM — debugging "zero tools" after adding one that throws on import

```ts
// Wrong assumption — a throwing tool file aborts discovery, so NOTHING registers.
// app/agent_tools/broken.ts references a service whose `app` is undefined during boot.
```

```ts
// Correct mental model — the bad file is skipped loudly; every OTHER tool still registers.
// Fix the import error surfaced in the logs; the rest of agent_tools keeps working meanwhile.
```

Mechanism: `discoverTools` wraps each dynamic import in its own try/catch, logs the
failure, and continues — so the symptom is one missing tool (the model narrating calls it
was never given), not a dead registry.
Source: `packages/adonis/src/tool-discovery.ts` (`discoverTools` import try/catch and log
message).

### LOW — declaring `kind` on a ReadTool/ActionTool subclass

```ts
// Wrong — the base already pins kind; the literal widens and fights the inherited static type.
export default class CloseTicket extends ActionTool<Input, Row> {
  static tool = { name: 'close_ticket', kind: 'action', description: '...', input }
}
```

```ts
// Correct — truly bare static; the base carries kind.
export default class CloseTicket extends ActionTool<Input, Row> {
  static tool = { name: 'close_ticket', description: '...', input }
}
```

Mechanism: `ReadTool`/`ActionTool` pin `static readonly kind`; redeclaring it adds a union
field the inherited `static tool?: BaseToolOptions` doesn't contextualize, so the literal's
`kind: string` widens and type-checking degrades instead of failing.
Source: `packages/adonis/src/base-tool.ts` (`BaseToolOptions`, kind-specific bases),
`packages/adonis/docs/authoring/tools.mdx` ("truly bare").

See also: `agent-governance/SKILL.md` — swapping `rolesPolicy` for ability checks;
`agent-personas-agents/SKILL.md` — narrowing tools per persona/agent.
