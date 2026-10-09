---
'@adonis-agora/agent': minor
---

The estimated cost now reaches the usage ledger, and the quota counts it.

For a provider that reports no cost (Bedrock, or OpenAI and Anthropic called directly), the loop's estimate (tokens times the price row) reached the message and the run, but `agent_token_usage.cost_usd` stayed NULL. The quota's USD windows read $0.

- **The ledger stores the estimate.** `agent_token_usage.cost_usd` now holds it, marked by the new `cost_source` column (`'provider' | 'estimate'`). `createAgentTables` adds the column to an existing table (schema repair), so no app migration is needed. A provider-reported cost is unchanged, still wins, and is stamped `'provider'`. An unpriced turn keeps both columns NULL. Chat and structured-output usage rows are covered.
- **SPI.** `RecordUsageInput.costSource` and `CostSource` are new. `usageBetween` returns `UsageTotals` (`{ usedTokens, costUsd, estimatedCostUsd? }`), where `costUsd` includes estimates. `sumUsage` is new.
- **Quota.** The USD windows count estimates by default, because a USD ceiling on a provider that reports no cost would otherwise never block. `quota: { limits, countEstimatedCost: false }` counts provider-reported cost only.
