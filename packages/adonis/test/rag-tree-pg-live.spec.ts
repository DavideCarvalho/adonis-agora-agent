import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDocumentTree,
  indexDocumentTree,
  keywordTreeLlm,
  PgDocumentTreeStore,
  TreeNavigationRetriever,
} from '../src/index.js';
import { CONTAINER, PsqlDockerDb } from './helpers/psql-docker-db.js';

// Live-Postgres verification of PgDocumentTreeStore's REAL SQL — DDL, round trip, filters with the
// vector store's semantics, unit ranges, replacement, NUL bytes, navigation end to end. Skipped
// unless AGENT_PG_DOCKER names a running Postgres container (see ./helpers/psql-docker-db.ts).
const TABLE = `agent_rag_trees_live_${process.pid}`;

const pages = [
  '# Scope\nThis regulation applies to federal construction contracts.',
  '# Bonds\nPerformance bonds are required above the threshold.',
  'Payment bonds protect suppliers of labor and material.',
  '# Insurance\nThe contractor shall maintain liability insurance.',
];

describe.skipIf(CONTAINER === undefined)('PgDocumentTreeStore against a live Postgres', () => {
  let db: PsqlDockerDb;
  let store: PgDocumentTreeStore;

  beforeAll(async () => {
    db = new PsqlDockerDb();
    store = new PgDocumentTreeStore(db, { table: TABLE });
    await store.ensureSchema();
    await store.ensureSchema(); // idempotent
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.rawQuery(`DROP TABLE IF EXISTS ${TABLE}`);
      await db.rawQuery(`DROP TABLE IF EXISTS ${TABLE}_units`);
    }
  });

  it('round-trips a tree and its units, and reads unit ranges in order', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages, title: 'Construction' },
      { documentId: 'doc-1', metadata: { tenant: 't1', audience: ['public'] }, source: 'c.pdf' },
    );
    await store.put(tree, units);
    expect(await store.get('doc-1')).toEqual(tree);
    expect((await store.readUnits('doc-1', 1, 2)).map((unit) => [unit.index, unit.page])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(await store.readUnits('missing', 0, 10)).toEqual([]);
  });

  it('filters with vector-store semantics: scalar, match-any (array metadata too), empty-array deny', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages },
      { documentId: 'doc-2', metadata: { tenant: 't2', audience: ['staff', 'admin'] } },
    );
    await store.put(tree, units);
    expect(await store.get('doc-1', { tenant: 't1' })).toBeDefined();
    expect(await store.get('doc-1', { tenant: 't2' })).toBeUndefined();
    expect(await store.getMany(['doc-1', 'doc-2'], { tenant: ['t1', 't2'] })).toHaveLength(2);
    expect(
      (await store.getMany(['doc-1', 'doc-2'], { audience: ['admin'] })).map((t) => t.documentId),
    ).toEqual(['doc-2']);
    expect(await store.getMany(['doc-1', 'doc-2'], { tenant: [] })).toEqual([]);
    expect(await store.list({ filter: { tenant: [] } })).toEqual([]);
    const headers = await store.list({ filter: { tenant: 't1' } });
    expect(headers.map((header) => [header.documentId, header.title, header.source])).toEqual([
      ['doc-1', 'Construction', 'c.pdf'],
    ]);
    expect((await store.list({ documentIds: ['doc-2', 'nope'] })).map((h) => h.documentId)).toEqual(
      ['doc-2'],
    );
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  it('replaces units on put, strips NUL bytes, and removes', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages: ['# Only\nshort\u0000 text'] },
      { documentId: 'doc-2', metadata: { tenant: 't2' } },
    );
    await store.put(tree, units);
    expect((await store.readUnits('doc-2', 0, 100)).map((unit) => unit.text)).toEqual([
      '# Only\nshort text',
    ]);
    await store.remove('doc-2');
    expect(await store.get('doc-2')).toBeUndefined();
    expect(await store.readUnits('doc-2', 0, 100)).toEqual([]);
  });

  it('serves navigation end to end, with the tenant filter applied in SQL', async () => {
    await indexDocumentTree(
      { pages, title: 'Construction' },
      { store, documentId: 'reg', minUnits: 1, metadata: { tenant: 't1' } },
    );
    const navigator = new TreeNavigationRetriever({ store, llm: keywordTreeLlm(), maxNodes: 1 });
    const result = await navigator.navigate('payment bonds suppliers', ['reg'], {
      filter: { tenant: 't1' },
    });
    expect(result.passages[0]?.metadata).toMatchObject({
      title: 'Bonds',
      pageStart: 2,
      pageEnd: 3,
    });
    expect(result.passages[0]?.text).toContain('Payment bonds protect suppliers');
    const denied = await navigator.navigate('payment bonds', ['reg'], { filter: { tenant: 't9' } });
    expect(denied.passages).toEqual([]);
  });

  it('rejects an unsafe table name', () => {
    expect(() => new PgDocumentTreeStore(db, { table: 'trees; DROP TABLE x' })).toThrow(
      /invalid table/,
    );
  });
});
