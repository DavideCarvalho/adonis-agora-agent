---
"@adonis-agora/agent": minor
---

OpenCode turns are priced and recorded like the loop's own: every model call OpenCode makes (each step, the session title, a compaction) goes to the token-usage ledger with `cost_usd` and `cost_source`. OpenCode's own figure wins when it priced the call; a call it priced at 0 is estimated from the library's price (`pricingStore`, `priceCatalog.prices`, the built-in GovCloud Bedrock table, models.dev), so `priceCatalog` now applies under OpenCode. `openCode({ cost: 'estimate' })` prefers the library's price whenever it has one.

- Usage counts the whole input side: OpenCode's uncached `tokens.input` plus its cache reads and writes, with `cacheReadTokens` / `cacheWriteTokens` as subsets.
- The model on the row and the `step-finish` frame is the one OpenCode names for the step (`<providerID>/<model id>`).
- `OpenCodeRunResult.usage`, the run row's totals and the last message's usage are summed from the turn's own calls (each milestone carries its share; a durable run journals it), so a run resumed in another process reports the whole run. `usage` now carries `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` and `steps`.
- `ModelPriceResolver` / `resolveUsageCost`, and more us-gov-west-1 Bedrock prices in the built-in table (Amazon Nova Micro/Lite/Pro, Titan Text Embeddings V2, Meta Llama 3 8B/70B, OpenAI gpt-oss-20b/120b, NVIDIA Nemotron, xAI Grok 4.6), from the AWS Price List.
