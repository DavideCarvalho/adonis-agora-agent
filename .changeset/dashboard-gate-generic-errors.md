---
"@adonis-agora/agent": patch
---

Stops leaking internal exception messages (`AuthActorResolver`'s "no authenticated user on ctx.auth.user...", or whatever `authorize`/`governanceAuthorize` happens to throw) to the client on the dashboard's `401`/`403` responses and on the `/agent/governance/*` and per-actor route `401`s — they now reply with a generic `'unauthorized'`/`'forbidden'`, matching `@adonis-agora/durable`'s dashboard convention of a uniform message on every credential failure, instead of exposing detail meant for the developer wiring the config to an untrusted, possibly anonymous caller.

The detail isn't gone — `evaluateDashboardGate`/`evaluateGovernanceGate` gained a `debug` parameter (default `false`), and the providers pass `!app.inProduction`, so local/dev boots keep seeing the real message while diagnosing a misconfiguration.

`evaluateDashboardGate`'s "no actor resolver configured" `401` is unaffected — that's a static config error, identical for every caller and not per-request, so it stays visible even in production.
