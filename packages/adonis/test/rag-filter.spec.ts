import { describe, expect, it } from 'vitest';
import {
  documentIdOf,
  EmbeddingRetriever,
  ingestDocuments,
  MemoryVectorStore,
  matchesFilter,
} from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

describe('matchesFilter — array-OR / set-membership', () => {
  it('scalar values keep exact-match (backward compatible)', () => {
    expect(matchesFilter({ owner: 'alice' }, { owner: 'alice' })).toBe(true);
    expect(matchesFilter({ owner: 'alice' }, { owner: 'bob' })).toBe(false);
  });

  it('an empty filter matches, and a filter over absent metadata does not', () => {
    expect(matchesFilter({ owner: 'alice' }, {})).toBe(true);
    expect(matchesFilter(undefined, {})).toBe(true);
    expect(matchesFilter(undefined, { owner: 'alice' })).toBe(false);
  });

  it('an array filter value is OR / set membership over a scalar record value', () => {
    const doc = { audience: 'base:42' };
    expect(matchesFilter(doc, { audience: ['public', 'base:42'] })).toBe(true);
    expect(matchesFilter(doc, { audience: ['public', 'role:ADMIN'] })).toBe(false);
  });

  it('an array filter value overlaps a multi-valued record value', () => {
    const doc = { audience: ['base:42', 'role:BASE_ADMIN'] };
    expect(matchesFilter(doc, { audience: ['public', 'role:BASE_ADMIN'] })).toBe(true);
    expect(matchesFilter(doc, { audience: ['public', 'role:HAF'] })).toBe(false);
  });

  it('an empty array matches nothing — the deny primitive', () => {
    expect(matchesFilter({ audience: 'public' }, { audience: [] })).toBe(false);
    expect(matchesFilter({ audience: ['public'] }, { audience: [] })).toBe(false);
  });

  it('ANDs multiple keys — a scalar and an array clause together', () => {
    const doc = { collectionId: 'c1', audience: 'role:ADMIN' };
    expect(matchesFilter(doc, { collectionId: 'c1', audience: ['public', 'role:ADMIN'] })).toBe(
      true,
    );
    expect(matchesFilter(doc, { collectionId: 'c2', audience: ['public', 'role:ADMIN'] })).toBe(
      false,
    );
    expect(matchesFilter(doc, { collectionId: 'c1', audience: ['public'] })).toBe(false);
  });
});

describe('MemoryVectorStore capability-token filtering (search)', () => {
  it('returns only the documents whose audience token the caller holds', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        { id: 'pub', text: 'shared onboarding guide', metadata: { audience: ['public'] } },
        { id: 'adm', text: 'shared admin runbook', metadata: { audience: ['role:ADMIN'] } },
        { id: 'b42', text: 'shared base 42 notes', metadata: { audience: ['base:42'] } },
      ],
      { embedder, store, chunkSize: 200 },
    );
    const retriever = new EmbeddingRetriever(embedder, store);

    // A base-42 user without the admin role: sees public + their base, never the admin doc.
    const tokens = ['public', 'role:BASE_USER', 'base:42'];
    const passages = await retriever.retrieve('shared', { topK: 10, filter: { audience: tokens } });
    const ids = [...new Set(passages.map((passage) => documentIdOf(passage.id)))].sort();
    expect(ids).toEqual(['b42', 'pub']);
  });

  it('an actor with no tokens (empty set) sees nothing', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments([{ id: 'pub', text: 'public doc', metadata: { audience: ['public'] } }], {
      embedder,
      store,
      chunkSize: 200,
    });
    const retriever = new EmbeddingRetriever(embedder, store);
    const passages = await retriever.retrieve('public', { topK: 10, filter: { audience: [] } });
    expect(passages).toEqual([]);
  });
});
