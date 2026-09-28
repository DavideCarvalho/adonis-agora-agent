import type { Passage, RetrieveOptions, Retriever } from '../spi/retriever.js';
import type { LexicalVectorStore } from './vector-store.js';

/**
 * A {@link Retriever} over a store's own full-text index — the lexical half of a hybrid search, next to
 * an {@link import('./embedding-retriever.js').EmbeddingRetriever} over the same store:
 *
 * ```ts
 * const store = new PgLexicalVectorStore(db, { dimension: 1536 })
 * const retriever = new HybridRetriever([
 *   new EmbeddingRetriever(embedder, store),
 *   new LexicalRetriever(store),
 * ])
 * ```
 *
 * Embeds nothing, so it reports no usage. `minScore` is not forwarded: a text rank is not a similarity,
 * and a floor tuned for cosine would mean nothing on it.
 */
export class LexicalRetriever implements Retriever {
  constructor(private readonly store: LexicalVectorStore) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return this.store.searchText(query, {
      topK: options.topK ?? 5,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
  }
}
