import { describe, expect, it } from 'vitest';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  QdrantClientLike,
  QdrantFilter,
} from '../src/index.js';
import {
  applyMetadataPatch,
  chunkIdToPointId,
  effectivePatchKeys,
  MemoryVectorStore,
  PgVectorStore,
  QdrantStore,
} from '../src/index.js';

/** Recording {@link LucidDatabaseLike} — mirrors the one in pg-vector-store.spec.ts. */
class RecordingDb implements LucidDatabaseLike {
  readonly calls: { sql: string; bindings: unknown[] }[] = [];
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  async rawQuery(sql: string, bindings: unknown[] = []): Promise<unknown> {
    this.calls.push({ sql, bindings });
    return { rows: this.rows };
  }
  from(_table: string): LucidQueryBuilderLike {
    throw new Error('unused');
  }
  table(_table: string): LucidInsertBuilderLike {
    throw new Error('unused');
  }
  transaction<T>(_callback: (trx: LucidClientLike) => Promise<T>): Promise<T> {
    throw new Error('unused');
  }
  get last(): { sql: string; bindings: unknown[] } {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error('no rawQuery recorded');
    return call;
  }
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Recording Qdrant fake with a `setPayload` that mutates an in-fake point table. */
class FakeQdrantClient implements QdrantClientLike {
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** pointId → { payload, vector } */
  readonly points = new Map<string, { payload: Record<string, unknown>; vector: number[] }>();

  async getCollections() {
    return { collections: [{ name: 'rag' }] };
  }
  async createCollection() {
    return {};
  }
  async upsert(
    collection: string,
    args: { points: { id: string; vector: number[]; payload: Record<string, unknown> }[] },
  ) {
    this.calls.push({ method: 'upsert', args: [collection, args] });
    for (const point of args.points) {
      this.points.set(point.id, { payload: point.payload, vector: point.vector });
    }
    return {};
  }
  async query(collection: string, args: unknown) {
    this.calls.push({ method: 'query', args: [collection, args] });
    return { points: [] };
  }
  async delete(collection: string, args: unknown) {
    this.calls.push({ method: 'delete', args: [collection, args] });
    return {};
  }
  async scroll(
    collection: string,
    args: {
      filter?: QdrantFilter;
      with_payload: boolean | string[];
      with_vector: boolean;
      limit: number;
      offset?: unknown;
    },
  ) {
    this.calls.push({ method: 'scroll', args: [collection, args] });
    const condition = args.filter?.must?.find((c) => c.key === 'documentId');
    const wanted =
      condition !== undefined && 'value' in condition.match ? condition.match.value : undefined;
    const points = [...this.points.entries()]
      .filter(([, p]) => wanted === undefined || p.payload.documentId === wanted)
      .map(([, p]) => ({
        payload: p.payload,
        ...(args.with_vector ? { vector: p.vector } : {}),
      }));
    return { points };
  }
  async setPayload(
    collection: string,
    args: { payload: Record<string, unknown>; points: string[]; wait?: boolean },
  ) {
    this.calls.push({ method: 'setPayload', args: [collection, args] });
    for (const pointId of args.points) {
      const point = this.points.get(pointId);
      if (point === undefined) throw new Error(`setPayload on unknown point ${pointId}`);
      // Real Qdrant semantics: merge at the TOP level of the payload only.
      point.payload = { ...point.payload, ...args.payload };
    }
    return {};
  }
  callCount(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  lastArgs(method: string): unknown[] {
    const call = [...this.calls].reverse().find((c) => c.method === method);
    if (call === undefined) throw new Error(`no ${method} recorded`);
    return call.args;
  }
}

const EMBEDDING_A = [1, 0, 0, 0];
const EMBEDDING_B = [0, 1, 0, 0];

describe('applyMetadataPatch / effectivePatchKeys — the shared merge, in one place', () => {
  it('replaces a key wholesale and leaves untouched keys alone', () => {
    expect(applyMetadataPatch({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 });
  });

  it('DELETES a key whose patch value is null (JSON Merge Patch, not "store a null")', () => {
    const out = applyMetadataPatch({ a: 1, b: 2 }, { a: null });
    expect(out).toEqual({ b: 2 });
    expect('a' in out).toBe(false);
  });

  it('ignores a key whose patch value is undefined', () => {
    expect(applyMetadataPatch({ a: 1 }, { a: undefined, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(effectivePatchKeys({ a: undefined, b: 2 })).toEqual(['b']);
    expect(effectivePatchKeys({ a: undefined })).toEqual([]);
    expect(effectivePatchKeys({ a: null })).toEqual(['a']);
  });

  it('is SHALLOW — arrays and nested objects are replaced, never merged into', () => {
    expect(applyMetadataPatch({ tags: ['a', 'b'] }, { tags: ['c'] })).toEqual({ tags: ['c'] });
    expect(
      applyMetadataPatch({ acl: { read: ['x'], write: ['y'] } }, { acl: { read: ['z'] } }),
    ).toEqual({
      acl: { read: ['z'] },
    });
  });

  it('gives a chunk with no metadata an object, and leaves {} when every key is deleted', () => {
    expect(applyMetadataPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(applyMetadataPatch({ a: 1 }, { a: null })).toEqual({});
  });

  it('never mutates its input', () => {
    const before = { a: 1, b: 2 };
    applyMetadataPatch(before, { a: 9, b: null, c: 3 });
    expect(before).toEqual({ a: 1, b: 2 });
  });
});

describe('MemoryVectorStore.updateMetadata', () => {
  async function seeded() {
    const store = new MemoryVectorStore();
    await store.upsert([
      {
        id: 'doc1#0',
        text: 'first chunk',
        embedding: EMBEDDING_A,
        source: 'R',
        metadata: { audience: 'public', rev: 1 },
      },
      {
        id: 'doc1#1',
        text: 'second chunk',
        embedding: EMBEDDING_B,
        source: 'R',
        metadata: { audience: 'public', rev: 1 },
      },
      {
        id: 'doc2#0',
        text: 'other doc',
        embedding: EMBEDDING_A,
        metadata: { audience: 'public', rev: 1 },
      },
    ]);
    return store;
  }

  it('returns the number of chunks written and rewrites all of them', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('doc1', { audience: 'role:ADMIN' })).toBe(2);
    const passages = await store.search(EMBEDDING_A, { topK: 10 });
    for (const id of ['doc1#0', 'doc1#1']) {
      expect(passages.find((p) => p.id === id)!.metadata).toEqual({
        audience: 'role:ADMIN',
        rev: 1,
      });
    }
  });

  it('leaves TEXT and SOURCE untouched', async () => {
    const store = await seeded();
    await store.updateMetadata('doc1', { audience: 'role:ADMIN' });
    const passages = await store.search(EMBEDDING_A, { topK: 10 });
    expect(passages.find((p) => p.id === 'doc1#0')!.text).toBe('first chunk');
    expect(passages.find((p) => p.id === 'doc1#1')!.text).toBe('second chunk');
    expect(passages.find((p) => p.id === 'doc1#0')!.source).toBe('R');
  });

  it('leaves the EMBEDDING untouched — the entire point of the feature', async () => {
    const store = await seeded();
    // Behavioural proof: a chunk searched with its OWN embedding scores cosine 1. Perturb the stored
    // vector at all and this drops.
    const before = await store.search(EMBEDDING_B, { topK: 1 });
    expect(before[0]!.id).toBe('doc1#1');
    expect(before[0]!.score).toBeCloseTo(1, 10);

    await store.updateMetadata('doc1', { audience: 'role:ADMIN', rev: 2 });

    const after = await store.search(EMBEDDING_B, { topK: 1 });
    expect(after[0]!.id).toBe('doc1#1');
    expect(after[0]!.score).toBeCloseTo(1, 10);

    // Structural proof: the stored record still holds the SAME array instance it was upserted with.
    const records = (store as unknown as { records: Map<string, { embedding: number[] }> }).records;
    expect(records.get('doc1#1')!.embedding).toBe(EMBEDDING_B);
    expect(records.get('doc1#0')!.embedding).toBe(EMBEDDING_A);
  });

  it('deletes a key when the patch value is null', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('doc1', { rev: null })).toBe(2);
    const passages = await store.search(EMBEDDING_A, { topK: 10 });
    expect(passages.find((p) => p.id === 'doc1#0')!.metadata).toEqual({ audience: 'public' });
  });

  it('touches only the named document', async () => {
    const store = await seeded();
    await store.updateMetadata('doc1', { audience: 'role:ADMIN' });
    const passages = await store.search(EMBEDDING_A, { topK: 10 });
    expect(passages.find((p) => p.id === 'doc2#0')!.metadata).toEqual({
      audience: 'public',
      rev: 1,
    });
  });

  it('returns 0 for an unknown document, without throwing', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
  });

  it('returns 0 for a patch with no effective keys, and writes nothing', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('doc1', {})).toBe(0);
    expect(await store.updateMetadata('doc1', { a: undefined })).toBe(0);
    const passages = await store.search(EMBEDDING_A, { topK: 10 });
    expect(passages.find((p) => p.id === 'doc1#0')!.metadata).toEqual({
      audience: 'public',
      rev: 1,
    });
  });

  it('makes the new value immediately filterable (the reason to stamp it on chunks at all)', async () => {
    const store = await seeded();
    await store.updateMetadata('doc1', { audience: 'role:ADMIN' });
    const admin = await store.search(EMBEDDING_A, { topK: 10, filter: { audience: 'role:ADMIN' } });
    expect(admin.map((p) => p.id).sort()).toEqual(['doc1#0', 'doc1#1']);
    const pub = await store.search(EMBEDDING_A, { topK: 10, filter: { audience: 'public' } });
    expect(pub.map((p) => p.id)).toEqual(['doc2#0']);
  });
});

describe('PgVectorStore.updateMetadata — the SQL', () => {
  it('merges in Postgres with `|| jsonb` and removes null keys with `- text[]`', async () => {
    const db = new RecordingDb([{ id: 'doc1#0' }, { id: 'doc1#1' }]);
    const store = new PgVectorStore(db);

    const written = await store.updateMetadata('doc1', { audience: 'role:ADMIN', rev: null });

    expect(written).toBe(2);
    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('UPDATE agent_rag_chunks');
    expect(flat(sql)).toContain(
      "SET metadata = (COALESCE(metadata, '{}'::jsonb) || ?::jsonb) - ?::text[]",
    );
    expect(flat(sql)).toContain("WHERE regexp_replace(id, '#[0-9]+$', '') = ?");
    expect(flat(sql)).toContain('RETURNING id AS id');
    expect(bindings).toEqual([JSON.stringify({ audience: 'role:ADMIN' }), ['rev'], 'doc1']);
  });

  it('never names the embedding or text column in the SET clause', async () => {
    const db = new RecordingDb([{ id: 'doc1#0' }]);
    const store = new PgVectorStore(db);
    await store.updateMetadata('doc1', { audience: 'x' });
    const setClause = flat(db.last.sql).split('SET ')[1]!.split(' WHERE ')[0]!;
    // Exactly one column is assigned, and it is the metadata one. (`?::text[]` legitimately contains
    // the word "text", so match an ASSIGNMENT to the text column rather than the substring.)
    expect(setClause.startsWith('metadata = ')).toBe(true);
    expect(setClause).not.toMatch(/\btext\s*=/);
    expect(setClause).not.toContain('embedding');
    // And nothing resembling a vector literal is bound.
    expect(db.last.sql).not.toContain('::vector');
    expect(db.last.bindings.some((b) => typeof b === 'string' && b.startsWith('['))).toBe(false);
  });

  it('honours overridden column names', async () => {
    const db = new RecordingDb([{ id: 'c1' }]);
    const store = new PgVectorStore(db, {
      columns: { id: 'chunk_id', metadata: 'meta', embedding: 'vec', text: 'body' },
    });
    await store.updateMetadata('doc1', { a: 1 });
    expect(flat(db.last.sql)).toContain("SET meta = (COALESCE(meta, '{}'::jsonb) || ?::jsonb)");
    expect(flat(db.last.sql)).toContain("regexp_replace(chunk_id, '#[0-9]+$', '') = ?");
  });

  it('issues NO query at all for a patch with no effective keys', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);
    expect(await store.updateMetadata('doc1', {})).toBe(0);
    expect(await store.updateMetadata('doc1', { a: undefined })).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it('returns 0 when the UPDATE matched nothing', async () => {
    const db = new RecordingDb([]);
    const store = new PgVectorStore(db);
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
  });
});

describe('QdrantStore.updateMetadata', () => {
  async function seeded() {
    const client = new FakeQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 4 });
    await store.upsert([
      {
        id: 'doc1#0',
        text: 'first chunk',
        embedding: EMBEDDING_A,
        metadata: { audience: 'public', rev: 1 },
      },
      {
        id: 'doc1#1',
        text: 'second chunk',
        embedding: EMBEDDING_B,
        metadata: { audience: 'public', rev: 1 },
      },
      {
        id: 'doc2#0',
        text: 'other doc',
        embedding: EMBEDDING_A,
        metadata: { audience: 'public', rev: 1 },
      },
    ]);
    client.calls.length = 0;
    return { client, store };
  }

  it('writes via setPayload — never upsert — and returns the chunk count', async () => {
    const { client, store } = await seeded();
    expect(await store.updateMetadata('doc1', { audience: 'role:ADMIN' })).toBe(2);
    expect(client.callCount('upsert')).toBe(0);
    expect(client.callCount('setPayload')).toBe(1); // one write: both chunks land on the same metadata
    const [, args] = client.lastArgs('setPayload');
    expect(args).toMatchObject({
      payload: { metadata: { audience: 'role:ADMIN', rev: 1 } },
      wait: true,
    });
  });

  it('scrolls WITHOUT vectors and asks only for the payload keys it needs', async () => {
    const { client, store } = await seeded();
    await store.updateMetadata('doc1', { audience: 'role:ADMIN' });
    const [, args] = client.lastArgs('scroll');
    expect(args).toMatchObject({
      with_vector: false,
      with_payload: ['id', 'metadata'],
      filter: { must: [{ key: 'documentId', match: { value: 'doc1' } }] },
    });
  });

  it('leaves the vector and the text byte-identical', async () => {
    const { client, store } = await seeded();
    const pointA = chunkIdToPointId('doc1#0');
    const pointB = chunkIdToPointId('doc1#1');
    const vectorABefore = client.points.get(pointA)!.vector;
    const vectorBBefore = client.points.get(pointB)!.vector;

    await store.updateMetadata('doc1', { audience: 'role:ADMIN', rev: 2 });

    expect(client.points.get(pointA)!.vector).toEqual(EMBEDDING_A);
    expect(client.points.get(pointB)!.vector).toEqual(EMBEDDING_B);
    // Same instance: setPayload cannot have replaced it.
    expect(client.points.get(pointA)!.vector).toBe(vectorABefore);
    expect(client.points.get(pointB)!.vector).toBe(vectorBBefore);
    expect(client.points.get(pointA)!.payload.text).toBe('first chunk');
    expect(client.points.get(pointB)!.payload.text).toBe('second chunk');
    expect(client.points.get(pointA)!.payload.metadata).toEqual({ audience: 'role:ADMIN', rev: 2 });
  });

  it('deletes a key on null, and leaves other documents alone', async () => {
    const { client, store } = await seeded();
    expect(await store.updateMetadata('doc1', { rev: null })).toBe(2);
    expect(client.points.get(chunkIdToPointId('doc1#0'))!.payload.metadata).toEqual({
      audience: 'public',
    });
    expect(client.points.get(chunkIdToPointId('doc2#0'))!.payload.metadata).toEqual({
      audience: 'public',
      rev: 1,
    });
  });

  it('splits into one setPayload per distinct resulting metadata', async () => {
    const client = new FakeQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 4 });
    await store.upsert([
      { id: 'doc1#0', text: 'a', embedding: EMBEDDING_A, metadata: { rev: 1 } },
      { id: 'doc1#1', text: 'b', embedding: EMBEDDING_B, metadata: { rev: 2 } },
    ]);
    client.calls.length = 0;
    expect(await store.updateMetadata('doc1', { audience: 'x' })).toBe(2);
    // Different `rev` per chunk → two distinct outcomes → two writes.
    expect(client.callCount('setPayload')).toBe(2);
  });

  it('returns 0 for an unknown document and for an empty patch, touching the client only for the former', async () => {
    const { client, store } = await seeded();
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
    expect(client.callCount('setPayload')).toBe(0);
    client.calls.length = 0;
    expect(await store.updateMetadata('doc1', { a: undefined })).toBe(0);
    expect(client.calls).toHaveLength(0); // no round trip at all for a no-op patch
  });

  it('refuses rather than degrading when the client has no setPayload', async () => {
    const { client } = await seeded();
    const noSetPayload = new Proxy(client, {
      get: (target, prop) => (prop === 'setPayload' ? undefined : Reflect.get(target, prop)),
    }) as QdrantClientLike;
    const store = new QdrantStore(noSetPayload, { collection: 'rag', dimension: 4 });
    await expect(store.updateMetadata('doc1', { a: 1 })).rejects.toThrow(/setPayload/);
    // It did NOT silently fall back to upsert (which would rewrite the embedding).
    expect(client.callCount('upsert')).toBe(0);
  });
});
