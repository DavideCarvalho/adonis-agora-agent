---
'@adonis-agora/agent': minor
---

Bedrock is priced correctly at boot, GovCloud is never seeded at commercial prices, and apps can supply their own price rows.

- **Bedrock ids are normalized.** Inference-profile, foundation-model and application-inference-profile ARNs (`arn:aws[-us-gov|-cn]:bedrock:…`) and geo-prefixed profiles (`us.`, `eu.`, `apac.`, `us-gov.`, `global.`, …) are looked up as the full id, then the profile id, then the base id. The seeded row is keyed by the configured id, so a turn reporting the full ARN finds it. An ARN is no longer looked up as an `openrouter/arn:…` ref.
- **No silent commercial prices outside the commercial partition.** A Bedrock model in GovCloud or China, detected from the ARN, a `us-gov.` prefix, `priceCatalog.region` or `AWS_REGION` / `AWS_DEFAULT_REGION`, is never seeded from models.dev. GovCloud gets a built-in table (`BEDROCK_BUILTIN_PRICES`, from the AWS Price List for us-gov-west-1; Claude Sonnet 4.5 is $3.60 / $18 / $0.36 / $4.50 per 1M tokens). Anything else is left unpriced and warned about.
- **`priceCatalog.prices`.** This is a list of app-supplied `{ model, input, output, cacheRead?, cacheWrite?, currency?: 'USD', unit?: '1M tokens' | '1K tokens' }` rows, seeded before the built-in table and models.dev, and never over an existing row. Also new: `priceCatalog.region` and `priceCatalog.modelsDev: false`. The option type is now `PriceCatalogOptions` (a superset of `ModelsDevOptions`).
- **The boot warning says why and how to fix it.** It now groups unpriced models by reason (no price for partition/region, unknown to models.dev, models.dev unreachable or off) and shows the `priceCatalog.prices` entry to add.
- New exports: `parseBedrockModelId`, `bedrockPriceCandidates`, `isBedrockModel`, `awsPartitionOfRegion`, `builtinBedrockPrice`, `BEDROCK_BUILTIN_PRICES`, `normalizePriceEntries`, `lookupModelsDevPricesEach` and the `PriceCatalogOptions` / `PriceCatalogEntry` types.
