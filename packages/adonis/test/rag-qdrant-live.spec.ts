import { QdrantClient } from '@qdrant/js-client-rest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QdrantClientLike } from '../src/index.js';
import { chunkIdToPointId, QdrantStore } from '../src/index.js';

/**
 * Live-Qdrant verification for the store capabilities that a fake cannot honestly prove: whether
 * `set_payload` really leaves the vector alone, and whether a filtered `delete` really honours the
 * empty-array deny the same way `query` does. A fake proves only that we CALL the client a certain way;
 * these prove the server does what we think it does with that call.
 *
 * Skipped unless `AGENT_QDRANT_URL` points at a throwaway Qdrant (it creates and drops its own
 * collection):
 *
 *   docker run -d -p 6399:6333 qdrant/qdrant
 *   AGENT_QDRANT_URL=http://127.0.0.1:6399 npx vitest run test/rag-qdrant-live.spec.ts
 */
const URL = process.env.AGENT_QDRANT_URL;
const COLLECTION = `agent_rag_live_${process.pid}`;
const DIM = 4;

const A = [1, 0, 0, 0];
const B = [0, 1, 0, 0];
const C = [0, 0, 1, 0];

describe.skipIf(URL === undefined)('QdrantStore against a live Qdrant', () => {
  let raw: QdrantClient;
  let client: QdrantClientLike;
  let store: QdrantStore;

  beforeAll(async () => {
    raw = new QdrantClient({ url: String(URL) });
    client = raw as unknown as QdrantClientLike;
    store = new QdrantStore(client, { collection: COLLECTION, dimension: DIM });
    await store.ensureCollection();
  });

  afterAll(async () => {
    if (raw !== undefined) {
      await raw.deleteCollection(COLLECTION).catch(() => undefined);
    }
  });

  /** Re-seed a known corpus, waiting for it to be visible. */
  async function seed(): Promise<void> {
    await raw.delete(COLLECTION, { filter: {}, wait: true }).catch(() => undefined);
    await store.upsert([
      {
        id: 'alpha#0',
        text: 'alpha zero',
        embedding: A,
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'alpha#1',
        text: 'alpha one',
        embedding: B,
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'beta#0',
        text: 'beta zero',
        embedding: C,
        metadata: { audience: ['role:ADMIN'], rev: 1 },
      },
    ]);
    // upsert does not pass `wait`, so give Qdrant a beat to index before asserting.
    for (let i = 0; i < 50; i++) {
      const { count } = await raw.count(COLLECTION, { exact: true });
      if (count === 3) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('seed did not become visible');
  }

  async function vectorOf(chunkId: string): Promise<number[]> {
    const result = await raw.retrieve(COLLECTION, {
      ids: [chunkIdToPointId(chunkId)],
      with_vector: true,
      with_payload: true,
    });
    const vector = result[0]?.vector;
    if (!Array.isArray(vector)) throw new Error(`no vector for ${chunkId}`);
    return vector as number[];
  }

  it('updateMetadata leaves the stored vectors byte-identical (real set_payload)', async () => {
    await seed();
    const before = { a0: await vectorOf('alpha#0'), a1: await vectorOf('alpha#1') };
    expect(before.a0).toEqual(A);

    const written = await store.updateMetadata('alpha', { audience: ['role:ADMIN'], rev: null });
    expect(written).toBe(2);

    expect(await vectorOf('alpha#0')).toEqual(before.a0);
    expect(await vectorOf('alpha#1')).toEqual(before.a1);
  });

  it('updateMetadata rewrites metadata, deletes null keys, and keeps text/source', async () => {
    await seed();
    await store.updateMetadata('alpha', { audience: ['role:ADMIN'], rev: null, added: 'yes' });

    const points = await raw.retrieve(COLLECTION, {
      ids: [chunkIdToPointId('alpha#0')],
      with_payload: true,
    });
    expect(points[0]!.payload).toMatchObject({
      id: 'alpha#0',
      documentId: 'alpha',
      text: 'alpha zero',
      metadata: { audience: ['role:ADMIN'], added: 'yes' },
    });
    expect(
      (points[0]!.payload as { metadata: Record<string, unknown> }).metadata.rev,
    ).toBeUndefined();
  });

  it('the rewritten metadata is immediately filterable by search', async () => {
    await seed();
    await store.updateMetadata('alpha', { audience: ['role:ADMIN'] });
    const admin = await store.search(A, { topK: 10, filter: { audience: ['role:ADMIN'] } });
    expect(admin.map((p) => p.id).sort()).toEqual(['alpha#0', 'alpha#1', 'beta#0']);
    const pub = await store.search(A, { topK: 10, filter: { audience: ['public'] } });
    expect(pub).toEqual([]);
  });

  it('updateMetadata on an unknown document returns 0', async () => {
    await seed();
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
  });

  it('listDocumentIds matches listDocuments for the same filter', async () => {
    await seed();
    for (const filter of [
      undefined,
      {},
      { audience: ['public'] },
      { audience: ['role:ADMIN'] },
      { rev: 1 },
      { audience: ['nobody'] },
      { audience: [] },
      { audience: [], rev: 1 },
    ]) {
      const ids = await store.listDocumentIds(filter);
      const docs = await store.listDocuments(filter);
      expect([...ids].sort(), `filter=${JSON.stringify(filter)}`).toEqual(
        docs.map((d) => d.id).sort(),
      );
    }
  });

  it('an empty-array filter denies on the live server for search AND for removeWhere', async () => {
    await seed();
    // This is the assertion a fake cannot make: that Qdrant itself treats `any: []` as "matches
    // nothing" rather than erroring or matching everything.
    expect(await store.search(A, { topK: 10, filter: { audience: [] } })).toEqual([]);
    expect(await store.listDocumentIds({ audience: [] })).toEqual([]);
    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect(await store.removeWhere({ audience: [], rev: 1 })).toBe(0);
    expect(await store.search(A, { topK: 10, filter: { audience: [], rev: 1 } })).toEqual([]);
    // Nothing was removed.
    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(3);
  });

  it('removeWhere removes exactly what search with the same filter reaches, and nothing else', async () => {
    await seed();
    const reachable = await store.search(A, { topK: 100, filter: { audience: ['public'] } });
    expect(reachable.map((p) => p.id).sort()).toEqual(['alpha#0', 'alpha#1']);

    const removed = await store.removeWhere({ audience: ['public'] });
    expect(removed).toBe(2);

    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(1);
    const survivors = await store.search(C, { topK: 100 });
    expect(survivors.map((p) => p.id)).toEqual(['beta#0']);
  });

  it('removeWhere refuses an empty filter instead of wiping the collection', async () => {
    await seed();
    await expect(store.removeWhere({})).rejects.toThrow(/empty filter/i);
    expect((await raw.count(COLLECTION, { exact: true })).count).toBe(3);
  });

  it('removeMany-by-enumeration still works: listDocumentIds then removeWhere on a scoping key', async () => {
    await seed();
    expect((await store.listDocumentIds()).sort()).toEqual(['alpha', 'beta']);
    expect(await store.removeWhere({ rev: 1 })).toBe(3);
    expect(await store.listDocumentIds()).toEqual([]);
  });
});
