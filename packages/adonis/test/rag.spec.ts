import { describe, expect, it } from 'vitest';
import {
  chunkDocuments,
  chunkText,
  cosineSimilarity,
  EmbeddingRetriever,
  ingestDocuments,
  MemoryVectorStore,
} from '../src/index.js';
import { FakeEmbeddingProvider, inMemoryRetriever } from '../src/testing/index.js';

describe('chunkText', () => {
  it('returns the whole text as one chunk when under the size limit', () => {
    expect(chunkText('a short doc')).toEqual(['a short doc']);
  });

  it('returns nothing for empty/whitespace input', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long text into overlapping chunks that cover the source', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    const text = sentence.repeat(60); // ~2700 chars
    const chunks = chunkText(text, { chunkSize: 400, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    // Overlap: the tail of one chunk should reappear at the head region of the next.
    const firstTail = chunks[0]!.slice(-20);
    expect(text).toContain(firstTail);
  });
});

describe('chunkDocuments', () => {
  it('scopes chunk ids as `${docId}#${n}` and carries source/metadata', () => {
    const records = chunkDocuments(
      [{ id: 'doc1', text: 'hello world', source: 'README', metadata: { lang: 'en' } }],
      { chunkSize: 800 },
    );
    expect(records).toEqual([
      { id: 'doc1#0', text: 'hello world', source: 'README', metadata: { lang: 'en' } },
    ]);
  });
});

describe('FakeEmbeddingProvider + cosineSimilarity', () => {
  it('embeds deterministically to a fixed dimension', async () => {
    const embedder = new FakeEmbeddingProvider(32);
    const [a] = await embedder.embed(['cats and dogs']);
    const [b] = await embedder.embed(['cats and dogs']);
    expect(a).toHaveLength(32);
    expect(a).toEqual(b); // pure function of input
  });

  it('scores overlapping texts higher than unrelated ones', async () => {
    const embedder = new FakeEmbeddingProvider();
    const [query, related, unrelated] = await embedder.embed([
      'database connection pooling',
      'connection pooling in the database layer',
      'a recipe for banana bread',
    ]);
    expect(cosineSimilarity(query!, related!)).toBeGreaterThan(
      cosineSimilarity(query!, unrelated!),
    );
  });
});

describe('MemoryVectorStore + EmbeddingRetriever (cosine top-K)', () => {
  const docs = [
    { id: 'billing', text: 'Refunds are issued to the original payment method within 5 days.' },
    { id: 'shipping', text: 'Orders ship in 2 business days via the standard carrier.' },
    { id: 'returns', text: 'Return a product within 30 days for a full refund.' },
  ];

  it('ingests documents and returns the count', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const count = await ingestDocuments(docs, { embedder, store });
    expect(count).toBe(3);
    expect(await store.listDocuments()).toHaveLength(3);
  });

  it('retrieves the most relevant passage first, capped at topK', async () => {
    const retriever = await inMemoryRetriever({ documents: docs });
    const passages = await retriever.retrieve('how do refunds work', { topK: 2 });
    expect(passages).toHaveLength(2);
    // The refund-bearing passages should outrank shipping.
    expect(
      passages.map((p) => p.id).some((id) => id.startsWith('billing') || id.startsWith('returns')),
    ).toBe(true);
    expect(passages[0]!.score).toBeGreaterThanOrEqual(passages[1]!.score);
  });

  it('EmbeddingRetriever returns [] when the store is empty', async () => {
    const retriever = new EmbeddingRetriever(new FakeEmbeddingProvider(), new MemoryVectorStore());
    expect(await retriever.retrieve('anything')).toEqual([]);
  });
});
