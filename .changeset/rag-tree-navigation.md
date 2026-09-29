---
'@adonis-agora/agent': minor
---

PageIndex-style tree navigation retrieval for long structured documents ("vectorless", reasoning-based: a table-of-contents tree per document, navigated by an LLM) — the port of the nestjs-agent feature. In a 149-question benchmark it beat hybrid dense+lexical search by +24 points on long GovCon regulations and +30 on FinanceBench 10-Ks, with no gain on short notes, so it is built to sit behind the existing search.

- `buildDocumentTree` / `indexDocumentTree`: structure from the PDF outline, section titles or detected headings (markdown, `PART 52`, `Item 7.`, `52.236–5 …`; running headers and contents listings dropped) before any LLM; LLM structuring only for documents with no usable outline; page groups as the never-failing fallback. Hard per-document budget (calls, input/output tokens, timeout) checked before every call, no retries. Deterministic and fingerprinted: unchanged documents cost no LLM call, changed ones re-summarize only changed sections. `minUnits`/`minChars` threshold.
- `DocumentTreeStore` SPI with `MemoryDocumentTreeStore` and `PgDocumentTreeStore` over the Lucid raw runner (filters with the vector stores' semantics), plus a published `create_agent_rag_trees` migration (`node ace configure` now publishes it; delete it if you don't use tree navigation).
- `TreeNavigationRetriever` (single pass or bounded beam, auditable trail, `Retriever`), `TwoStageRetriever` (first stage picks documents, top long ones navigated), and `createNavigateDocumentTool` — the `navigate_document` tool as a `defineTool` functional tool.
- `TreeLlm` adapters: `openAiChatTreeLlm`, `treeLlmFromModelProvider`, `cachedTreeLlm`, and the deterministic `keywordTreeLlm` for tests.

Credits: PageIndex (Vectify AI, MIT) — see the package NOTICE.
