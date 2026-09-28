import type { Reranker, RerankOptions } from '../spi/reranker.js';
import type { Passage } from '../spi/retriever.js';
import { errorMessageOf, HttpModelError } from './openai-embeddings.js';

export interface HttpRerankerOptions {
  /**
   * The full rerank endpoint: `https://api.cohere.com/v2/rerank`, `https://api.jina.ai/v1/rerank`,
   * `https://api.voyageai.com/v1/rerank`, or a Hugging Face TEI / Infinity / vLLM server's `/rerank`.
   */
  url: string;
  /** Model id, sent as `model` (hosted APIs require it; TEI serves one model and ignores it). */
  model?: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string;
  /**
   * Request body dialect. `cohere` (Cohere, Jina, Voyage, Infinity, vLLM): `{ query, documents,
   * top_n }`. `tei`: `{ query, texts }`. Default `auto`, which sends `documents` **and** `texts` so
   * one config works against both families. Responses are read in every dialect regardless.
   */
  format?: 'auto' | 'cohere' | 'tei';
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** `fetch` to use. Default the global one. */
  fetch?: typeof fetch;
}

interface RerankItem {
  index?: number;
  relevance_score?: number;
  score?: number;
}

/**
 * A cross-encoder {@link Reranker} behind an HTTP `/rerank` endpoint — the Cohere-style contract
 * most providers and self-hosted servers share. Compose it with `RerankingRetriever`:
 *
 * ```ts
 * const reranker = new HttpReranker({ url: 'https://api.cohere.com/v2/rerank', model: 'rerank-v3.5', apiKey });
 * const retriever = new RerankingRetriever(hybrid, reranker, { fetchTopK: 30 });
 * ```
 *
 * Reads `results: [{ index, relevance_score }]` (Cohere, Jina), `data: [{ index, relevance_score }]`
 * (Voyage) and a bare `[{ index, score }]` (TEI). Each passage keeps its fields and takes the new
 * score; the list is re-sorted and cut to `topK`. Indices the server invents are ignored.
 */
export class HttpReranker implements Reranker {
  private readonly format: NonNullable<HttpRerankerOptions['format']>;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HttpRerankerOptions) {
    this.format = options.format ?? 'auto';
    this.doFetch = options.fetch ?? fetch;
  }

  async rerank(
    query: string,
    passages: Passage[],
    options: RerankOptions = {},
  ): Promise<Passage[]> {
    if (passages.length === 0) {
      return [];
    }
    const topK = options.topK ?? passages.length;
    const documents = passages.map((passage) => passage.text);
    const response = await this.doFetch(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify({
        ...(this.options.model !== undefined ? { model: this.options.model } : {}),
        query,
        ...(this.format !== 'tei' ? { documents, top_n: topK } : {}),
        ...(this.format !== 'cohere' ? { texts: documents } : {}),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new HttpModelError(
        response.status,
        `Rerank request failed (${response.status}): ${errorMessageOf(body)}`,
      );
    }
    const items = itemsOf(body);
    if (items === undefined) {
      throw new HttpModelError(502, 'Rerank response has no results');
    }
    const seen = new Set<number>();
    const reranked: Passage[] = [];
    for (const item of items) {
      const index = item.index;
      const passage = typeof index === 'number' ? passages[index] : undefined;
      if (passage === undefined || seen.has(index as number)) {
        continue;
      }
      seen.add(index as number);
      reranked.push({ ...passage, score: Number(item.relevance_score ?? item.score ?? 0) });
    }
    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, topK);
  }
}

function itemsOf(body: string): RerankItem[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (Array.isArray(json)) {
    return json as RerankItem[];
  }
  const wrapped = json as { results?: unknown; data?: unknown } | null;
  const items = wrapped?.results ?? wrapped?.data;
  return Array.isArray(items) ? (items as RerankItem[]) : undefined;
}
