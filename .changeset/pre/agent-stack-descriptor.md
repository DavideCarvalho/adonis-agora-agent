---
"@adonis-agora/agent": patch
---

Describe the agent's infrastructure for stack views (telescope's Architecture page): the config factories (`stores.lucid`, `pricingStores.lucid`, `governanceQueries.lucid`, `tokenSinks.redis`/`lucid`, `retrievers.pgvector`/`qdrant`/`memory`, `openAiEmbeddings`) and the model providers (`aiSdkModel`, `aiSdkModels`, and a lazy `model` thunk once it resolves at boot) carry what they use under `Symbol.for('@adonis-agora/stack')` — the connection and its engine, the LLM provider and model family, the vector store and embedder. No keys or urls; nothing to configure.
