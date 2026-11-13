---
name: agent-governance
description: >-
  Lock down @adonis-agora/agent: the ActorResolver identity seam (AuthActorResolver over
  ctx.auth.user with toActor mapper, HeaderActorResolver x-actor-id/x-actor-role behind a
  gateway, AnonymousActorResolver public default — one anonymous actor per browser), DefaultToolAuthorizer role
  intersection with the offered-tools + invoke-time double check, object-level ownership
  via evaluateOwnership (404 for unknown ids), the one dashboard.authorize that gates the
  console AND /agent/governance/* (open outside production, 403 in production when omitted),
  authorizeByToken for machine access, evaluateGovernanceGate fail-closed behavior, and the
  GET /agent/approvals/mine exemption. Use for "tool forbidden", "governance routes 403",
  "governanceAuthorize removed", "IDOR / cross-actor access", "swap roles for ability checks".
metadata:
  type: core
  library: "@adonis-agora/agent"
  library_version: "1.0.0-rc.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/governance/authorization.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/governance/dashboard.mdx"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/governance-gate.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/src/ownership.ts"
  - "DavideCarvalho/adonis-agent:packages/adonis/docs/cli.mdx"
---

# Governance: identity, authorization, ownership

Authorization in `@adonis-agora/agent` works at three layers: **who is calling**
(an `ActorResolver` — anonymous per browser when none is configured, `AuthActorResolver` to
require login), **what they may do** (a
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
  // emptyRoles: 'deny',         // an empty roles list reaches nobody (default 'allow': open since 0.46)
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

Because the offered-tools filter calls `canOffer(actor, tool)` when the policy defines
it (else `can`) and the invoke-time re-check always calls `can(actor, tool)`, swapping
the policy changes both layers together — they disagree only when a policy defines
`canOffer` to offer what it will not run (A2A step-up).

The provider wraps whatever policy you configure with `personalAgentGate`: an actor with
the `personal_agent` role (personal agents over A2A/PACT or Poppy conversations) reaches only tools that declare one of its
roles — a tool with no `roles` is out of its reach even when open by default — and its
memory and skill scopes resolve to none. Nothing changes for any other actor.
Both personal-agent surfaces build that actor the same way: `personal_agent` plus one
`scope:<id>` role per granted scope — a PACT delegation's scopes (`a2a_provider`) or a
signed-in Poppy access token's (`poppy_provider`: `scope:orders:read`, `scope:orders:write`,
custom scopes). A tool behind a missing scope is offered, not run; the refused call is the
step-up (A2A: an `AUTH_REQUIRED` task; Poppy: an `authorization` event).

> **Experimental:** Poppy (Personal Agent Protocol) is a Draft 0.3 spec still in development
> (https://personalagentprotocol.org/docs/spec). The Poppy surface implements Draft 0.3 and WILL change
> as the spec evolves — possibly breaking, outside semver majors while it is a draft.


Source: `packages/adonis/docs/governance/authorization.mdx` ("Ability-aware
authorization"), `packages/adonis/src/authorizer.ts`,
`packages/adonis/src/a2a/gate.ts` (`personalAgentGate`, `personalAgentScopes`),
`packages/adonis/docs/a2a.mdx` ("What a personal agent can reach"),
`packages/adonis/docs/poppy.mdx` ("Scopes, sign-in and actions").

### Pattern 2 — gate the console and `/agent/governance/*` with `dashboard.authorize`

One option gates both the console page and the cross-actor `/agent/governance/*` read routes
(and, when set, grants cross-actor privilege on run/thread routes — still only inside the
request's organization when tenancy is on, where another organization's thread or run answers
404). `governanceAuthorize` no
longer exists. Omitted: open outside production, `403` on every request in production, with
one boot warning. With tenancy on, the console reads only the viewer's organization unless
`authorize` returns `{ allowed: true, tenants: '*' | string[] }`.

```ts
// config/agent.ts — ctx first; the resolved actor is an optional 2nd argument.
import { authorizeByRoles } from '@adonis-agora/authz'

export default defineConfig({
  // ...
  dashboard: { authorize: authorizeByRoles({ roles: ['ADMIN'], loginPath: '/login' }) },
  // dashboard: { authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false },
  // dashboard: { authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }) }, // machine access
})
```

Denials: `false`/`{ allowed: false }`/throw → 403 `{ error: 'forbidden' }`; `reason:
'unauthenticated'` → 401 `{ error: 'unauthenticated' }`; `{ redirectTo }` → 302 for a page
navigation, 401 JSON with `redirectTo` for an API call. A thrown message is a `detail` only
outside production.

Source: `packages/adonis/docs/governance/authorization.mdx` ("Governance route
authorization"), `packages/adonis/docs/governance/dashboard.mdx` ("Access"),
`packages/adonis/src/dashboard/gate.ts`.

### Pattern 3 — unit-test your gates router-free

Both decision cores are exported pure functions, so you can test them without booting an
app:

```ts
import { evaluateOwnership, evaluateGovernanceGate } from '@adonis-agora/agent'

evaluateOwnership('u_1', 'u_1', false) // → { ok: true,  status: 200 }  owner
evaluateOwnership('u_2', 'u_1', false) // → { ok: false, status: 403 }  not owner
evaluateOwnership('u_2', null, false)  // → { ok: false, status: 404 }  unknown id
evaluateOwnership('u_2', 'u_1', true)  // → { ok: true,  status: 200 }  privileged

const verdict = await evaluateGovernanceGate(actor, ctx, config.dashboard?.authorize, !app.inProduction)
if (!verdict.ok) return ctx.response.status(verdict.status).json({ error: verdict.error })
```

Unknown ids deliberately reply 404, never 403, so a response never confirms to a caller
that an id they don't own exists. With tenancy on, a thread or run of another organization
answers 404 the same way, and `GET /agent/threads` lists only the request's organization.

Source: `packages/adonis/docs/governance/authorization.mdx` ("Object-level ownership"),
`packages/adonis/src/ownership.ts`.

### Pattern 4 — operate the console from the shell

Every console page has an `agent:*` ace command over the same read-model and service:

```sh
node ace agent:approvals:list --json
node ace agent:approvals:reject <toolCallId> --note "Over the refund limit" --force
node ace agent:runs:list --status failed --from 2026-11-01
node ace agent:spend:show --by actor
node ace agent:pricing:set gpt-4o-mini --input 0.15 --output 0.6
```

`agent:approvals:approve|reject` run the console's HITL rules (approver role, expiry, a run that
ended) and record `cli:<os user>` via `cli`. A call routed to an approver role still needs that
role — the CLI holds none — and deciding needs the durable runner (an in-process turn is refused).

Source: `packages/adonis/docs/cli.mdx`, `packages/adonis/src/tool-call-decision.ts`.

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

### CRITICAL — deploying without `dashboard.authorize`

```ts
// Wrong — works in dev (open), then every console and /agent/governance/* request is 403 in production.
export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid() } })
```

```ts
// Correct — decide who may read spend/threads/approvals (with tenancy on, only the
// viewer's organization unless `tenants: '*' | ids` widens it).
export default defineConfig({
  ...,
  dashboard: { authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false },
})
```

Mechanism: the routes mount whenever the read-model resolves; without `authorize` they are
open outside production and closed in production, and the boot warning reads
"console has no `authorize` configured". `GET /agent/approvals/mine` is exempt — always
scoped to the calling actor.
Source: `packages/adonis/src/dashboard/gate.ts` (`evaluateDashboardGate`),
`packages/adonis/src/console-authorize.ts` (`NO_CONSOLE_AUTHORIZE_WARNING`).

### HIGH — still setting `governanceAuthorize` (removed in 1.0)

```ts
// Wrong — the key no longer exists (TypeScript rejects it); actor-first hooks also break.
governanceAuthorize: (actor) => actor.roles?.includes('ADMIN') ?? false,
```

```ts
// Correct — one option, ctx first, actor optional.
dashboard: { authorize: (ctx, actor) => actor?.roles?.includes('ADMIN') ?? false },
```

Mechanism: 1.0 folded both gates into `dashboard.authorize`; there is no alias, and
`dashboard.onUnauthenticated` is gone too (return `{ redirectTo }` instead).
Source: `packages/adonis/docs/migrating-to-1-0.mdx`.

### HIGH — calling the hook and truth-testing its result yourself

```ts
// Wrong — { allowed: false } and { redirectTo } are truthy objects, so this lets a denied actor
// through; and the hook may be a class or a lazy import, not a plain function.
if (await (config.dashboard?.authorize as any)(ctx, actor)) serveAdminData()
```

```ts
// Correct — let the gate resolve and normalise it (true/{allowed:true} allow; reason
// 'unauthenticated' → 401; { redirectTo } → redirect for a page navigation, 401 for an API
// call; false/{allowed:false}/reason 'forbidden'/throw → 403).
const verdict = await evaluateGovernanceGate(actor, ctx, config.dashboard?.authorize)
if (!verdict.ok) return ctx.response.status(verdict.status).json({ error: verdict.error })
```

Mechanism: `dashboard.authorize` takes the console `authorize` shared by every
`@adonis-agora/*` console — a function `(ctx, actor?)`, an authorizer class, or a lazy import — and return `boolean | { allowed: boolean; reason?: 'unauthenticated' | 'forbidden' } |
{ allowed: true; tenants?: '*' | string[] } | { redirectTo: string }` (with tenancy on,
omitted `tenants` means the viewer's own organization).
Source: `packages/adonis/src/console-authorize.ts`, `packages/adonis/src/governance-gate.ts`.

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
