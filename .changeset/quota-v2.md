---
'@adonis-agora/agent': minor
---

Quota v2, matching `@dudousxd/nestjs-agent`: `quota: quotas.windows({ day?: { tokens?, usd? }, month?: { tokens?, usd? } })` (or your own `QuotaProvider`) sets budget windows; `GET /agent/quota` reports `{ windows: [{ period, usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt }], blocked? }` and a send while a window is exhausted answers `429` `{ code: 'quota_exceeded', period, message }`. Without a budget the route still reports usage off the ledger and never gates; a daily `QuotaStore` keeps being enforced by the loop and lends the day window its ceiling. `AgentStore` gains optional `usageBetween` (Lucid, in-memory) for the month window and recorded spend.
