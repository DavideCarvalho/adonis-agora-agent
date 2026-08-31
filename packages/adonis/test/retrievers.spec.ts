import { describe, expect, it } from 'vitest';
import {
  chunkDocuments,
  EmbeddingRetriever,
  HybridRetriever,
  ingestChunks,
  KeywordRetriever,
  MemoryVectorStore,
  type Reranker,
  RerankingRetriever,
  type RerankOptions,
  type RetrieveOptions,
  type Retriever,
  type VectorSearchOptions,
  type VectorStore,
} from '../src/index.js';
import { FakeEmbeddingProvider, FakeReranker } from '../src/testing/index.js';

const DOCS = [
  { id: 'cats', text: 'Cats are domestic felines that purr and chase mice.', source: 'animals' },
  { id: 'rockets', text: 'Rockets burn propellant to reach orbit.', source: 'space' },
  {
    id: 'dogs',
    text: 'Dogs are loyal domestic canines that bark at strangers.',
    source: 'animals',
  },
];

describe('KeywordRetriever (BM25)', () => {
  it('ranks the term-matching doc first', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));
    const passages = await keyword.retrieve('domestic felines chase mice', { topK: 3 });
    expect(passages[0]?.id).toBe('cats#0');
  });

  it('filters by metadata', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS.map((doc) => ({ ...doc, metadata: { kind: doc.source } }))));
    const passages = await keyword.retrieve('domestic', { topK: 5, filter: { kind: 'animals' } });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.kind === 'animals')).toBe(true);
  });

  it('honors an array-OR metadata filter', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(
      chunkDocuments([
        { id: 'a', text: 'shared domestic note', metadata: { audience: ['public'] } },
        { id: 'b', text: 'shared domestic secret', metadata: { audience: ['role:ADMIN'] } },
      ]),
    );
    const passages = await keyword.retrieve('domestic', {
      topK: 5,
      filter: { audience: ['public', 'base:1'] },
    });
    expect(passages.map((passage) => passage.id)).toEqual(['a#0']);
  });

  it('re-adding an id replaces its posting', async () => {
    const keyword = new KeywordRetriever();
    keyword.add([{ id: 'd', text: 'alpha alpha alpha' }]);
    keyword.add([{ id: 'd', text: 'beta gamma' }]);
    expect(await keyword.retrieve('alpha', { topK: 5 })).toHaveLength(0);
    expect(await keyword.retrieve('beta', { topK: 5 })).toHaveLength(1);
  });
});

describe('minScore relevance floor', () => {
  it('MemoryVectorStore.search drops passages below the floor (before top-K)', async () => {
    const store = new MemoryVectorStore();
    await store.upsert([
      { id: 'near', text: 'near', embedding: [1, 0, 0] },
      { id: 'orthogonal', text: 'orthogonal', embedding: [0, 1, 0] },
    ]);
    // Query aligned with 'near' → cosine 1.0; 'orthogonal' → cosine 0.0.
    const passages = await store.search([1, 0, 0], { topK: 5, minScore: 0.5 });
    expect(passages.map((p) => p.id)).toEqual(['near']);
  });

  it('MemoryVectorStore.search with no minScore returns every match (unchanged)', async () => {
    const store = new MemoryVectorStore();
    await store.upsert([
      { id: 'near', text: 'near', embedding: [1, 0, 0] },
      { id: 'orthogonal', text: 'orthogonal', embedding: [0, 1, 0] },
    ]);
    const passages = await store.search([1, 0, 0], { topK: 5 });
    expect(passages).toHaveLength(2);
  });

  it('EmbeddingRetriever.retrieve threads minScore through to the store', async () => {
    const embedder = new FakeEmbeddingProvider();
    const seen: VectorSearchOptions[] = [];
    const recordingStore: VectorStore = {
      async upsert() {},
      async remove() {},
      async listDocuments() {
        return [];
      },
      async search(_embedding, options) {
        seen.push(options);
        return [];
      },
    };
    const retriever = new EmbeddingRetriever(embedder, recordingStore);
    await retriever.retrieve('anything', { topK: 3, minScore: 0.42 });
    expect(seen[0]?.minScore).toBe(0.42);

    // With no minScore, none is forwarded (behavior unchanged).
    await retriever.retrieve('anything', { topK: 3 });
    expect(seen[1]?.minScore).toBeUndefined();
  });
});

describe('HybridRetriever (RRF)', () => {
  it('fuses vector + keyword and dedupes by id', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const keyword = new KeywordRetriever();
    const chunks = chunkDocuments(DOCS);
    await ingestChunks(chunks, { embedder, store });
    keyword.add(chunks); // same chunk ids as the vector store → fusion lines them up

    const hybrid = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
    const passages = await hybrid.retrieve('domestic felines that chase mice', { topK: 3 });

    expect(passages[0]?.id).toBe('cats#0');
    const ids = passages.map((passage) => passage.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('RerankingRetriever', () => {
  it('over-fetches, reranks, and truncates to topK', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(chunkDocuments(DOCS), { embedder, store });

    const reranked = new RerankingRetriever(
      new EmbeddingRetriever(embedder, store),
      new FakeReranker(),
      { fetchTopK: 3 },
    );
    const passages = await reranked.retrieve('loyal domestic canines that bark', { topK: 1 });

    expect(passages).toHaveLength(1);
    expect(passages[0]?.id).toBe('dogs#0');
  });

  it('applies the reranker order (not the base order) and over-fetches with fetchTopK', async () => {
    // A base retriever that returns a KNOWN order — 'first' ahead of 'second'.
    const seen: RetrieveOptions[] = [];
    const base: Retriever = {
      async retrieve(_query, options = {}) {
        seen.push(options);
        return [
          { id: 'first', text: 'one', score: 0.9 },
          { id: 'second', text: 'two', score: 0.1 },
        ];
      },
    };
    // A reranker that REVERSES: if RerankingRetriever ignored it, 'first' would stay ahead.
    const reversing: Reranker = {
      async rerank(_query, passages, options: RerankOptions = {}) {
        const reversed = [...passages].reverse();
        return options.topK !== undefined ? reversed.slice(0, options.topK) : reversed;
      },
    };
    const retriever = new RerankingRetriever(base, reversing, { fetchTopK: 17 });
    const passages = await retriever.retrieve('q', { topK: 1 });

    expect(seen[0]?.topK).toBe(17); // base over-fetched with fetchTopK, not the caller's topK
    expect(passages).toHaveLength(1); // truncated to topK
    expect(passages[0]?.id).toBe('second'); // reranker's reversed order won
  });
});
