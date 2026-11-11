---
'@adonis-agora/agent': major
'@adonis-agora/agent-dashboard': patch
---

`governanceAuthorize` and `dashboard.authorize` now take the `authorize` shared by every `@adonis-agora` console: an inline function, an authorizer class (built by the container per request, so `@inject()` works), or a lazy import `() => import('#policies/console_access')` (imported once).

**Breaking:** a function now receives the `HttpContext` first and the resolved actor second — `(ctx, actor) => ...` instead of `(actor, ctx) => ...`. Swap the arguments of the function you pass; TypeScript flags every one that still reads the actor first. `authorizeByRoles` from `@adonis-agora/authz` now works as is, and a class written for another console works unchanged.

A hook can also return `{ redirectTo: '/login' }`: page navigations are redirected there, API calls get `401`. Whether the console and the `/agent/governance/*` routes mount is unchanged: both still need `governanceAuthorize`.

The shared types (`ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass`, `ConsoleAuthorizeResult`) are exported from `@adonis-agora/agent` and `@adonis-agora/agent/dashboard`.
