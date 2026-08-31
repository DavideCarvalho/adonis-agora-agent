---
"@adonis-agora/agent": minor
"@adonis-agora/agent-dashboard": patch
---

Governance console: a refused request now gets a real page instead of `{"error":"forbidden"}`.

Opening the console without permission used to answer the browser with JSON. Both providers
(the embedded `@adonis-agora/agent/dashboard_provider` and the standalone
`@adonis-agora/agent-dashboard`) now serve a built-in access-denied page in the console's own
visual language — the status, a sentence explaining the refusal and a "Back to app" link.
Statuses are unchanged (`401` when no actor resolves, `403` when `authorize` denies), and a
redirect written by `onUnauthenticated`/`authorize` still wins.

The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
`<style>` takes `@adonisjs/shield`'s request nonce when one exists.

New `dashboard.accessDenied` option on `config/agent.ts` to customise it — an object (`brand`,
`title`, `message`, `homeHref`, `accent`, labels) to tweak the built-in page, or a function
`(info, ctx) => html | void` to render it yourself or redirect. `@adonis-agora/agent/dashboard`
exports the shared `answerDashboardDenial` + `renderAccessDeniedPage`.
