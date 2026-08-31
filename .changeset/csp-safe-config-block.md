---
"@adonis-agora/agent": patch
"@adonis-agora/agent-dashboard": patch
---

Dashboard: every API request 404 under a nonce CSP — fixed.

The providers used to hand the SPA the agent API base as an inline `<script>` setting
`window.__AGENT_DASHBOARD_BASE__`. A host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s
`@nonce`, the recommended setup) drops that script silently; the SPA then derived a base from its
own URL, which is right only for the default `<agent>/dashboard` mount, and on any other every
request from a console that rendered perfectly well answered 404. `injectApiBase` now emits a
`<script type="application/json">` data block, which is never executed and so cannot be refused,
and `resolveApiBase` reads it first (the global is still honoured after it). Nothing to change on
the host.
