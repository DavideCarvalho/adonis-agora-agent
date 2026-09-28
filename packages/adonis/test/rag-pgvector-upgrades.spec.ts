import { describe, expect, it } from 'vitest';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
  LucidRawRunner,
} from '../src/index.js';
import {
  EmbeddingRetriever,
  HybridRetriever,
  isLexicalVectorStore,
  LexicalRetriever,
  PgLexicalVectorStore,
  PgVectorStore,
  retrievers,
} from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

interface Call {
  sql: string;
  bindings: unknown[];
  tx: boolean;
}

/**
 * A recording {@link LucidDatabaseLike} whose `transaction` hands the callback a raw-query client (as
 * Lucid's transaction client is), so the SET LOCAL path can be observed. Answers `extversion` with
 * `version`; every other statement with `rows`.
 */
class RecordingDb implements LucidDatabaseLike {
  readonly calls: Call[] = [];

  constructor(
    private readonly version = '0.8.0',
    private readonly rows: Record<string, unknown>[] = [],
  ) {}

  private record(sql: string, bindings: unknown, tx: boolean): unknown {
    this.calls.push({ sql, bindings: (bindings as unknown[] | undefined) ?? [], tx });
    if (sql.includes('pg_extension')) return { rows: [{ extversion: this.version }] };
    return { rows: this.rows };
  }

  async rawQuery(sql: string, bindings?: unknown): Promise<unknown> {
    return this.record(sql, bindings, false);
  }

  from(_table: string): LucidQueryBuilderLike {
    throw new Error('unused');
  }
  table(_table: string): LucidInsertBuilderLike {
    throw new Error('unused');
  }
  transaction<T>(callback: (trx: LucidClientLike) => Promise<T>): Promise<T> {
    const trx: LucidRawRunner = {
      rawQuery: async (sql, bindings) => this.record(sql, bindings, true),
    };
    return callback(trx as unknown as LucidClientLike);
  }
}

/** A runner with no `transaction` at all. */
function plainRunner(): { runner: LucidRawRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      rawQuery: async (sql, bindings) => {
        calls.push({ sql, bindings: (bindings as unknown[] | undefined) ?? [], tx: false });
        return { rows: [] };
      },
    },
  };
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const NUL = String.fromCharCode(0);

describe('PgVectorStore.upsert (batched)', () => {
  it('writes a multi-row INSERT with 5 bindings per row, empty embeddings as NULL', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { dimension: 3, nullableEmbeddings: true });

    await store.upsert([
      { id: 'a#0', text: 'a', embedding: [1, 0, 0] },
      { id: 'a#1', text: 'b', embedding: [], source: 's', metadata: { k: 1 } },
    ]);

    expect(db.calls).toHaveLength(1);
    expect(flat(db.calls[0]!.sql)).toContain(
      'VALUES (?, ?, ?, ?::jsonb, ?::vector), (?, ?, ?, ?::jsonb, ?::vector)',
    );
    expect(db.calls[0]!.bindings).toEqual([
      'a#0',
      'a',
      null,
      null,
      '[1,0,0]',
      'a#1',
      'b',
      's',
      '{"k":1}',
      null,
    ]);
  });

  it('splits into upsertBatchSize statements and keeps the LAST of duplicate ids', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { dimension: 1, upsertBatchSize: 2 });

    await store.upsert([
      { id: 'a', text: 'first', embedding: [1] },
      { id: 'b', text: 'b', embedding: [1] },
      { id: 'c', text: 'c', embedding: [1] },
      { id: `a${NUL}`, text: 'last', embedding: [1] },
    ]);

    expect(db.calls.map((call) => call.bindings.length)).toEqual([10, 5]);
    const ids = db.calls.flatMap((call) => call.bindings.filter((_, index) => index % 5 === 0));
    expect(ids).toEqual(['b', 'c', 'a']);
    expect(db.calls[1]!.bindings[1]).toBe('last');
  });
});

describe('PgVectorStore mixed dimensions + nullable embeddings', () => {
  it('emits an untyped nullable column and one partial index per width, with the metric opclass', () => {
    const store = new PgVectorStore(new RecordingDb(), {
      table: 't',
      dimension: [384, 1536],
      nullableEmbeddings: true,
      metric: 'inner',
    });
    const ddl = store.schemaStatements().map(flat);
    expect(ddl[1]).toContain('embedding vector )');
    expect(ddl[2]).toBe(
      'CREATE INDEX IF NOT EXISTS t_embedding_384_idx ON t USING hnsw ((embedding::vector(384)) vector_ip_ops) WHERE vector_dims(embedding) = 384',
    );
    expect(ddl[3]).toContain('t_embedding_1536_idx');
    expect(ddl).toHaveLength(4);
  });

  it('keeps the fixed-width DDL by default', () => {
    const ddl = new PgVectorStore(new RecordingDb(), { dimension: 3 }).schemaStatements().map(flat);
    expect(ddl[1]).toContain('embedding vector(3) NOT NULL');
    expect(ddl[2]).toContain('USING hnsw (embedding vector_cosine_ops)');
  });

  it('searches only same-width vectors, casting both sides when the width is indexed', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { dimension: [3] });

    await store.search([1, 0, 0], { topK: 5, filter: { model: 'm' }, minScore: 0.5 });
    await store.search([1, 0], { topK: 5 });

    const indexed = flat(db.calls[0]!.sql);
    expect(indexed).toContain('1 - ((embedding::vector(3)) <=> ?::vector(3)) AS score');
    expect(indexed).toContain(
      'WHERE metadata @> ?::jsonb AND embedding IS NOT NULL AND vector_dims(embedding) = 3 AND 1 - ((embedding::vector(3)) <=> ?::vector(3)) >= ?',
    );
    expect(indexed).toContain('ORDER BY (embedding::vector(3)) <=> ?::vector(3)');
    expect(db.calls[0]!.bindings).toEqual([
      '[1,0,0]',
      '{"model":"m"}',
      '[1,0,0]',
      0.5,
      '[1,0,0]',
      5,
    ]);
    expect(flat(db.calls[1]!.sql)).toContain('ORDER BY embedding <=> ?::vector');
    expect(flat(db.calls[1]!.sql)).toContain('vector_dims(embedding) = 2');
  });

  it('adds IS NOT NULL to a fixed-width search only when embeddings may be NULL', async () => {
    const db = new RecordingDb();
    await new PgVectorStore(db, { dimension: 3 }).search([1, 0, 0], { topK: 1 });
    await new PgVectorStore(db, { dimension: 3, nullableEmbeddings: true }).search([1, 0, 0], {
      topK: 1,
    });
    expect(db.calls[0]!.sql).not.toContain('WHERE');
    expect(flat(db.calls[1]!.sql)).toContain('WHERE embedding IS NOT NULL');
  });

  it('rejects a width that is not a positive integer', () => {
    expect(() => new PgVectorStore(new RecordingDb(), { dimension: [1.5] })).toThrow();
  });
});

describe('PgVectorStore iterative scan', () => {
  it('SET LOCALs the iterative scan + ef_search in one transaction on pgvector >= 0.8', async () => {
    const db = new RecordingDb('0.8.1');
    const store = new PgVectorStore(db, {
      dimension: 3,
      iterativeScan: 'relaxed_order',
      efSearch: 80,
    });

    await store.search([1, 0, 0], { topK: 2 });
    await store.search([1, 0, 0], { topK: 2 });

    expect(db.calls.map((call) => [call.tx, flat(call.sql).slice(0, 44)])).toEqual([
      [false, 'SELECT extversion FROM pg_extension WHERE ex'],
      [true, "SELECT set_config('hnsw.iterative_scan', ?, "],
      [true, "SELECT set_config('hnsw.ef_search', ?, true)"],
      [true, 'SELECT id AS id, text AS text, source AS sou'],
      [true, "SELECT set_config('hnsw.iterative_scan', ?, "],
      [true, "SELECT set_config('hnsw.ef_search', ?, true)"],
      [true, 'SELECT id AS id, text AS text, source AS sou'],
    ]);
    expect(db.calls[1]!.bindings).toEqual(['relaxed_order']);
    expect(db.calls[2]!.bindings).toEqual(['80']);
  });

  it('skips it on pgvector < 0.8 and on a runner without transactions', async () => {
    const old = new RecordingDb('0.7.4');
    await new PgVectorStore(old, { dimension: 3, iterativeScan: 'strict_order' }).search(
      [1, 0, 0],
      { topK: 2 },
    );
    expect(old.calls.some((call) => call.sql.includes('iterative_scan'))).toBe(false);

    const { runner, calls } = plainRunner();
    await new PgVectorStore(runner, { dimension: 3, iterativeScan: 'strict_order' }).search(
      [1, 0, 0],
      { topK: 2 },
    );
    expect(calls).toHaveLength(1);
  });

  it('issues nothing extra when not configured', async () => {
    const db = new RecordingDb();
    await new PgVectorStore(db, { dimension: 3 }).search([1, 0, 0], { topK: 2 });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.tx).toBe(false);
  });
});

describe('PgLexicalVectorStore', () => {
  it('is a LexicalVectorStore; the base store is not', () => {
    expect(isLexicalVectorStore(new PgLexicalVectorStore(new RecordingDb()))).toBe(true);
    expect(isLexicalVectorStore(new PgVectorStore(new RecordingDb()))).toBe(false);
  });

  it('adds a GIN index over the exact expression it queries', async () => {
    const db = new RecordingDb();
    const store = new PgLexicalVectorStore(db, { table: 't', fullText: { config: 'english' } });

    await store.searchText('solar panels', { topK: 3, filter: { tenant: 't1' } });

    expect(flat(store.schemaStatements().at(-1)!)).toBe(
      "CREATE INDEX IF NOT EXISTS t_text_tsv_idx ON t USING gin (to_tsvector('english'::regconfig, text))",
    );
    const sql = flat(db.calls[0]!.sql);
    expect(sql).toContain("FROM t, websearch_to_tsquery('english', ?) AS __tsq(q)");
    expect(sql).toContain(
      "WHERE to_tsvector('english'::regconfig, text) @@ __tsq.q AND metadata @> ?::jsonb",
    );
    expect(sql).toContain('ts_rank_cd(');
    expect(db.calls[0]!.bindings).toEqual(['solar panels', '{"tenant":"t1"}', 3]);
  });

  it('uses a tsvector column you own (no index DDL) and falls back to any word', async () => {
    const db = new RecordingDb();
    const store = new PgLexicalVectorStore(db, { table: 't', fullText: { column: 'tsv' } });

    await store.searchText('solar-panel warranty?', { topK: 3 });

    expect(store.schemaStatements().some((statement) => statement.includes('gin'))).toBe(false);
    expect(db.calls).toHaveLength(2);
    expect(flat(db.calls[1]!.sql)).toContain(
      "to_tsquery('simple', ?) AS __tsq(q) WHERE tsv @@ __tsq.q",
    );
    expect(db.calls[1]!.bindings[0]).toBe("'solar' | 'panel' | 'warranty'");
  });

  it('answers a deny filter or a blank query without a round trip; refuses unsafe identifiers', async () => {
    const db = new RecordingDb();
    const store = new PgLexicalVectorStore(db);
    expect(await store.searchText('x', { topK: 3, filter: { tenant: [] } })).toEqual([]);
    expect(await store.searchText('  ', { topK: 3 })).toEqual([]);
    expect(db.calls).toHaveLength(0);
    expect(() => new PgLexicalVectorStore(db, { fullText: { config: "x'--" } })).toThrow();
    expect(() => new PgLexicalVectorStore(db, { fullText: { column: 'a b' } })).toThrow();
  });
});

describe('retrievers.pgvector({ fullText })', () => {
  it('builds a hybrid of the vector and full-text legs, and still reports embedding usage', async () => {
    const db = new RecordingDb('0.8.0', [
      { id: 'a#0', text: 'alpha', source: null, metadata: null, score: 0.5 },
    ]);
    const retriever = await retrievers.pgvector({
      db,
      embedder: new FakeEmbeddingProvider(4),
      dimension: 4,
      fullText: { hybrid: { k: 10 } },
    })({} as never);

    expect(retriever).toBeInstanceOf(HybridRetriever);
    const result = await retriever.retrieveWithUsage?.('alpha', { topK: 1 });
    expect(result?.passages.map((passage) => passage.id)).toEqual(['a#0']);
    expect(result?.usage).toEqual({ inputTokens: 1, modelId: 'fake-embedding' });
    expect(db.calls.some((call) => call.sql.includes('websearch_to_tsquery'))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes('<=>'))).toBe(true);
  });

  it('stays a plain vector retriever without it', async () => {
    const retriever = await retrievers.pgvector({
      db: new RecordingDb(),
      embedder: new FakeEmbeddingProvider(4),
      dimension: 4,
    })({} as never);
    expect(retriever).not.toBeInstanceOf(HybridRetriever);
  });
});

describe('LexicalRetriever', () => {
  it('forwards topK + filter (never minScore) to searchText', async () => {
    const db = new RecordingDb();
    const store = new PgLexicalVectorStore(db);
    await new LexicalRetriever(store).retrieve('word', {
      topK: 7,
      filter: { a: 1 },
      minScore: 0.9,
    });
    expect(db.calls[0]!.bindings).toEqual(['word', '{"a":1}', 7]);
    expect(db.calls[0]!.sql).not.toContain('>=');
    // …and composes with the embedding leg over the same store.
    expect(
      new HybridRetriever([
        new EmbeddingRetriever(new FakeEmbeddingProvider(4), store),
        new LexicalRetriever(store),
      ]),
    ).toBeInstanceOf(HybridRetriever);
  });
});
