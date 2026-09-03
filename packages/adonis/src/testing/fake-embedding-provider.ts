import { EmbeddingRetriever } from '../rag/embedding-retriever.js';
import { type IngestDocument, ingestDocuments } from '../rag/ingest.js';
import { MemoryVectorStore } from '../rag/memory-vector-store.js';
import type { EmbeddingProvider, EmbeddingResult } from '../spi/embedding-provider.js';
import type { Reranker, RerankOptions } from '../spi/reranker.js';
import type { Passage } from '../spi/retriever.js';

/**
 * A deterministic, offline {@link EmbeddingProvider} — no API key, no network. Each text is embedded as
 * a fixed-length bag-of-words vector: every whitespace/punctuation-delimited token is lower-cased and
 * hashed into a dimension whose count it increments. Texts that share words land close under cosine
 * similarity, so retrieval ranks the relevant chunk first, while the mapping stays a pure function of
 * the input (replay-safe, reproducible across runs). Mirrors the reference deterministic fake.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  /**
   * @param dimensions tamanho do vetor.
   * @param reportUsage se deve reportar consumo. Default `true`, para que o caminho contabilizado
   *   seja o que os testes exercitam por padrão. Passe `false` para dublar um provider ANTIGO, sem
   *   `embedWithUsage` — é assim que se prova que o fallback continua de pé.
   */
  constructor(
    private readonly dimensions = 64,
    private readonly reportUsage = true,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  async embedWithUsage(texts: string[]): Promise<EmbeddingResult> {
    if (!this.reportUsage) {
      // Um provider sem a capacidade não teria o método; aqui ele existe mas se recusa a contar,
      // que é o mesmo efeito para o chamador e mantém o dublê numa classe só.
      return { vectors: await this.embed(texts) };
    }
    return {
      vectors: await this.embed(texts),
      usage: {
        // Uma aproximação determinística: um "token" por palavra, somando o lote inteiro. Não
        // precisa bater com tokenizador nenhum — o que os testes verificam é que a contagem
        // ATRAVESSA até o ledger, não qual é o número.
        inputTokens: texts.reduce(
          (total, text) => total + (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).length,
          0,
        ),
        modelId: 'fake-embedding',
      },
    };
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length === 0) {
        continue;
      }
      const index = hashToken(token, this.dimensions);
      vector[index] = (vector[index] ?? 0) + 1;
    }
    return vector;
  }
}

/** FNV-1a-ish token hash folded into `[0, dimensions)`. Deterministic and dependency-free. */
function hashToken(token: string, dimensions: number): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % dimensions;
}

/**
 * A deterministic, offline {@link Reranker} for tests: re-scores each passage by how many distinct
 * query terms it contains (lexical overlap), then sorts descending and truncates to `topK`. No model,
 * no randomness — enough to prove {@link import('../rag/reranking-retriever.js').RerankingRetriever}
 * genuinely RE-ORDERS candidates (not just truncates) against a known-relevant passage. Stands in for a
 * real cross-encoder rerank endpoint (provider impls deferred this round). Mirrors the reference fake.
 */
export class FakeReranker implements Reranker {
  async rerank(
    query: string,
    passages: Passage[],
    options: RerankOptions = {},
  ): Promise<Passage[]> {
    const terms = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const scored = passages.map((passage) => {
      const words = new Set(passage.text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      let overlap = 0;
      for (const term of terms) {
        if (words.has(term)) {
          overlap += 1;
        }
      }
      return { ...passage, score: overlap };
    });
    scored.sort((a, b) => b.score - a.score);
    return options.topK !== undefined ? scored.slice(0, options.topK) : scored;
  }
}

/**
 * Build a ready-to-use in-memory {@link EmbeddingRetriever} for tests: a {@link MemoryVectorStore} fed
 * by the given (or a fresh {@link FakeEmbeddingProvider}) embedder, with `documents` ingested. Wire the
 * result as the config's `retriever` to exercise inject-mode retrieval offline.
 */
export async function inMemoryRetriever(options: {
  documents?: IngestDocument[];
  embedder?: EmbeddingProvider;
  chunkSize?: number;
  overlap?: number;
}): Promise<EmbeddingRetriever> {
  const embedder = options.embedder ?? new FakeEmbeddingProvider();
  const store = new MemoryVectorStore();
  if (options.documents !== undefined && options.documents.length > 0) {
    await ingestDocuments(options.documents, {
      embedder,
      store,
      ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
      ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
    });
  }
  return new EmbeddingRetriever(embedder, store);
}
