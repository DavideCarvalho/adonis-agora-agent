import type { EmbeddingUsage } from '../spi/embedding-provider.js';
import type { Passage, RetrievalResult, RetrieveOptions, Retriever } from '../spi/retriever.js';

export interface HybridRetrieverOptions {
  /** RRF constant — larger flattens the rank weighting. Default 60 (the value from the original paper). */
  k?: number;
  /** Candidates pulled from each retriever before fusion. Default 20. */
  fetchTopK?: number;
  /** Per-retriever multipliers on each RRF contribution (same order as `retrievers`). Default all 1. */
  weights?: number[];
}

/**
 * Fuses several retrievers with Reciprocal Rank Fusion — the robust way to combine, say, dense vector
 * search with lexical BM25. RRF scores each passage by `Σ weight / (k + rank)` across the lists it
 * appears in, so it needs no score normalization between incompatible scales (cosine vs BM25).
 * Deduplicates by passage id, so aligned chunk ids from the two retrievers reinforce. Itself a
 * {@link Retriever}. Mirrors the reference `HybridRetriever` exactly.
 */
export class HybridRetriever implements Retriever {
  constructor(
    private readonly retrievers: Retriever[],
    private readonly options: HybridRetrieverOptions = {},
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return (await this.retrieveWithUsage(query, options)).passages;
  }

  /**
   * {@link HybridRetriever.retrieve} plus the embedding usage of every leg that reports one (summed), so
   * a hybrid over an embedding leg still reaches the ledger and the quota.
   */
  async retrieveWithUsage(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    const k = this.options.k ?? 60;
    const fetchTopK = this.options.fetchTopK ?? 20;
    const weights = this.options.weights;
    const legOptions: RetrieveOptions = {
      topK: fetchTopK,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    };
    const results = await Promise.all(
      this.retrievers.map(
        async (retriever): Promise<RetrievalResult> =>
          typeof retriever.retrieveWithUsage === 'function'
            ? retriever.retrieveWithUsage(query, legOptions)
            : { passages: await retriever.retrieve(query, legOptions) },
      ),
    );
    const lists = results.map((result) => result.passages);
    const usage = sumUsage(results.map((result) => result.usage));

    const fused = new Map<string, { passage: Passage; score: number }>();
    lists.forEach((list, listIndex) => {
      const weight = weights?.[listIndex] ?? 1;
      list.forEach((passage, rank) => {
        const contribution = weight / (k + rank + 1);
        const existing = fused.get(passage.id);
        if (existing !== undefined) {
          existing.score += contribution;
        } else {
          fused.set(passage.id, { passage, score: contribution });
        }
      });
    });

    const passages = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5)
      .map((entry) => ({ ...entry.passage, score: entry.score }));
    return { passages, ...(usage !== undefined ? { usage } : {}) };
  }
}

function sumUsage(usages: (EmbeddingUsage | undefined)[]): EmbeddingUsage | undefined {
  const reported = usages.filter((usage): usage is EmbeddingUsage => usage !== undefined);
  if (reported.length === 0) {
    return undefined;
  }
  const modelId = reported.find((usage) => usage.modelId !== undefined)?.modelId;
  return {
    inputTokens: reported.reduce((total, usage) => total + usage.inputTokens, 0),
    ...(modelId !== undefined ? { modelId } : {}),
  };
}
