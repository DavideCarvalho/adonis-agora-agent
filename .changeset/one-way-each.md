---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': patch
---

One way each, matching `@dudousxd/nestjs-agent`'s consolidation (#230):

- **One `quota` option (BREAKING).** `quota: { limits: { day?: { tokens?, usd? }, month?: { tokens?, usd? } } }` or a `QuotaProvider`. The `quotas.*` factories (`ledger`, `memory`, `windows`), `LedgerQuotaStore` and `QuotaStore`-as-`quota` are removed; migrate `quota: quotas.ledger({ limitTokens: N })` to `quota: { limits: { day: { tokens: N } } }`. The check moved to the send (`429 quota_exceeded` before the turn starts). Drain in-flight durable runs started under the old option first — their journals hold the loop's quota checkpoints.
- **`GET /agent/quota/today` removed** — read the day window of `GET /agent/quota`. The governance dashboard now does.
- **`activeRunId` only.** Thread summaries and details carry `activeRunId` (the run streaming right now, `null` otherwise) instead of `ThreadDetail.activeStreamId`. The runners set it before a turn starts and clear it when it ends (`clearActiveStream`, optional on `AgentStore`, only clears a pointer still naming that run), so a reloading client resumes only a live run.
- **`GET /agent/config`** — `{ attachments: { enabled, upload, maxBytes, allowedContentTypes, maxPerMessage }, models: { enabled }, quota: { enforced }, identity: { anonymous } }`, what the React `useAgentConfig` reads.
