---
'@adonis-agora/agent': minor
---

First-party HTTP embedding and rerank adapters

New `openAiEmbeddings` — an `EmbeddingProvider` over any OpenAI-compatible `/v1/embeddings` (OpenAI, gateways, TEI, Ollama, vLLM), with `embedWithUsage` so embedding spend reaches the ledger and quota — and `HttpReranker`, a `Reranker` over Cohere/Jina/Voyage/TEI-style `/rerank`. Both are dependency-free and throw `HttpModelError`. `@adonis-agora/agent/testing` adds `hashedEmbeddings(dimensions)`, a deterministic Unicode-aware hashed embedder.
