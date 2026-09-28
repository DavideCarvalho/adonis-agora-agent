import type { EmbeddingProvider, EmbeddingResult } from '../spi/embedding-provider.js';

/** A non-2xx answer (or a malformed one) from an embeddings or rerank endpoint. */
export class HttpModelError extends Error {
  constructor(
    /** HTTP status; `502` when the endpoint answered 2xx with a body that doesn't fit the contract. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpModelError';
  }
}

export interface OpenAiEmbeddingsOptions {
  /** The embedding model id, sent as `model`. */
  model: string;
  /**
   * Base URL up to and including `/v1` — the client posts to `<baseUrl>/embeddings`. Default
   * `https://api.openai.com/v1`. Point it at any OpenAI-compatible server: Azure/OpenRouter/an LLM
   * gateway, Ollama (`http://localhost:11434/v1`), Hugging Face TEI, vLLM, LocalAI, LM Studio…
   */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. Local servers usually need none. */
  apiKey?: string;
  /** Output width for models that support shortening (`text-embedding-3-*`), sent as `dimensions`. */
  dimensions?: number;
  /** Inputs per request. Default 64. */
  batchSize?: number;
  /**
   * Inputs longer than this many characters are truncated before sending, so one oversized chunk
   * doesn't fail a whole batch on the model's context limit. Default 24 000 (≈ 6–8k tokens); set
   * `Infinity` to send inputs as they are.
   */
  maxInputChars?: number;
  /** Extra request headers (an org/project id, a gateway's attribution header). */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 120 000 ms. */
  timeoutMs?: number;
  /**
   * Called with the provider-reported token count of every request. The same counts also reach the
   * ledger and quota through `embedWithUsage`; this is for your own metering on top.
   */
  onUsage?: (tokens: number) => void;
  /** `fetch` to use. Default the global one. */
  fetch?: typeof fetch;
}

/**
 * An {@link EmbeddingProvider} over any OpenAI-compatible `POST /v1/embeddings` endpoint, with no SDK
 * dependency: OpenAI itself, or a gateway/local server speaking the same protocol (TEI, Ollama,
 * vLLM, LocalAI…). For a Vercel AI SDK model use `aiSdkEmbedding` from `-ai-sdk` instead.
 *
 * Batches by {@link OpenAiEmbeddingsOptions.batchSize}, restores input order from each item's
 * `index`, and fails loudly (an {@link HttpModelError}) on a non-2xx answer or a vector count that
 * doesn't match the inputs. Empty strings are sent as a single space, since OpenAI rejects them.
 * Implements `embedWithUsage` with the provider-reported tokens (summed over the batches) and model, so
 * embedding spend reaches the ledger and the quota.
 *
 * ```ts
 * const embedder = openAiEmbeddings({ model: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY });
 * const local = openAiEmbeddings({ baseUrl: 'http://tei:8080/v1', model: 'BAAI/bge-m3' });
 * ```
 */
export function openAiEmbeddings(options: OpenAiEmbeddingsOptions): EmbeddingProvider {
  const url = `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 64));
  const maxInputChars = options.maxInputChars ?? 24_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const doFetch = options.fetch ?? fetch;

  const provider = {
    async embed(texts: string[]): Promise<number[][]> {
      return (await provider.embedWithUsage(texts)).vectors;
    },

    async embedWithUsage(texts: string[]): Promise<EmbeddingResult> {
      const vectors: number[][] = [];
      let inputTokens: number | undefined;
      let modelId: string | undefined;
      for (let start = 0; start < texts.length; start += batchSize) {
        const input = texts
          .slice(start, start + batchSize)
          .map(
            (text) => (text.length > maxInputChars ? text.slice(0, maxInputChars) : text) || ' ',
          );
        const response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify({
            model: options.model,
            input,
            ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new HttpModelError(
            response.status,
            `Embeddings request failed (${response.status}): ${errorMessageOf(body)}`,
          );
        }
        const json = parseJson(body) as {
          data?: { embedding?: unknown; index?: number }[];
          model?: string;
          usage?: { prompt_tokens?: number; total_tokens?: number };
        } | null;
        const items = [...(json?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (
          items.length !== input.length ||
          !items.every((item) => Array.isArray(item.embedding))
        ) {
          throw new HttpModelError(
            502,
            `Embeddings returned ${items.length} vectors for ${input.length} inputs`,
          );
        }
        for (const item of items) {
          vectors.push(item.embedding as number[]);
        }
        const tokens = json?.usage?.total_tokens ?? json?.usage?.prompt_tokens;
        if (typeof tokens === 'number' && Number.isFinite(tokens)) {
          inputTokens = (inputTokens ?? 0) + tokens;
          options.onUsage?.(tokens);
        }
        modelId ??= typeof json?.model === 'string' ? json.model : undefined;
      }
      return {
        vectors,
        ...(inputTokens !== undefined
          ? { usage: { inputTokens, modelId: modelId ?? options.model } }
          : {}),
      };
    },
  };
  return provider;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The human part of an error body: OpenAI's `error.message`, a bare `message`/`error`, or the text. */
export function errorMessageOf(body: string): string {
  const json = parseJson(body) as {
    error?: { message?: unknown } | string;
    message?: unknown;
  } | null;
  const message =
    typeof json?.error === 'string'
      ? json.error
      : (json?.error?.message ?? json?.message ?? undefined);
  return typeof message === 'string' ? message : body.slice(0, 300);
}
