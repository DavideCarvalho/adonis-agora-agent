/**
 * Retrieval seam for RAG. A `Retriever` is a black box — the agent loop asks it for the passages most
 * relevant to a query and never sees how (vector search, keyword, hybrid, a remote service). This
 * package ships an {@link import('../rag/embedding-retriever.js').EmbeddingRetriever} (embed + vector
 * store) built via the `retrievers` factory namespace, but any impl satisfying this SPI works. Wired
 * on the config's `retriever` it drives always-on ("inject") retrieval: the loop retrieves once for
 * the user message and folds the passages into the system prompt. Mirrors the reference `Retriever`
 * contract exactly.
 */

import type { EmbeddingUsage } from './embedding-provider.js';

/** One retrieved passage. `source` is a human/citation-facing origin; `score` is impl-defined relevance. */
export interface Passage {
  id: string;
  text: string;
  score: number;
  /** Where the passage came from (document title, URL, row id) — surfaced as a citation. */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieveOptions {
  /** Max passages to return. The impl may cap it; the loop defaults to 5 when unset. */
  topK?: number;
  /** Impl-specific metadata filter (e.g. `{ tenantRef }`). Opaque to the runtime. */
  filter?: Record<string, unknown>;
  /**
   * Relevance floor: drop every passage whose {@link Passage.score} is below this value (a passage is
   * kept only when `score >= minScore`). `score` is higher-is-more-relevant across this lib — cosine
   * SIMILARITY (`1 - distance`) for the vector store, or a negated L2/inner distance — so this is a
   * similarity threshold for strict-grounding RAG that never cites weakly-related sources. Applied
   * BEFORE the top-K cut, so the returned passages are all above the floor. Undefined → no floor
   * (identical to today). Honored by the vector-store retrieval path (a store's `search` and the
   * {@link import('../rag/embedding-retriever.js').EmbeddingRetriever} that threads it through).
   */
  minScore?: number;
}

/** Passagens mais, quando o retriever sabe dizer, o que a busca consumiu. */
export interface RetrievalResult {
  passages: Passage[];
  /**
   * O consumo de EMBEDDING da consulta. Um retriever que não embeda nada (keyword, serviço remoto)
   * simplesmente omite.
   */
  usage?: EmbeddingUsage;
}

export interface Retriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<Passage[]>;
  /**
   * Same as {@link Retriever.retrieve}, plus what the query cost. OPTIONAL — o loop usa quando
   * existe e cai para `retrieve` quando não.
   *
   * É por aqui que o gasto de embedding chega ao ledger e à cota. Retrieval em modo inject roda em
   * TODA pergunta do usuário, então é o embedding recorrente: deixá-lo invisível fazia o painel
   * afirmar um consumo menor do que o real, justamente na conta que decide quando barrar alguém.
   */
  retrieveWithUsage?(query: string, options?: RetrieveOptions): Promise<RetrievalResult>;
}
