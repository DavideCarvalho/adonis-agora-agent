---
"@adonis-agora/agent": patch
---

Republishes with the updated `agent-dashboard` embed (`packages/adonis/dist/assets/spa`, copied at build time from `@adonis-agora/agent-dashboard`'s own `dist/spa`) — the console's visual-identity fix from `ce1d08f` (dark-by-default, Aviary token/font/radius parity) has no effect on hosts until this package is rebuilt and republished, since it embeds the dashboard's built assets rather than depending on it at runtime. No source change in `packages/adonis` itself.
