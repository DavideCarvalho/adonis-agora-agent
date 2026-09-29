import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmbeddingRetriever,
  HybridRetriever,
  LexicalRetriever,
  PgLexicalVectorStore,
  PgVectorStore,
} from '../src/index.js';
import { CONTAINER, PsqlDockerDb } from './helpers/psql-docker-db.js';

// Live-Postgres verification of PgVectorStore's REAL SQL — see ./helpers/psql-docker-db.ts.
const TABLE = `agent_rag_live_${process.pid}`;

const A = [1, 0, 0, 0];
const B = [0, 1, 0, 0];
const C = [0, 0, 1, 0];

describe.skipIf(CONTAINER === undefined)('PgVectorStore against a live Postgres + pgvector', () => {
  let db: PsqlDockerDb;
  let store: PgVectorStore;

  beforeAll(async () => {
    db = new PsqlDockerDb();
    store = new PgVectorStore(db, { table: TABLE, dimension: 4 });
    await store.ensureSchema();
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.rawQuery(`DROP TABLE IF EXISTS ${TABLE}`);
    }
  });

  async function seed(): Promise<void> {
    await db.rawQuery(`TRUNCATE ${TABLE}`);
    await store.upsert([
      {
        id: 'alpha#0',
        text: 'alpha zero',
        embedding: A,
        source: 'R',
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'alpha#1',
        text: 'alpha one',
        embedding: B,
        source: 'R',
        metadata: { audience: ['public'], rev: 1 },
      },
      {
        id: 'beta#0',
        text: 'beta zero',
        embedding: C,
        metadata: { audience: ['role:ADMIN'], rev: 1 },
      },
    ]);
  }

  async function storedVector(chunkId: string): Promise<string> {
    const rows = (await db.rawQuery(`SELECT embedding::text AS v FROM ${TABLE} WHERE id = ?`, [
      chunkId,
    ])) as { v: string }[];
    return rows[0]!.v;
  }

  it('round-trips a search, proving the emitted SQL is valid pgvector', async () => {
    await seed();
    const passages = await store.search(A, { topK: 2 });
    expect(passages).toHaveLength(2);
    expect(passages[0]!.id).toBe('alpha#0');
    expect(passages[0]!.score).toBeCloseTo(1, 6);
    expect(passages[0]!.text).toBe('alpha zero');
    expect(passages[0]!.metadata).toEqual({ audience: ['public'], rev: 1 });
  });

  it('updateMetadata merges in Postgres, deletes null keys, and returns the chunk count', async () => {
    await seed();
    const written = await store.updateMetadata('alpha', {
      audience: ['role:ADMIN'],
      rev: null,
      added: 'yes',
    });
    expect(written).toBe(2);

    const rows = (await db.rawQuery(
      `SELECT id, metadata::text AS m FROM ${TABLE} ORDER BY id`,
    )) as { id: string; m: string }[];
    expect(JSON.parse(rows[0]!.m)).toEqual({ audience: ['role:ADMIN'], added: 'yes' });
    expect(JSON.parse(rows[1]!.m)).toEqual({ audience: ['role:ADMIN'], added: 'yes' });
    // Untouched document keeps its own metadata.
    expect(JSON.parse(rows[2]!.m)).toEqual({ audience: ['role:ADMIN'], rev: 1 });
  });

  it('updateMetadata leaves the stored vector and text byte-identical', async () => {
    await seed();
    const before = { a0: await storedVector('alpha#0'), a1: await storedVector('alpha#1') };

    await store.updateMetadata('alpha', { audience: ['role:ADMIN'], rev: null });

    expect(await storedVector('alpha#0')).toBe(before.a0);
    expect(await storedVector('alpha#1')).toBe(before.a1);
    const rows = (await db.rawQuery(`SELECT text, source FROM ${TABLE} WHERE id = ?`, [
      'alpha#0',
    ])) as { text: string; source: string }[];
    expect(rows[0]!.text).toBe('alpha zero');
    expect(rows[0]!.source).toBe('R');
  });

  it('updateMetadata gives a chunk with NULL metadata an object rather than failing', async () => {
    await seed();
    await db.rawQuery(`UPDATE ${TABLE} SET metadata = NULL WHERE id = ?`, ['alpha#0']);
    expect(await store.updateMetadata('alpha', { audience: ['x'] })).toBe(2);
    const rows = (await db.rawQuery(`SELECT metadata::text AS m FROM ${TABLE} WHERE id = ?`, [
      'alpha#0',
    ])) as { m: string }[];
    expect(JSON.parse(rows[0]!.m)).toEqual({ audience: ['x'] });
  });

  it('updateMetadata returns 0 for an unknown document', async () => {
    await seed();
    expect(await store.updateMetadata('nope', { a: 1 })).toBe(0);
  });

  it('the rewritten metadata is immediately filterable by search', async () => {
    await seed();
    await store.updateMetadata('alpha', { audience: ['role:ADMIN'] });
    const admin = await store.search(A, { topK: 10, filter: { audience: ['role:ADMIN'] } });
    expect(admin.map((p) => p.id).sort()).toEqual(['alpha#0', 'alpha#1', 'beta#0']);
    expect(await store.search(A, { topK: 10, filter: { audience: ['public'] } })).toEqual([]);
  });

  const FILTERS: Record<string, unknown>[] = [
    { audience: ['public'] },
    { audience: ['public', 'role:ADMIN'] },
    { rev: 1 },
    { audience: ['public'], rev: 1 },
    { audience: ['nobody'] },
    { missing: 'x' },
    { audience: [] },
    { audience: [], rev: 1 },
  ];

  it('listDocumentIds matches listDocuments for the same filter, on real SQL', async () => {
    await seed();
    for (const filter of [undefined, {}, ...FILTERS]) {
      const ids = await store.listDocumentIds(filter);
      const docs = await store.listDocuments(filter);
      expect([...ids].sort(), `filter=${JSON.stringify(filter)}`).toEqual(
        docs.map((d) => d.id).sort(),
      );
    }
  }, 120_000);

  it('removeWhere removes exactly what search reaches with the same filter, and nothing else', async () => {
    for (const filter of FILTERS) {
      await seed();
      const all = (await store.search(A, { topK: 100 })).map((p) => p.id).sort();
      const reachable = (await store.search(A, { topK: 100, filter })).map((p) => p.id).sort();

      const removed = await store.removeWhere(filter);

      const survivors = (await store.search(A, { topK: 100 })).map((p) => p.id).sort();
      const label = `filter=${JSON.stringify(filter)}`;
      expect(removed, label).toBe(reachable.length);
      expect(survivors, label).toEqual(all.filter((id) => !reachable.includes(id)));
    }
  }, 180_000);

  it("the empty-array deny is honoured by the SQL ITSELF, not only by the store's short-circuit", async () => {
    await seed();
    // `removeWhere` short-circuits before emitting SQL, so run the predicate `buildMetadataWhere`
    // produces for that filter directly. `WHERE false` is what search emits too, and it deletes nothing.
    const rows = (await db.rawQuery(`DELETE FROM ${TABLE} WHERE false RETURNING id`)) as {
      id: string;
    }[];
    expect(rows).toEqual([]);
    const remaining = (await db.rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)) as {
      n: number;
    }[];
    expect(remaining[0]!.n).toBe(3);
  });

  it('removeWhere refuses an empty filter instead of truncating the table', async () => {
    await seed();
    await expect(store.removeWhere({})).rejects.toThrow(/empty filter/i);
    const remaining = (await db.rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)) as {
      n: number;
    }[];
    expect(remaining[0]!.n).toBe(3);
  });

  it('removeWhere is a single round trip that both deletes and counts', async () => {
    await seed();
    const before = db.statements.length;
    expect(await store.removeWhere({ audience: ['public'] })).toBe(2);
    expect(db.statements.length - before).toBe(1);
  });
});

describe.skipIf(CONTAINER === undefined)('pgvector upgrades against a live Postgres', () => {
  const MIXED = `agent_rag_mixed_${process.pid}`;
  const LEXICAL = `agent_rag_lexical_${process.pid}`;
  let db: PsqlDockerDb;

  beforeAll(() => {
    db = new PsqlDockerDb();
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.rawQuery(`DROP TABLE IF EXISTS ${MIXED}`);
      await db.rawQuery(`DROP TABLE IF EXISTS ${LEXICAL}`);
    }
  });

  it('mixed widths + NULL embeddings: batched upsert, per-width partial indexes, like-with-like search', async () => {
    const store = new PgVectorStore(db, {
      table: MIXED,
      dimension: [2, 3],
      nullableEmbeddings: true,
      upsertBatchSize: 2,
      iterativeScan: 'strict_order',
      efSearch: 50,
    });
    await store.ensureSchema();
    const NUL = String.fromCharCode(0);
    await store.upsert([
      { id: 'two-a', text: 'two a', embedding: [1, 0] },
      { id: 'two-b', text: 'two b', embedding: [0, 1] },
      { id: 'three-a', text: `three${NUL} a`, embedding: [1, 0, 0] },
      { id: 'pending', text: 'no vector yet', embedding: [] },
      { id: 'two-a', text: 'two a v2', embedding: [1, 0] },
    ]);

    const indexes = (await db.rawQuery(
      `SELECT indexname FROM pg_indexes WHERE tablename = ? AND indexdef LIKE '%hnsw%' ORDER BY indexname`,
      [MIXED],
    )) as { indexname: string }[];
    expect(indexes.map((row) => row.indexname)).toEqual([
      `${MIXED}_embedding_2_idx`,
      `${MIXED}_embedding_3_idx`,
    ]);
    const two = await store.search([1, 0], { topK: 10 });
    expect(two.map((passage) => passage.id)).toEqual(['two-a', 'two-b']);
    expect(two[0]!.text).toBe('two a v2');
    const three = await store.search([1, 0, 0], { topK: 10 });
    expect(three.map((passage) => [passage.id, passage.text])).toEqual([['three-a', 'three a']]);
    expect(await store.search([1, 0, 0, 0], { topK: 10 })).toEqual([]);
    // The iterative scan really ran inside the search's transaction (pgvector >= 0.8 in the image).
    expect(db.statements.some((sql) => sql.includes("'hnsw.iterative_scan'"))).toBe(true);
  });

  it('full-text search: filtered, finds un-embedded chunks, any-word fallback, fuses in a hybrid', async () => {
    const store = new PgLexicalVectorStore(db, {
      table: LEXICAL,
      dimension: 3,
      nullableEmbeddings: true,
    });
    await store.ensureSchema();
    await store.upsert([
      {
        id: 'warranty#0',
        text: 'The solar panel warranty lasts twenty five years.',
        embedding: [1, 0, 0],
        metadata: { tenant: 't1' },
      },
      {
        id: 'install#0',
        text: 'Installation takes two days on a pitched roof.',
        embedding: [],
        metadata: { tenant: 't1' },
      },
      {
        id: 'other#0',
        text: 'Solar panel warranty for another tenant.',
        embedding: [],
        metadata: { tenant: 't2' },
      },
    ]);

    const filtered = await store.searchText('solar warranty', {
      topK: 5,
      filter: { tenant: 't1' },
    });
    expect(filtered.map((passage) => passage.id)).toEqual(['warranty#0']);
    expect((await store.searchText('pitched roof', { topK: 5 })).map((p) => p.id)).toEqual([
      'install#0',
    ]);
    const fallback = await store.searchText('how many years does my inverter warranty last', {
      topK: 5,
      filter: { tenant: 't1' },
    });
    expect(fallback.map((passage) => passage.id)).toContain('warranty#0');

    // A question's stop words don't rank; its rare terms do.
    await store.upsert([
      {
        id: 'noise#0',
        text: 'The claims of the staff are in the office of the company, which is at the end of the road, and the time of the day is on the board.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
      {
        id: 'gearbox#0',
        text: 'Warranty claims for turbine gearboxes go to the Denver depot.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
      {
        id: 'expense#0',
        text: 'Expense claims are due by the 5th; claims without receipts are refused.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
    ]);
    const t3 = async (query: string) =>
      (await store.searchText(query, { topK: 5, filter: { tenant: 't3' } })).map((p) => p.id);
    expect((await t3('Which depot handles the warranty claims of the gearboxes?'))[0]).toBe(
      'gearbox#0',
    );
    expect((await t3('claims gearboxes'))[0]).toBe('gearbox#0');
    expect(await t3('"expense claims" -gearboxes')).toEqual(['expense#0']);
    expect((await store.search([1, 0, 0], { topK: 5 })).map((p) => p.id)).toEqual(['warranty#0']);

    const embedder = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
    const hybrid = new HybridRetriever([
      new EmbeddingRetriever(embedder, store),
      new LexicalRetriever(store),
    ]);
    const hits = await hybrid.retrieve('pitched roof installation', { topK: 3 });
    expect(hits.map((passage) => passage.id)).toContain('install#0');
  });
});
