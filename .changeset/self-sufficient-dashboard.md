---
"@adonis-agora/agent": minor
"@adonis-agora/agent-dashboard": minor
---

`@adonis-agora/agent` now ships its own governance dashboard — `node ace configure @adonis-agora/agent` registers an embedded `dashboard_provider` that serves the `@adonis-agora/agent-dashboard` SPA straight out of `@adonis-agora/agent`'s own build (`../dashboard/dist/spa` is copied into `dist/assets/spa` at build time), so a new app needs no separate install or provider registration to get the console. Configure it via the same optional `config('agent').dashboard` block as before.

This is purely additive: the standalone `@adonis-agora/agent-dashboard` package and its own `agent_dashboard_provider` keep working exactly as before for apps that already install and register it directly — both providers now share one implementation (`@adonis-agora/agent/dashboard`, a new subpath export) so their behavior is byte-for-byte identical. Register only one of the two in a given app; mounting both at the same path throws AdonisJS's "duplicate route" error at boot.

`@adonis-agora/agent-dashboard`'s peer dependency floor on `@adonis-agora/agent` moves to `>=0.21.0` (the version that introduces the shared `@adonis-agora/agent/dashboard` export its provider now imports from); already-published `agent-dashboard` versions are unaffected.
