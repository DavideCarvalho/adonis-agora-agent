---
'@adonis-agora/agent': minor
---

Support result presentation on functional tools and `@AiTool` classes through the existing journaled UI stream. Add the inferred object form of `defineTool`, preserve raw domain results, and report presentation failures separately so successful actions are not retried because rendering failed. Export Agora-owned optional React static HTML, paginated PNG and PDF renderers and Playwright capture adapter.

Remove cross-ecosystem peers: Agora owns its GenUI contracts, React adapters, AG-UI codec, and resumable upload client. All entries build and publish independently of Aviary; compatible wire protocols remain supported.
