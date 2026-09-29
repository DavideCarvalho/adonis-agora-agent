// Unit: openAiEmbeddings and HttpReranker against a real local HTTP server (node:http) that speaks
// the OpenAI `/v1/embeddings` and Cohere/Jina/Voyage/TEI `/rerank` contracts — real fetch, real
// JSON, real status codes, no provider account.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Passage } from '../src/index.js';
import { HttpModelError, HttpReranker, isBatchTooLarge, openAiEmbeddings } from '../src/index.js';

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let respond: (seen: Seen) => { status?: number; json?: unknown; text?: string };

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const entry = { url: request.url ?? '', headers: request.headers, body: JSON.parse(raw) };
      seen.push(entry);
      const answer = respond(entry);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.text ?? JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
});

/** An OpenAI-shaped embeddings answer: one [length, index] vector per input, deliberately shuffled. */
function openAiAnswer({ body }: Seen) {
  const input = body.input as string[];
  const data = input.map((text, index) => ({
    object: 'embedding',
    index,
    embedding: [text.length, index],
  }));
  return {
    json: {
      data: data.reverse(),
      usage: { prompt_tokens: input.length, total_tokens: input.length },
    },
  };
}

describe('openAiEmbeddings', () => {
  it('posts batches to <baseUrl>/embeddings and returns vectors in input order', async () => {
    respond = openAiAnswer;
    const usage: number[] = [];
    const embedder = openAiEmbeddings({
      baseUrl: `${base}/v1/`,
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      dimensions: 2,
      batchSize: 2,
      headers: { 'x-tenant': 't1' },
      onUsage: (tokens) => usage.push(tokens),
    });

    const vectors = await embedder.embed(['a', 'bb', 'ccc', '']);

    expect(vectors).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [1, 1], // '' is sent as ' '
    ]);
    expect(seen.map((entry) => entry.url)).toEqual(['/v1/embeddings', '/v1/embeddings']);
    expect(seen[0]?.body).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'bb'],
      dimensions: 2,
    });
    expect(seen[1]?.body.input).toEqual(['ccc', ' ']);
    expect(seen[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(seen[0]?.headers['x-tenant']).toBe('t1');
    expect(usage).toEqual([2, 2]);
  });

  it('reports the summed tokens and the reported model through embedWithUsage (for the ledger)', async () => {
    respond = (entry) => {
      const answer = openAiAnswer(entry);
      return { json: { ...answer.json, model: 'text-embedding-3-small-2025' } };
    };
    const embedder = openAiEmbeddings({
      baseUrl: base,
      model: 'text-embedding-3-small',
      batchSize: 2,
    });

    const result = await embedder.embedWithUsage?.(['a', 'b', 'c']);

    expect(result?.vectors).toHaveLength(3);
    expect(result?.usage).toEqual({ inputTokens: 3, modelId: 'text-embedding-3-small-2025' });
  });

  it('omits usage when the server reports none', async () => {
    respond = () => ({ json: { data: [{ index: 0, embedding: [1] }] } });
    const result = await openAiEmbeddings({ baseUrl: base, model: 'm' }).embedWithUsage?.(['a']);
    expect(result).toEqual({ vectors: [[1]] });
  });

  it('sends no Authorization header without an apiKey and truncates oversized inputs', async () => {
    respond = openAiAnswer;
    const embedder = openAiEmbeddings({ baseUrl: `${base}/v1`, model: 'bge', maxInputChars: 3 });

    await embedder.embed(['abcdef']);

    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.body.input).toEqual(['abc']);
  });

  it('does no request for no inputs', async () => {
    respond = openAiAnswer;
    await expect(openAiEmbeddings({ baseUrl: base, model: 'm' }).embed([])).resolves.toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("surfaces the provider's error message and status", async () => {
    respond = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } });
    const error = await openAiEmbeddings({ baseUrl: base, model: 'm' })
      .embed(['x'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpModelError);
    expect((error as HttpModelError).status).toBe(401);
    expect((error as Error).message).toContain('Incorrect API key provided');
  });

  it('fails on a vector count that does not match the inputs', async () => {
    respond = () => ({ json: { data: [{ index: 0, embedding: [1] }] } });
    await expect(openAiEmbeddings({ baseUrl: base, model: 'm' }).embed(['a', 'b'])).rejects.toThrow(
      '1 vectors for 2 inputs',
    );
  });
});

const passages: Passage[] = [
  { id: 'a', text: 'alpha', score: 0.9, source: 'A' },
  { id: 'b', text: 'beta', score: 0.8, metadata: { k: 1 } },
  { id: 'c', text: 'gamma', score: 0.7 },
];

describe('openAiEmbeddings — a server that refuses large batches (TEI max-client-batch-size)', () => {
  /** TEI's answer to a batch over its limit: 422 + "batch size N > maximum allowed batch size M". */
  function teiLimited(limit: number) {
    return (entry: Seen) => {
      const input = entry.body.input as string[];
      if (input.length > limit) {
        return {
          status: 422,
          json: {
            error: `batch size ${input.length} > maximum allowed batch size ${limit}`,
            error_type: 'Validation',
          },
        };
      }
      return openAiAnswer(entry);
    };
  }

  it('splits a refused batch in halves, keeps input order, and remembers the working size', async () => {
    respond = teiLimited(3);
    const warnings: string[] = [];
    const embedder = openAiEmbeddings({
      baseUrl: `${base}/split-a/v1`,
      model: 'm',
      batchSize: 8,
      onWarn: (message) => warnings.push(message),
    });
    const texts = Array.from({ length: 10 }, (_, i) => 'x'.repeat(i + 1));

    const result = await embedder.embedWithUsage!(texts);

    expect(result.vectors.map((vector) => vector[0])).toEqual(texts.map((text) => text.length));
    // Only accepted requests count: 10 inputs → 10 tokens.
    expect(result.usage?.inputTokens).toBe(10);
    // 8 refused → 4 refused → 2 + 2 accepted; then later batches go out at 2 from the start.
    const sizes = seen.map((entry) => (entry.body.input as string[]).length);
    expect(sizes).toEqual([8, 4, 2, 2, 2, 2, 2]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('max-client-batch-size');

    // A second provider for the same server and model starts at the learned size.
    seen = [];
    const again = openAiEmbeddings({ baseUrl: `${base}/split-a/v1`, model: 'm', batchSize: 8 });
    await again.embed(texts.slice(0, 4));
    expect(seen.map((entry) => (entry.body.input as string[]).length)).toEqual([2, 2]);
  });

  it('treats 413 as too large too', async () => {
    respond = (entry) =>
      (entry.body.input as string[]).length > 1
        ? { status: 413, text: 'Payload Too Large' }
        : openAiAnswer(entry);
    const embedder = openAiEmbeddings({ baseUrl: `${base}/split-b/v1`, model: 'm', batchSize: 4 });
    expect(await embedder.embed(['a', 'bb', 'ccc'])).toHaveLength(3);
  });

  it('does not split on an error that is not about size, nor below one input', async () => {
    respond = () => ({ status: 401, json: { error: { message: 'bad key' } } });
    const embedder = openAiEmbeddings({ baseUrl: `${base}/split-c/v1`, model: 'm', batchSize: 4 });
    await expect(embedder.embed(['a', 'b'])).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveLength(1);

    seen = [];
    respond = () => ({ status: 413, text: 'too big' });
    await expect(embedder.embed(['a'])).rejects.toMatchObject({ status: 413 });
    expect(seen).toHaveLength(1);
  });

  it('isBatchTooLarge recognises size refusals only', () => {
    expect(isBatchTooLarge(new HttpModelError(413, 'x'))).toBe(true);
    expect(
      isBatchTooLarge(new HttpModelError(422, 'batch size 64 > maximum allowed batch size 32')),
    ).toBe(true);
    expect(isBatchTooLarge(new HttpModelError(400, 'too many inputs'))).toBe(true);
    expect(isBatchTooLarge(new HttpModelError(400, 'invalid model'))).toBe(false);
    expect(isBatchTooLarge(new Error('batch size'))).toBe(false);
  });
});

describe('HttpReranker', () => {
  it('sends a Cohere/TEI-compatible body and re-sorts by relevance_score, cut to topK', async () => {
    respond = () => ({
      json: {
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.5 },
        ],
      },
    });
    const reranker = new HttpReranker({
      url: `${base}/v2/rerank`,
      model: 'rerank-v3.5',
      apiKey: 'k',
    });

    const reranked = await reranker.rerank('which greek letter', passages, { topK: 2 });

    expect(reranked).toEqual([
      { id: 'c', text: 'gamma', score: 0.95 },
      { id: 'b', text: 'beta', score: 0.5, metadata: { k: 1 } },
    ]);
    expect(seen[0]?.url).toBe('/v2/rerank');
    expect(seen[0]?.headers.authorization).toBe('Bearer k');
    expect(seen[0]?.body).toEqual({
      model: 'rerank-v3.5',
      query: 'which greek letter',
      documents: ['alpha', 'beta', 'gamma'],
      top_n: 2,
      texts: ['alpha', 'beta', 'gamma'],
    });
  });

  it('reads a TEI bare array ({ index, score }) and sends only `texts` in tei format', async () => {
    respond = () => ({
      json: [
        { index: 1, score: 3.2 },
        { index: 0, score: -1.5 },
        { index: 2, score: 0 },
      ],
    });
    const reranker = new HttpReranker({ url: `${base}/rerank`, format: 'tei' });

    const reranked = await reranker.rerank('q', passages);

    expect(reranked.map((passage) => [passage.id, passage.score])).toEqual([
      ['b', 3.2],
      ['c', 0],
      ['a', -1.5],
    ]);
    expect(seen[0]?.body).toEqual({ query: 'q', texts: ['alpha', 'beta', 'gamma'] });
  });

  it("reads Voyage's `data` and ignores indices it never sent (or repeats)", async () => {
    respond = () => ({
      json: {
        data: [
          { index: 0, relevance_score: 0.4 },
          { index: 7, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.9 },
        ],
      },
    });
    const reranked = await new HttpReranker({ url: `${base}/v1/rerank`, format: 'cohere' }).rerank(
      'q',
      passages,
    );
    expect(reranked.map((passage) => passage.id)).toEqual(['a']);
    expect(seen[0]?.body.texts).toBeUndefined();
  });

  it('does no request for no passages', async () => {
    await expect(new HttpReranker({ url: base }).rerank('q', [])).resolves.toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('throws an HttpModelError on a non-2xx answer or a body with no results', async () => {
    respond = () => ({ status: 429, json: { message: 'rate limited' } });
    await expect(new HttpReranker({ url: base }).rerank('q', passages)).rejects.toThrow(
      'Rerank request failed (429): rate limited',
    );
    respond = () => ({ text: 'not json' });
    await expect(new HttpReranker({ url: base }).rerank('q', passages)).rejects.toBeInstanceOf(
      HttpModelError,
    );
  });
});
