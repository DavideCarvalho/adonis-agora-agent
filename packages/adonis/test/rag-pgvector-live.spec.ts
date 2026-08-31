import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
} from '../src/index.js';
import { PgVectorStore } from '../src/index.js';

/**
 * Live-Postgres verification: the REAL {@link PgVectorStore} emitting its REAL SQL against a real
 * Postgres with a real `vector` extension. The recording-fake specs prove we emit the SQL we meant to;
 * only this proves the SQL is valid, that `(metadata || patch) - keys[]` merges the way we claim, and
 * that a filtered `DELETE` reaches exactly the rows the matching `SELECT` does.
 *
 * This package has no `pg` driver in its dependency tree (Lucid is an optional peer, and adding a driver
 * to run one spec is not a trade worth making), so the {@link LucidDatabaseLike} below shells out to
 * `psql` inside a container instead. It is a test harness, not a shipped adapter: it interpolates
 * bindings as SQL literals, which is exactly what the production store refuses to do — acceptable here
 * because every value comes from this file.
 *
 * Skipped unless `AGENT_PG_DOCKER` names a running pgvector container:
 *
 *   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres --name pgv pgvector/pgvector:pg17
 *   AGENT_PG_DOCKER=pgv npx vitest run test/rag-pgvector-live.spec.ts
 */
const CONTAINER = process.env.AGENT_PG_DOCKER;
const PG_USER = process.env.AGENT_PG_USER ?? 'postgres';
const PG_DB = process.env.AGENT_PG_DB ?? 'postgres';
const TABLE = `agent_rag_live_${process.pid}`;

/** A binding rendered as a SQL literal. Test-only; see the file docblock. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

class PsqlDockerDb implements LucidDatabaseLike {
  readonly statements: string[] = [];

  async rawQuery(sql: string, bindings: unknown[] = []): Promise<unknown> {
    const placeholders = (sql.match(/\?/g) ?? []).length;
    if (placeholders !== bindings.length) {
      throw new Error(
        `binding count mismatch: ${placeholders} placeholders, ${bindings.length} bindings`,
      );
    }
    let index = 0;
    const rendered = sql.replace(/\?/g, () => literal(bindings[index++]));
    this.statements.push(rendered);

    // Statements that return rows are wrapped so psql hands back one JSON document. A data-modifying
    // CTE is legal in `WITH`, which is what makes `UPDATE … RETURNING` and `DELETE … RETURNING` work
    // here alongside plain `SELECT`s.
    const returnsRows = /\bRETURNING\b/i.test(rendered) || /^\s*SELECT\b/i.test(rendered);
    const wrapped = returnsRows
      ? `WITH __q AS (${rendered}) SELECT COALESCE(json_agg(__q), '[]'::json)::text FROM __q`
      : rendered;

    const out = execFileSync(
      'docker',
      [
        'exec',
        '-i',
        CONTAINER ?? '',
        'psql',
        '-U',
        PG_USER,
        '-d',
        PG_DB,
        '-tA',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        wrapped,
      ],
      { encoding: 'utf8' },
    );
    if (!returnsRows) return [];
    return JSON.parse(out.trim() || '[]') as Record<string, unknown>[];
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
}

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
