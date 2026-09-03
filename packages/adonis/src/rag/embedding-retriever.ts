import { type EmbeddingProvider, embedCountingUsage } from '../spi/embedding-provider.js';
import type { Passage, RetrievalResult, RetrieveOptions, Retriever } from '../spi/retriever.js';
import type { VectorStore } from './vector-store.js';

/**
 * Bridges an {@link EmbeddingProvider} + {@link VectorStore} into the {@link Retriever} SPI: embed the
 * query, then vector-search. This is what you wire as the agent's `retriever` (via the `retrievers`
 * factory namespace) for inject-mode retrieval. Mirrors the reference `EmbeddingRetriever` exactly.
 */
export class EmbeddingRetriever implements Retriever {
  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly store: VectorStore,
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return (await this.retrieveWithUsage(query, options)).passages;
  }

  /**
   * O caminho real; `retrieve` é o mesmo sem a conta. Os dois existem porque o `Retriever` SPI
   * promete `retrieve`, e quebrar essa promessa obrigaria todo retriever de terceiro a mudar por
   * uma capacidade que nem todo retriever tem.
   */
  async retrieveWithUsage(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    const { vectors, usage } = await embedCountingUsage(this.embedder, [query]);
    const [embedding] = vectors;
    // A consulta foi embedada mesmo sem casar passagem nenhuma, então o consumo vai junto do
    // resultado vazio. Devolver `{ passages: [] }` puro faria a busca que não achou nada parecer
    // a busca que não custou nada.
    if (embedding === undefined) {
      return { passages: [], ...(usage !== undefined ? { usage } : {}) };
    }
    const passages = await this.store.search(embedding, {
      topK: options.topK ?? 5,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    });
    return { passages, ...(usage !== undefined ? { usage } : {}) };
  }
}
