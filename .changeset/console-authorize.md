---
'@adonis-agora/agent': major
'@adonis-agora/agent-dashboard': major
---

One access option for the agent console: `dashboard.authorize` now gates both the console page and the `/agent/governance/*` routes it reads. `governanceAuthorize` is removed, with no alias, and the console always mounts unless `dashboard: { enabled: false }` (or `governanceQueries: false`).

`authorize` takes what every `@adonis-agora` console takes: an inline function `(ctx) => ...` (the resolved actor comes as an optional second argument, `(ctx, actor) => ...`), an authorizer class (built by the container per request, so `@inject()` works), or a lazy import `() => import('#policies/console_access')` (imported once).

**Breaking:**

- Without `authorize`, the console and `/agent/governance/*` are open outside production and answer `403` to every request in production, with one boot warning. Before, they were not mounted at all without `governanceAuthorize`.
- Move `governanceAuthorize` to `dashboard.authorize`, take `ctx` first, and read the actor as optional (`actor?.roles`).
- `dashboard.onUnauthenticated` is removed: return `{ redirectTo: '/login' }` from `authorize` instead. A page navigation is redirected; an API call gets `401 { "error": "unauthenticated", "redirectTo" }`.
- Denials answer `403 { "error": "forbidden" }` or `401 { "error": "unauthenticated" }`; a page navigation to the console gets the access-denied page.
- `AgentGovernanceAuthorize` is removed; use `AgentDashboardAuthorize`.

New: `authorizeByToken({ token })`, exported from `@adonis-agora/agent` and `@adonis-agora/agent/dashboard`, allows a request carrying `Authorization: Bearer <token>` (timing-safe) and answers `401` otherwise; it throws at boot when the token is empty. `GET /agent/approvals/mine` stays per-actor and is not gated by `authorize`.
