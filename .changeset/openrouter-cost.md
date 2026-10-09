---
'@adonis-agora/agent': minor
---

Cost works out of the box for OpenRouter, and an unpriced model can no longer go silently NULL.

- **OpenRouter cost is read.** The AI SDK adapter read `total_cost`, which `@openrouter/ai-sdk-provider` never emits, so every OpenRouter turn recorded `cost_usd = NULL`. It now reads `providerMetadata.openrouter.usage.cost` — the real, per-call routed cost — onto the usage row, the message and the run, where the quota's `usd` windows and the governance read-model pick it up. `total_cost` is kept as a fallback.
- **Usage accounting is requested.** `aiSdkModel` / `aiSdkModels` add `providerOptions.openrouter.usage = { include: true }` to OpenRouter calls (your own `openrouter.usage` wins), and warn once per model when an OpenRouter call still returns no cost. `AiSdkModelOptions` gains a typed `providerOptions`.
- **Boot seeds missing prices from models.dev.** At start the provider asks the model provider which models it runs (new optional `ModelProvider.describeModels()`, implemented by `aiSdkModel` / `aiSdkModels`) and writes the models.dev list price for any that has no price row — never overwriting one. New `priceCatalog` config (`{ url, fetch }` or `false`); skipped under `NODE_ENV=test` unless set. New `ensureModelPricing`, `lookupModelsDevPrices`, `modelsDevRefsFor`.
- **Boot warns about a model that would record no cost**: no gateway cost and no price row, in one line naming it.
