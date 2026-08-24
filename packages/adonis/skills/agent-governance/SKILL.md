---
name: agent-governance
description: >-
  Lock down @adonis-agora/agent: the ActorResolver identity seam (AuthActorResolver over
  ctx.auth.user with toActor mapper, HeaderActorResolver x-actor-id/x-actor-role behind a
  gateway, UnconfiguredActorResolver throwing default), DefaultToolAuthorizer role
  intersection with the offered-tools + invoke-time double check, object-level ownership
  via evaluateOwnership (404 for unknown ids), governanceAuthorize mounting semantics for
  /agent/governance/* (404 without it) and the dashboard mount refusals,
  evaluateGovernanceGate fail-closed behavior, and GET /agent/approvals/mine exemption.
  Use for "tool forbidden", "governance routes 404", "dashboard won't mount", "IDOR /
  cross-actor access", "swap roles for ability checks".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "0.25.2"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/governance/authorization.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/governance/dashboard.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/governance-gate.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/ownership.ts"
---

# Governance: identity, authorization, ownership

Authorization in `@adonis-agora/agent` is fail-closed at three layers: **who is calling**
(an `ActorResolver` that never fabricates an identity), **what they may do** (a
`RolesPolicy` checked twice — before the model sees a tool and again at invoke time),
and **which records they may address** (object-level ownership on every run/thread route).

## Setup

Wire identity once; everything downstream keys off it:

```ts
// config/agent.ts
import { defineConfig, AuthActorResolver } from '@adonis-agora/agent'

export default defineConfig({
  model: () => aiSdkModel(openai('gpt-4o-mini')),
  // Reads ctx.auth.user (populated by @adonisjs/auth). Throws when unauthenticated —
  // no identity is ever invented. Map non-standard user shapes with toActor.
  actorResolver: new AuthActorResolver({
    toActor: (user) => ({
      id: String(user.id),
      roles: user.roleNames,     // e.g. pulled from a relation
      tenantRef: user.tenantId,
    }),
  }),
  defaultRoles: ['STAFF'],       // roles a tool requires when it declares none
})
```

## Core patterns

### Pattern 1 — swap role checks for ability checks

`roles` and `ability` share one seam. The default policy intersects roles; an
ability-aware policy (the `@adonis-agora/authz` Bouncer adapter, `authzToolAuthorizer`)
consults each tool's `ability` instead — tenant-scoped and fail-closed. Swap only the
binding; tools keep both annotations:

```ts
// config/agent.ts
import { defineConfig } from '@adonis-agora/agent'
import { authzToolAuthorizer } from '@adonis-agora/agent/authz'

export default defineConfig({
  // ...
  authorizer: authzToolAuthorizer, // alias: rolesPolicy — one seam, both filter layers follow
})
```

Because the offered-tools filter AND the invoke-time re-check call the same
`can(actor, tool)`, swapping the policy changes both layers together — they can never
disagree about what an actor may reach.

Source: `packages/adonis/docs/governance/authorization.mdx` ("Ability-aware
authorization"), `packages/adonis/src/authorizer.ts`.

### Pattern 2 — mount the governance read-model with `governanceAuthorize`

The cross-actor `/agent/governance/*` read routes exist ONLY when a gate is configured.
Omit it and every one of those paths answers 404 — by design, so an ungated read-model of
every actor's spend/threads/approvals can never be served by accident:

```ts
// config/agent.ts — typically an ADMIN check; runs AFTER the actor resolves.
export default defineConfig({
  // ...
  governanceAuthorize: (actor, _ctx) => actor.roles?.includes('ADMIN') ?? false,
})
```

`evaluateGovernanceGate` applies it fail-closed: falsy → 403, thrown → 403 (message shown
only outside production). The SAME predicate feeds object-level ownership's `privileged`
flag, and the dashboard console refuses to mount without it.

Source: `packages/adonis/docs/governance/authorization.mdx` ("Governance route
authorization"), `packages/adonis/src/governance-gate.ts`.

### Pattern 3 — unit-test your gates router-free

Both decision cores are exported pure functions, so you can test them without booting an
app:

```ts
import { evaluateOwnership, evaluateGovernanceGate } from '@adonis-agora/agent'

evaluateOwnership('u_1', 'u_1', false) // → { ok: true,  status: 200 }  owner
evaluateOwnership('u_2', 'u_1', false) // → { ok: false, status: 403 }  not owner
evaluateOwnership('u_2', null, false)  // → { ok: false, status: 404 }  unknown id
evaluateOwnership('u_2', 'u_1', true)  // → { ok: true,  status: 200 }  privileged

const verdict = await evaluateGovernanceGate(actor, ctx, config.governanceAuthorize, !app.inProduction)
if (!verdict.ok) return ctx.response.status(verdict.status).json({ error: verdict.error })
```

Unknown ids deliberately reply 404, never 403, so a response never confirms to a caller
that an id they don't own exists.

Source: `packages/adonis/docs/governance/authorization.mdx` ("Object-level ownership"),
`packages/adonis/src/ownership.ts`.

## Common mistakes

### CRITICAL — assuming `HeaderActorResolver` is production-safe

```ts
// Wrong — anyone can send x-actor-id: u_admin and become admin unless a gateway strips these.
actorResolver: new HeaderActorResolver()
```

```ts
// Correct — read a VERIFIED principal in production; headers are for dev/gateway use only.
actorResolver: new AuthActorResolver()
```

Mechanism: `HeaderActorResolver` trusts client-sent `x-actor-id` / `x-actor-role` /
`x-tenant-ref`; it is safe only behind a gateway that strips and re-sets them from an
authenticated principal. It does throw when `x-actor-id` is missing, but any caller who
sets the header IS that actor.
Source: `packages/adonis/src/actor-resolver.ts` (`HeaderActorResolver` security note),
`packages/adonis/docs/governance/authorization.mdx`.

### HIGH — expecting `/agent/governance/*` to exist after configuring only `governanceQueries`

```ts
// Wrong — read-model resolves, but no gate → the 11 governance routes are NEVER mounted (all 404).
export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid() } })
```

```ts
// Correct — set the gate to mount them (gated); or explicitly opt into open reads.
export default defineConfig({
  ...,
  governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
  // governanceAuthorize: () => true, // deliberate legacy behaviour: ANY authenticated actor reads
})
```

Mechanism: mounting is conditional on the gate because the data is cross-actor; a boot
warning names both ways forward when the read-model resolved without a gate. Note
`GET /agent/approvals/mine` is exempt — always mounted when the read-model resolves, and
always scoped to the calling actor.
Source: `packages/adonis/src/define_config.ts` (`AgentConfig.governanceAuthorize`),
`packages/adonis/docs/streaming-and-http.mdx` ("Five optional surfaces").

### HIGH — treating `dashboard.authorize` as the dashboard's data gate

```ts
// Wrong — authorize gates only the SPA shell; panels still 403/404 without governanceAuthorize.
dashboard: { enabled: true, authorize: (actor) => actor.roles?.includes('ADMIN') ?? false }
```

```ts
// Correct — one predicate shape on BOTH knobs: shell gate + data gate.
governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
dashboard: { enabled: true, authorize: (actor) => actor.roles?.includes('ADMIN') ?? false },
```

Mechanism: the console is a pure consumer of `/agent/governance/*`; `authorize` decides
who may load the shell while `governanceAuthorize` decides whether the console mounts at
all and whether its data routes answer. With no gate the provider logs a boot warning and
refuses to mount rather than serve seven dead panels.
Source: `packages/adonis/src/dashboard/define_config.ts` (`decideDashboardMount`,
`NO_GOVERNANCE_GATE_WARNING`).

### MEDIUM — giving a per-agent resolver a different identity than the global one

```ts
// Wrong — webhook agents resolve actor 'body:svc-1'; the global resolver would say 'user_9'.
agents: [{ name: 'webhook', actorResolver: new BodyActorResolver() }]
```

```ts
// Correct — a per-agent resolver must yield an id the GLOBAL resolver could also produce.
agents: [
  {
    name: 'webhook',
    actorResolver: new AuthActorResolver({ toActor: mapServicePrincipal }), // same id space
  },
]
```

Mechanism: the override applies ONLY to `POST /agent/chat`; stream re-attach, cancel,
approve/reject, threads, quota, and all governance routes resolve the GLOBAL resolver —
a mismatched `actor.id` means the caller starts a run it cannot stream, cancel, or
approve (ownership compares ids).
Source: `packages/adonis/docs/authoring/personas-and-agents.mdx` ("The override applies
to POST /agent/chat only").

### MEDIUM — designing a client around a thrown gate's message

```ts
// Wrong — reading error.message from a 403 to branch UI logic; prod never carries it.
if (err.message.includes('missing tenant')) showTenantPicker()
```

```ts
// Correct — treat 403 as opaque; debug details exist only outside production.
if (err.status === 403) showForbidden() // body is exactly { "error": "forbidden" } in prod
```

Mechanism: `evaluateGovernanceGate` passes the thrown message through only when `debug`
is true (the provider passes `!app.inProduction`); in production the body is the generic
string, because authorization predicates routinely throw with sensitive detail.
Source: `packages/adonis/src/governance-gate.ts`, `packages/adonis/docs/governance/authorization.mdx`
("A thrown message never reaches production clients").

See also: `agent-setup/SKILL.md` — wiring `AuthActorResolver` at setup time;
`agent-console-client/SKILL.md` — how the console consumes these gated routes.
