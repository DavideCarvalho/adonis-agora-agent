import { describe, expect, it } from 'vitest';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  QdrantClientLike,
  QdrantFilter,
  VectorStore,
} from '../src/index.js';
import {
  buildQdrantFilter,
  chunkIdToPointId,
  filterDeniesAll,
  MemoryVectorStore,
  PgVectorStore,
  QdrantStore,
  UnsafeRemovalError,
} from '../src/index.js';

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

/** Pull the `WHERE …` fragment out of a statement, stopping at whatever follows it. */
function whereOf(sql: string): string {
  const match = flat(sql).match(/\bWHERE\b(.*?)(?:\s+ORDER BY\b|\s+RETURNING\b|\s+LIMIT\b|$)/i);
  return match?.[1]?.trim() ?? '';
}

class RecordingQdrantClient implements QdrantClientLike {
  readonly calls: { method: string; args: unknown[] }[] = [];
  points = new Map<string, Record<string, unknown>>();
  countResult = 0;

  async getCollections() {
    return { collections: [{ name: 'rag' }] };
  }
  async createCollection() {
    return {};
  }
  async upsert(
    collection: string,
    args: { points: { id: string; payload: Record<string, unknown> }[] },
  ) {
    this.calls.push({ method: 'upsert', args: [collection, args] });
    for (const point of args.points) this.points.set(point.id, point.payload);
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
    args: { with_payload: boolean | string[]; with_vector: boolean; offset?: unknown },
  ) {
    this.calls.push({ method: 'scroll', args: [collection, args] });
    return {
      points: [...this.points.values()].map((payload) => ({ payload })),
    };
  }
  async count(collection: string, args: unknown) {
    this.calls.push({ method: 'count', args: [collection, args] });
    return { count: this.countResult };
  }
  lastArgs(method: string): unknown[] {
    const call = [...this.calls].reverse().find((c) => c.method === method);
    if (call === undefined) throw new Error(`no ${method} recorded`);
    return call.args;
  }
  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const E = [1, 0, 0, 0];

/**
 * The filters every parity assertion runs over. Deliberately includes the empty-array deny, a
 * multi-token array (set membership), a scalar, a combination, and a filter that matches nothing.
 */
const FILTERS: Record<string, unknown>[] = [
  { audience: ['public'] },
  { audience: ['public', 'role:ADMIN'] },
  { rev: 1 },
  { audience: ['public'], rev: 1 },
  { audience: ['nobody'] },
  { missing: 'x' },
  { audience: [] },
  // A deny COMBINED with a real constraint. This is the case that catches the classic wrong
  // "normalisation" of dropping empty-array keys: do that and this filter silently becomes `{ rev: 1 }`,
  // which matches most of the corpus instead of none of it.
  { audience: [], rev: 1 },
];

describe('filterDeniesAll', () => {
  it('is true exactly when some key carries an empty array', () => {
    expect(filterDeniesAll({ a: [] })).toBe(true);
    expect(filterDeniesAll({ a: 1, b: [] })).toBe(true);
    expect(filterDeniesAll({ a: ['x'] })).toBe(false);
    expect(filterDeniesAll({ a: 1 })).toBe(false);
    expect(filterDeniesAll({})).toBe(false);
  });
});

describe('MemoryVectorStore — listDocumentIds / removeWhere', () => {
  async function seeded() {
    const store = new MemoryVectorStore();
    await store.upsert([
      { id: 'alpha#0', text: 'a0', embedding: E, metadata: { audience: ['public'], rev: 1 } },
      { id: 'alpha#1', text: 'a1', embedding: E, metadata: { audience: ['public'], rev: 1 } },
      { id: 'beta#0', text: 'b0', embedding: E, metadata: { audience: ['role:ADMIN'], rev: 1 } },
      { id: 'gamma#0', text: 'g0', embedding: E, metadata: { audience: ['public'], rev: 2 } },
    ]);
    return store;
  }

  it('listDocumentIds reports exactly what listDocuments would, for every filter', async () => {
    const store = await seeded();
    for (const filter of [undefined, {}, ...FILTERS]) {
      const ids = await store.listDocumentIds(filter);
      const docs = await store.listDocuments(filter);
      expect([...ids].sort(), `filter=${JSON.stringify(filter)}`).toEqual(
        docs.map((d) => d.id).sort(),
      );
    }
  });

  it('listDocumentIds yields [] for an empty-array filter, exactly as search does', async () => {
    const store = await seeded();
    expect(await store.listDocumentIds({ audience: [] })).toEqual([]);
    expect(await store.search(E, { topK: 100, filter: { audience: [] } })).toEqual([]);
  });

  it('removeWhere removes EXACTLY the chunks search reaches with the same filter — and nothing else', async () => {
    for (const filter of FILTERS) {
      const store = await seeded();
      const all = (await store.search(E, { topK: 100 })).map((p) => p.id).sort();
      const reachable = (await store.search(E, { topK: 100, filter })).map((p) => p.id).sort();

      const removed = await store.removeWhere(filter);

      const survivors = (await store.search(E, { topK: 100 })).map((p) => p.id).sort();
      const label = `filter=${JSON.stringify(filter)}`;
      expect(removed, label).toBe(reachable.length);
      // Removed set === reachable set, and survivors === everything else. Both directions, so neither
      // over-deletion nor under-deletion can pass.
      expect(survivors, label).toEqual(all.filter((id) => !reachable.includes(id)));
    }
  });

  it('removeWhere on the empty-array deny removes NOTHING', async () => {
    const store = await seeded();
    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect((await store.search(E, { topK: 100 })).length).toBe(4);
  });

  it('removeWhere refuses an empty filter with UnsafeRemovalError instead of wiping the store', async () => {
    const store = await seeded();
    await expect(store.removeWhere({})).rejects.toThrow(UnsafeRemovalError);
    await expect(store.removeWhere({})).rejects.toThrow(/empty filter/i);
    expect((await store.search(E, { topK: 100 })).length).toBe(4);
    // The asymmetry is deliberate: search({}) means "no narrowing", removeWhere({}) would mean
    // "delete everything", so only the destructive one refuses.
    expect((await store.search(E, { topK: 100, filter: {} })).length).toBe(4);
  });

  it('carries the UnsafeRemovalError reason for a caller that wants to branch on it', async () => {
    const store = await seeded();
    await expect(store.removeWhere({})).rejects.toMatchObject({
      name: 'UnsafeRemovalError',
      reason: 'empty-filter',
    });
  });
});

describe('PgVectorStore — listDocumentIds / removeWhere SQL', () => {
  it('listDocumentIds selects DISTINCT ids and never touches the metadata column', async () => {
    const db = new RecordingDb([{ doc_id: 'alpha' }, { doc_id: 'beta' }]);
    const store = new PgVectorStore(db);
    expect(await store.listDocumentIds()).toEqual(['alpha', 'beta']);
    const sql = flat(db.last.sql);
    expect(sql).toContain("SELECT DISTINCT regexp_replace(id, '#[0-9]+$', '') AS doc_id");
    expect(sql).toContain('FROM agent_rag_chunks');
    expect(sql).toContain('ORDER BY doc_id');
    // The whole point: no metadata in the SELECT list, so nothing to transfer or parse.
    expect(sql.split(' FROM ')[0]).not.toContain('metadata');
  });

  it('removeWhere is ONE statement that deletes and counts (DELETE … RETURNING)', async () => {
    const db = new RecordingDb([{ id: 'alpha#0' }, { id: 'alpha#1' }]);
    const store = new PgVectorStore(db);
    expect(await store.removeWhere({ audience: ['public'] })).toBe(2);
    expect(db.calls).toHaveLength(1); // no count-then-delete
    const sql = flat(db.last.sql);
    expect(sql).toMatch(/^DELETE FROM agent_rag_chunks WHERE /);
    expect(sql).toContain('RETURNING id AS id');
  });

  /**
   * The parity proof for pgvector. For each filter, run `search` and `removeWhere` and compare the WHERE
   * fragment and the filter bindings VERBATIM. They come from the same `buildMetadataWhere` call, and this
   * is what pins that: change one path's predicate and this fails.
   */
  it('emits a byte-identical WHERE fragment and bindings to search, for every filter', async () => {
    for (const filter of FILTERS) {
      if (filterDeniesAll(filter)) continue; // short-circuited before any SQL; covered separately
      const searchDb = new RecordingDb();
      await new PgVectorStore(searchDb).search(E, { topK: 5, filter });
      const deleteDb = new RecordingDb();
      await new PgVectorStore(deleteDb).removeWhere(filter);

      const label = `filter=${JSON.stringify(filter)}`;
      expect(whereOf(deleteDb.last.sql), label).toBe(whereOf(searchDb.last.sql));
      // search binds [vector, ...filterBindings, vector, topK]; removeWhere binds just the filter's.
      const searchFilterBindings = searchDb.last.bindings.slice(1, -2);
      expect(deleteDb.last.bindings, label).toEqual(searchFilterBindings);
    }
  });

  it('short-circuits the empty-array deny without issuing any SQL at all', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);
    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect(db.calls).toHaveLength(0);
    // For the record: had it reached SQL, buildMetadataWhere would have emitted a `false` clause —
    // the same one search emits for that filter.
    const searchDb = new RecordingDb();
    await new PgVectorStore(searchDb).search(E, { topK: 5, filter: { audience: [] } });
    expect(whereOf(searchDb.last.sql)).toBe('false');
  });

  it('refuses an empty filter without issuing any SQL', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);
    await expect(store.removeWhere({})).rejects.toThrow(UnsafeRemovalError);
    expect(db.calls).toHaveLength(0);
  });
});

describe('QdrantStore — listDocumentIds / removeWhere', () => {
  async function seeded() {
    const client = new RecordingQdrantClient();
    const store = new QdrantStore(client, { collection: 'rag', dimension: 4 });
    await store.upsert([
      { id: 'alpha#0', text: 'a0', embedding: E, metadata: { audience: ['public'] } },
      { id: 'alpha#1', text: 'a1', embedding: E, metadata: { audience: ['public'] } },
      { id: 'beta#0', text: 'b0', embedding: E, metadata: { audience: ['role:ADMIN'] } },
    ]);
    client.calls.length = 0;
    return { client, store };
  }

  it('listDocumentIds scrolls one payload key and no vectors', async () => {
    const { client, store } = await seeded();
    expect((await store.listDocumentIds()).sort()).toEqual(['alpha', 'beta']);
    const [, args] = client.lastArgs('scroll');
    expect(args).toMatchObject({ with_payload: ['documentId'], with_vector: false });
  });

  it('removeWhere issues ONE filtered delete and never scrolls the points it removes', async () => {
    const { client, store } = await seeded();
    client.countResult = 2;
    expect(await store.removeWhere({ audience: ['public'] })).toBe(2);
    expect(client.countOf('delete')).toBe(1);
    expect(client.countOf('scroll')).toBe(0); // not an enumeration
    expect(client.countOf('count')).toBe(1); // the one extra aggregate round trip
    const [, args] = client.lastArgs('delete');
    expect(args).toMatchObject({ wait: true });
  });

  /**
   * The parity proof for Qdrant: the filter object handed to `delete` must be DEEPLY EQUAL to the one
   * handed to `query` for the same input. Both come from `buildQdrantFilter`; this pins it.
   */
  it('hands delete the identical filter object it hands search, for every filter', async () => {
    for (const filter of FILTERS) {
      if (filterDeniesAll(filter)) continue; // short-circuited before any call; covered separately
      const { client, store } = await seeded();
      await store.search(E, { topK: 5, filter });
      const [, queryArgs] = client.lastArgs('query');
      await store.removeWhere(filter);
      const [, deleteArgs] = client.lastArgs('delete');

      const label = `filter=${JSON.stringify(filter)}`;
      const queryFilter = (queryArgs as { filter?: QdrantFilter }).filter;
      const deleteFilter = (deleteArgs as { filter?: QdrantFilter }).filter;
      expect(deleteFilter, label).toEqual(queryFilter);
      expect(deleteFilter, label).toEqual(buildQdrantFilter(filter));
    }
  });

  it('short-circuits the empty-array deny without calling the client at all', async () => {
    const { client, store } = await seeded();
    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect(client.calls).toHaveLength(0);
    // And search's own encoding of that filter is the never-matching `any: []`.
    expect(buildQdrantFilter({ audience: [] })).toEqual({
      must: [{ key: 'metadata.audience', match: { any: [] } }],
    });
  });

  it('refuses an empty filter without calling the client', async () => {
    const { client, store } = await seeded();
    await expect(store.removeWhere({})).rejects.toThrow(UnsafeRemovalError);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses rather than guessing a count when the client has no `count`', async () => {
    const { client, store: _unused } = await seeded();
    const noCount = new Proxy(client, {
      get: (target, prop) => (prop === 'count' ? undefined : Reflect.get(target, prop)),
    }) as QdrantClientLike;
    const store = new QdrantStore(noCount, { collection: 'rag', dimension: 4 });
    await expect(store.removeWhere({ audience: ['public'] })).rejects.toThrow(/count/);
    expect(client.countOf('delete')).toBe(0); // nothing was deleted
  });

  it('derives point ids deterministically, so removeWhere needs no id from the wire', () => {
    expect(chunkIdToPointId('alpha#0')).toBe(chunkIdToPointId('alpha#0'));
  });
});

describe('the new capabilities are OPTIONAL on VectorStore', () => {
  it('a store implementing only the original four members still satisfies VectorStore', async () => {
    // The annotation is the assertion: a store with only the original four members must still be
    // assignable to `VectorStore`, or the additions were not optional.
    const minimal: VectorStore = {
      async upsert() {},
      async search() {
        return [];
      },
      async remove() {},
      async listDocuments() {
        return [];
      },
    };
    expect(minimal.updateMetadata).toBeUndefined();
    expect(minimal.listDocumentIds).toBeUndefined();
    expect(minimal.removeWhere).toBeUndefined();
    // A caller feature-detects the local way: optional call, no capability object, no type guard.
    expect(await minimal.listDocumentIds?.()).toBeUndefined();
    expect(await minimal.removeWhere?.({ a: 1 })).toBeUndefined();
    expect(await minimal.updateMetadata?.('d', { a: 1 })).toBeUndefined();
  });
});
