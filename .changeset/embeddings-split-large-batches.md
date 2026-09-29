---
'@adonis-agora/agent': patch
---

`openAiEmbeddings`: a batch the server refuses as too large — HTTP 413, or TEI's `batch size 64 > maximum allowed batch size 32` (its `--max-client-batch-size` defaults to 32 while `batchSize` defaults to 64) — is split in halves and retried instead of failing the whole ingestion, and later requests to the same server and model start at the size that worked (remembered for the process). `embedWithUsage` sums the tokens of the accepted requests. Each split is reported through the new `onWarn` option. New export: `isBatchTooLarge(error)`.
