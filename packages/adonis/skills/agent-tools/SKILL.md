---
name: agent-tools
description: >-
  Author and register governed tools for @adonis-agora/agent: @AiTool decorated classes,
  BaseTool/ReadTool/ActionTool static-tool subclasses, defineTool functional tools,
  discovery from app/agent_tools via the .adonisjs/agent/tools.js barrel (toolsHook with
  source/importAlias/output) vs the runtime scan fallback, Standard Schema inputs
  (Zod/Valibot/ArkType), AiToolCtx actor scoping, constructor DI (@inject, lazy + cached),
  roles/ability gating under defaultRoles (open by default), and the dataTool governed read-only
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
  - "DavideCarvalho/adonis-agent:packages/adonis/src/confirmed-tool.ts"
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
    roles: ['MEMBER'], // omit → config.defaultRoles ([] — open — by default)
  }

  async execute({ city }: Input, _ctx: AiToolCtx) {
    return { tempC: 21 }
  }
}
```

Prefer a function? `defineTool({ name, input, execute, present, ... })` or the existing
`defineTool(options, execute)` returns a branded `{ spec, handler }`
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

An action's write and the checkpoint that records it are two writes: a worker that dies between
them re-runs the tool on recovery. Pass `ctx.idempotencyKey` (`<runId>:<toolCallId>`, the same for
every execution of one call) on as the downstream idempotency key — a provider's
`Idempotency-Key`, a unique column on the inserted row, the `id` of a workflow the tool starts — so
the second attempt lands on the first. It is absent outside a turn (MCP, a direct
`registry.invoke`), so fall back to a key of your own there.

Source: `packages/adonis/src/spi/tool.ts` (`AiToolCtx.idempotencyKey`).

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

### Pattern 4 — a write reachable over MCP: `defineConfirmedTool`

An `action` never reaches an MCP client (no approval channel, and Claude.ai/Desktop have no
elicitation). For a write that must be callable there, put the gate inside the tool: the
first call previews and returns a signed `confirmToken`; the same arguments plus
`confirm: true` and the token commit.

```ts
import { defineConfirmedTool, LucidConfirmTokenStore } from '@adonis-agora/agent'

export const refundOrder = defineConfirmedTool(
  {
    name: 'refund_order',
    description: 'Refund an order. Returns a preview first; confirm to commit.',
    input: z.object({ orderId: z.string() }), // confirm / confirmToken are added for you
    roles: ['ADMIN'],
    secret: () => env.get('APP_KEY').release(), // required, no default
    store: new LucidConfirmTokenStore(db), // without it the token is NOT single use
  },
  {
    prepare: async ({ orderId }, ctx) => loadRefundableOrder(orderId, ctx.actor), // throw to refuse
    preview: (order) => ({ summary: `Refund ${order.total}?`, data: order }), // writes nothing
    commit: async (order) => ({ summary: 'Refunded.', data: await refund(order) }),
  },
)
```

`prepare` runs on the preview and again on the confirmation — put every rule the commit
relies on there. The token is bound to tool + `ctx.actor.id` + `ctx.actor.tenantRef` +
arguments and expires (`ttlMs`, default 15 min).

Source: `packages/adonis/docs/mcp.mdx` ("Writes with a human gate"),
`packages/adonis/src/confirmed-tool.ts`.

### Pattern 5 — present a domain result through the component catalog

Keep `execute` returning domain data. An optional `present(output, ctx)` on a class or
functional handler returns one component presentation, an array, or `undefined`. The
registry emits presentations through `ctx.emitUi` and preserves the domain result for
REST/MCP callers. Denied or failed execution does not present; presentation errors do
not retry a successful write. Methods keep their receiver, including injected services.

```ts
import { defineTool } from '@adonis-agora/agent'
import { table } from '@adonis-agora/agent/genui'
import { z } from 'zod'

export const listRecords = defineTool({
  name: 'list_records',
  description: 'List records visible to the current actor.',
  input: z.object({ limit: z.number().int().min(1).max(100) }),
  execute: async ({ limit }, ctx) => recordsFor(ctx.actor, limit),
  present: async (records) => table({
    columns: [{ key: 'name', label: 'Name' }],
    rows: records,
  }),
})
```

Use `createComponent` for custom definitions and one `createComponentRegistry` per app
or tenant. Input `props` may transform; if the transform changes shape or is not
idempotent, declare `outputProps` to validate the normalized JSON persisted in frames.
Do not send renderer functions or image/PDF bytes as props. Set `onPresentationError(error,
{ toolName, toolCallId, runId, threadId })` in `defineConfig` — it is wired for turns
and proposal executions (the loop/executor fill in the call, run and thread); omit it
and the provider logs a warning on the app logger. Inside a tool,
`ctx.onPresentationError` carries the same details. SSR and capture use optional server entries,
separate from tool execution and browser chat hooks.

Source: `packages/adonis/docs/authoring/component-rendering.mdx`,
`packages/adonis/src/spi/tool.ts`, `packages/adonis/src/tool-result-presentation.ts`.

## Feature flags and per-user gates — `enabled`, `isEnabled()`, `canUse(actor)`

```ts
// A flag with no service behind it: on the options (boolean, or a predicate re-read every turn).
static tool = { name: 'search_docs', description: '...', input, enabled: () => env.get('DOCS') === true }

// A flag or entitlement that needs a service: methods on the (container-resolved) class.
isEnabled() { return this.flags.on('docs') }
canUse(actor: Actor) { return this.plans.includesDocs(actor.tenantRef) }
```

`defineTool` / `defineConfirmedTool` take `enabled` and `canUse` as options; `mcpServers[]`
takes both per server. Order on the offered list AND on invoke: allow-list → `enabled` →
`RolesPolicy` → `canUse`; none can widen. A disabled tool is never shown to the model and
invoking one throws `ToolDisabledError` (not `ToolForbiddenError`). Prefer these to registering a
tool conditionally, and to refusing inside `execute` (which costs the model a turn).
Source: `packages/adonis/docs/authoring/tools.mdx`, `packages/adonis/src/tool-filters.ts`.

## Common mistakes

### CRITICAL — shipping a privileged tool without `roles`

```ts
// Wrong — no roles → inherits defaultRoles, which is [] (open) by default: every actor,
// an anonymous visitor included, is offered this tool.
static tool = { name: 'refund_order', kind: 'action', description: '...', input }
```

```ts
// Correct — declare who may invoke (or set defaultRoles: ['ADMIN'] to close every tool by default).
static tool = { name: 'refund_order', kind: 'action', description: '...', input, roles: ['ADMIN'] }
```

Mechanism: `definitionsFor` filters the offered tool list through the role gate BEFORE
each model turn, and `invoke` re-checks it. A tool with no `roles` takes `defaultRoles`;
an empty list is no restriction (since 0.46 — before, it denied everyone; `emptyRoles: 'deny'`
in the config, or `ClosedRolesPolicy`, keeps it closed). An `action` still parks on approval — but by default the
requester approves, so for a public chat that is only a confirmation.
Source: `packages/adonis/docs/governance/authorization.mdx`,
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
