---
"@adonis-agora/agent": minor
---

The dashboard gate now honors a redirect the host already wrote to the response instead of always overwriting it with the default `401`/`403 { error }` JSON — mirrors `@adonis-agora/durable`'s dashboard guard, and `@adonis-agora/telescope`'s guard gains the same escape hatch in a companion release.

- **`authorize` denies (403)**: redirect from inside `authorize` (e.g. `ctx.response.redirect('/acesso-negado')`) and return `false` — the gate detects the `location` header and skips its own JSON write. No API change; this always worked as a predicate, only the response-writing layer changed.
- **The actor resolver itself rejects the caller (401)** — no resolver configured, or `resolve(ctx)` threw (e.g. `AuthActorResolver` on an anonymous request) — is a case `authorize` never sees, since there's no resolved actor to hand it. New optional `dashboard.onUnauthenticated?: (ctx) => void | Promise<void>` runs there instead, ctx-only (never a fabricated actor, preserving the resolver's "no identity is invented" contract): redirect inside it the same way to replace the default JSON, or leave the response untouched to keep it.

```ts
// config/agent.ts
dashboard: {
  authorize: (actor, ctx) => {
    if (isAdmin(actor)) return true
    ctx.response.redirect('/acesso-negado')
    return false
  },
  onUnauthenticated: (ctx) => {
    ctx.response.redirect('/login')
  },
}
```
