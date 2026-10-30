---
'@adonis-agora/agent': minor
---

`recordUsage` for spend the app budgets on its own, and a sharper usage breakdown.

- `countsTowardsQuota: false` on `AgentService.recordUsage` (and `RecordUsageInput`) keeps a row out of the agent's quota: `quotaToday` / `usageBetween` (token and USD windows) skip it and the `QuotaStore` counter is not bumped. It stays in the ledger, every report and `usage.recorded` (which carries `countsTowardsQuota: false`). Stored in the new `agent_token_usage.counts_towards_quota` (`INTEGER NOT NULL DEFAULT 1`), added by `createAgentTables`.
- `modelId` is optional on `recordUsage`: absent, `null` or blank → `'unknown'` (`UNKNOWN_MODEL`).
- `usageBreakdown` takes a timestamp window (`{ from, to }`, `to` exclusive) as well as UTC days, reports `unpricedRows`, and `reprice: false` reports recorded cost only. The route takes `since` / `until` / `reprice`.
