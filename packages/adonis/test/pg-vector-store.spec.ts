import { describe, expect, it } from 'vitest';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
} from '../src/index.js';
import {
  ingestDocuments,
  PgVectorRetriever,
  PgVectorStore,
  stripNulBytes,
  toVectorLiteral,
} from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

/**
 * A recording {@link LucidDatabaseLike} — captures every `rawQuery(sql, bindings)` and returns canned
 * rows. Proves the pgvector store emits the right raw SQL + positional bindings WITHOUT a real Postgres.
 */
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

/** Collapse all runs of whitespace so multi-line SQL can be substring-asserted. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const EMBEDDING = [0.1, 0.2, 0.3, 0.4];
const VECTOR_LITERAL = '[0.1,0.2,0.3,0.4]';

describe('PgVectorStore.search — similarity SQL + bindings', () => {
  it('builds the cosine similarity query with the embedding as a ?::vector binding (default metric)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 5 });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('1 - (embedding <=> ?::vector) AS score');
    expect(flat(sql)).toContain('FROM agent_rag_chunks');
    expect(flat(sql)).toContain('ORDER BY embedding <=> ?::vector');
    expect(flat(sql)).toContain('LIMIT ?');
    // The embedding is NEVER interpolated — it is a positional binding, twice (score + order by).
    expect(sql).not.toContain(VECTOR_LITERAL);
    expect(bindings).toEqual([VECTOR_LITERAL, VECTOR_LITERAL, 5]);
  });

  it('selects the L2 operator/score for metric "l2"', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { metric: 'l2' });

    await store.search(EMBEDDING, { topK: 3 });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('-(embedding <-> ?::vector) AS score');
    expect(flat(sql)).toContain('ORDER BY embedding <-> ?::vector');
    expect(bindings).toEqual([VECTOR_LITERAL, VECTOR_LITERAL, 3]);
  });

  it('selects the inner-product operator/score for metric "inner"', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { metric: 'inner' });

    await store.search(EMBEDDING, { topK: 7 });

    const { sql } = db.last;
    expect(flat(sql)).toContain('-(embedding <#> ?::vector) AS score');
    expect(flat(sql)).toContain('ORDER BY embedding <#> ?::vector');
  });

  it('honours topK as the LIMIT binding', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 12 });

    expect(db.last.bindings.at(-1)).toBe(12);
  });

  it('adds a metadata @> ?::jsonb filter with the JSON in the correct binding slot', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 4, filter: { tenantRef: 't1' } });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('WHERE metadata @> ?::jsonb');
    // Order: score-vector, filter-json, order-vector, limit.
    expect(bindings).toEqual([VECTOR_LITERAL, '{"tenantRef":"t1"}', VECTOR_LITERAL, 4]);
  });

  it('an array filter value is set-membership via jsonb_exists_any (?| function form)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 4, filter: { audience: ['public', 'base:42'] } });

    const { sql, bindings } = db.last;
    // The `?|` operator collides with Knex's `?` placeholder, so we use its function form.
    expect(flat(sql)).toContain('jsonb_exists_any(');
    expect(flat(sql)).toContain('?::text[]');
    expect(flat(sql)).not.toContain('metadata @> ?::jsonb'); // pure array clause, no scalar containment
    // Order: score-vector, [key ×3 for the CASE, the token array], order-vector, limit.
    expect(bindings).toEqual([
      VECTOR_LITERAL,
      'audience',
      'audience',
      'audience',
      ['public', 'base:42'],
      VECTOR_LITERAL,
      4,
    ]);
  });

  it('adds a minScore relevance floor as a score-expr >= ? WHERE clause (before LIMIT)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 5, minScore: 0.7 });

    const { sql, bindings } = db.last;
    // The score expression is filtered in-SQL so the floor applies BEFORE the top-K cut.
    expect(flat(sql)).toContain('WHERE 1 - (embedding <=> ?::vector) >= ?');
    // Order: score-vector (SELECT), minScore-vector + threshold (WHERE), order-vector, limit.
    expect(bindings).toEqual([VECTOR_LITERAL, VECTOR_LITERAL, 0.7, VECTOR_LITERAL, 5]);
  });

  it('combines a metadata filter and a minScore floor with AND', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 4, filter: { tenantRef: 't1' }, minScore: 0.5 });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain(
      'WHERE metadata @> ?::jsonb AND 1 - (embedding <=> ?::vector) >= ?',
    );
    expect(bindings).toEqual([
      VECTOR_LITERAL,
      '{"tenantRef":"t1"}',
      VECTOR_LITERAL,
      0.5,
      VECTOR_LITERAL,
      4,
    ]);
  });

  it('an empty array filter denies via a WHERE false clause (no metadata binding)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, { topK: 7, filter: { audience: [] } });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('WHERE false');
    // No filter binding is emitted for the deny clause: score-vector, order-vector, limit.
    expect(bindings).toEqual([VECTOR_LITERAL, VECTOR_LITERAL, 7]);
  });

  it('combines a scalar clause and an array clause with AND, arrays first', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, {
      topK: 5,
      filter: { audience: ['public'], collectionId: 'c1' },
    });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toMatch(/jsonb_exists_any\(.*\) AND metadata @> \?::jsonb/);
    expect(bindings).toEqual([
      VECTOR_LITERAL,
      'audience',
      'audience',
      'audience',
      ['public'],
      '{"collectionId":"c1"}',
      VECTOR_LITERAL,
      5,
    ]);
  });

  it('maps rows to passages (score→Number, jsonb metadata, source)', async () => {
    const db = new RecordingDb([
      { id: 'a#0', text: 'hello', source: 'README', metadata: { lang: 'en' }, score: '0.87' },
      { id: 'b#0', text: 'world', source: null, metadata: null, score: 0.42 },
    ]);
    const store = new PgVectorStore(db);

    const passages = await store.search(EMBEDDING, { topK: 5 });

    expect(passages).toEqual([
      { id: 'a#0', text: 'hello', score: 0.87, source: 'README', metadata: { lang: 'en' } },
      { id: 'b#0', text: 'world', score: 0.42 },
    ]);
  });

  it('parses a jsonb metadata column returned as a string', async () => {
    const db = new RecordingDb([
      { id: 'a#0', text: 'x', source: null, metadata: '{"k":1}', score: 0.5 },
    ]);
    const store = new PgVectorStore(db);

    const [passage] = await store.search(EMBEDDING, { topK: 1 });
    expect(passage?.metadata).toEqual({ k: 1 });
  });
});

describe('PgVectorStore — identifier validation', () => {
  it('rejects a table name that is not a bare identifier', () => {
    const db = new RecordingDb();
    expect(() => new PgVectorStore(db, { table: 'chunks; DROP TABLE users' })).toThrow(
      /Invalid table/,
    );
    expect(() => new PgVectorStore(db, { table: 'evil"col' })).toThrow(/Invalid table/);
  });

  it('rejects a column name that is not a bare identifier', () => {
    const db = new RecordingDb();
    expect(() => new PgVectorStore(db, { columns: { embedding: 'emb ->> x' } })).toThrow(
      /Invalid column/,
    );
  });

  it('accepts overridden valid table/column names and uses them in SQL', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, {
      table: 'my_chunks',
      columns: {
        embedding: 'vec',
        metadata: 'meta',
        id: 'chunk_id',
        text: 'body',
        source: 'origin',
      },
    });

    await store.search(EMBEDDING, { topK: 2 });

    const sql = flat(db.last.sql);
    expect(sql).toContain('FROM my_chunks');
    expect(sql).toContain('1 - (vec <=> ?::vector) AS score');
    expect(sql).toContain('chunk_id AS id');
    expect(sql).toContain('body AS text');
    expect(sql).toContain('origin AS source');
    expect(sql).toContain('meta AS metadata');
  });
});

describe('PgVectorStore.upsert / remove / listDocuments', () => {
  it('upserts a chunk as an INSERT ... ON CONFLICT with vector/jsonb bindings', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.upsert([
      { id: 'doc#0', text: 'chunk text', embedding: EMBEDDING, source: 'src', metadata: { a: 1 } },
    ]);

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain(
      'INSERT INTO agent_rag_chunks (id, text, source, metadata, embedding)',
    );
    expect(flat(sql)).toContain('VALUES (?, ?, ?, ?::jsonb, ?::vector)');
    expect(flat(sql)).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(bindings).toEqual(['doc#0', 'chunk text', 'src', '{"a":1}', VECTOR_LITERAL]);
  });

  it('stores null for an absent source/metadata', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.upsert([{ id: 'doc#0', text: 't', embedding: EMBEDDING }]);

    expect(db.last.bindings).toEqual(['doc#0', 't', null, null, VECTOR_LITERAL]);
  });

  it('removes every chunk of a document via the chunk-id → doc-id expression', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.remove('doc');

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain(
      "DELETE FROM agent_rag_chunks WHERE regexp_replace(id, '#[0-9]+$', '') = ?",
    );
    expect(bindings).toEqual(['doc']);
  });

  it('strips a NUL byte from documentId before binding (remove)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.remove('do\u0000c');

    expect(db.last.bindings).toEqual(['doc']);
  });

  it('lists distinct documents, optionally metadata-filtered', async () => {
    const db = new RecordingDb([{ doc_id: 'doc', metadata: { lang: 'en' } }]);
    const store = new PgVectorStore(db);

    const docs = await store.listDocuments({ lang: 'en' });

    const { sql, bindings } = db.last;
    expect(flat(sql)).toContain('SELECT DISTINCT ON');
    expect(flat(sql)).toContain('WHERE metadata @> ?::jsonb');
    expect(bindings).toEqual(['{"lang":"en"}']);
    expect(docs).toEqual([{ id: 'doc', metadata: { lang: 'en' } }]);
  });
});

describe('PgVectorStore — NUL byte stripping (Postgres rejects 0x00 in text/jsonb)', () => {
  it('strips a NUL byte from id/text/source before binding, keeping the rest of the text intact', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.upsert([
      {
        id: 'doc\u0000#0',
        text: 'before\u0000after',
        embedding: EMBEDDING,
        source: 'src\u0000name',
      },
    ]);

    const { bindings } = db.last;
    expect(bindings[0]).toBe('doc#0');
    expect(bindings[1]).toBe('beforeafter');
    expect(bindings[2]).toBe('srcname');
    for (const binding of bindings) {
      if (typeof binding === 'string') {
        expect(binding).not.toContain('\u0000');
      }
    }
  });

  it('strips NUL bytes from metadata values, array items, and keys before JSON-stringifying', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.upsert([
      {
        id: 'doc#0',
        text: 't',
        embedding: EMBEDDING,
        metadata: {
          'ba\u0000d-key': 'clean',
          note: 'has\u0000nul',
          tags: ['a\u0000b', 'c'],
          nested: { inner: 'x\u0000y' },
        },
      },
    ]);

    const metadataBinding = db.last.bindings[3] as string;
    expect(metadataBinding).not.toContain('\u0000');
    expect(JSON.parse(metadataBinding)).toEqual({
      'bad-key': 'clean',
      note: 'hasnul',
      tags: ['ab', 'c'],
      nested: { inner: 'xy' },
    });
  });

  it('leaves a Date inside metadata untouched rather than flattening it to {}', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);
    const when = new Date('2024-01-01T00:00:00.000Z');

    await store.upsert([{ id: 'doc#0', text: 't', embedding: EMBEDDING, metadata: { when } }]);

    const metadataBinding = db.last.bindings[3] as string;
    // A Date has no enumerable own properties, so a naive object walk would JSON.stringify it as
    // {} -- it must instead pass through stripNulBytes unchanged and stringify the normal way.
    expect(JSON.parse(metadataBinding)).toEqual({ when: when.toISOString() });
  });
});

describe('PgVectorStore.updateMetadata — NUL byte stripping', () => {
  it('strips NUL bytes from patch values and keys before sending the merge/removal bindings', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.updateMetadata('doc', {
      'go\u0000od': 'val\u0000ue',
      'rem\u0000oved': null,
    });

    const { bindings } = db.last;
    const [setJson, removedKeys] = bindings as [string, string[], string];
    expect(setJson).not.toContain('\u0000');
    expect(JSON.parse(setJson)).toEqual({ good: 'value' });
    expect(removedKeys).toEqual(['removed']);
  });

  it('strips a NUL byte from documentId before binding, independent of the patch', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.updateMetadata('do\u0000c', { a: 'b' });

    const { bindings } = db.last;
    expect(bindings[2]).toBe('doc');
  });
});

describe('PgVectorStore -- NUL byte stripping on read paths (buildMetadataWhere)', () => {
  it('strips a NUL byte from a scalar filter key/value before binding (search)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, {
      topK: 4,
      filter: { 'ten\u0000antRef': 'v\u0000al' },
    });

    const { bindings } = db.last;
    const filterJson = bindings[1] as string;
    expect(filterJson).not.toContain('\u0000');
    expect(JSON.parse(filterJson)).toEqual({ tenantRef: 'val' });
  });

  it('strips NUL bytes from an array filter key and its tokens before binding (search)', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.search(EMBEDDING, {
      topK: 4,
      filter: { 'au\u0000dience': ['pub\u0000lic', 'base:42'] },
    });

    const { bindings } = db.last;
    // Order: score-vector, key x3 (for the CASE), the token array, order-vector, limit.
    expect(bindings[1]).toBe('audience');
    expect(bindings[2]).toBe('audience');
    expect(bindings[3]).toBe('audience');
    expect(bindings[4]).toEqual(['public', 'base:42']);
  });

  it('strips NUL bytes from a listDocuments metadata filter the same way', async () => {
    const db = new RecordingDb([{ doc_id: 'doc', metadata: { lang: 'en' } }]);
    const store = new PgVectorStore(db);

    await store.listDocuments({ 'la\u0000ng': 'e\u0000n' });

    const filterJson = db.last.bindings[0] as string;
    expect(filterJson).not.toContain('\u0000');
    expect(JSON.parse(filterJson)).toEqual({ lang: 'en' });
  });

  it('strips NUL bytes from a removeWhere metadata filter the same way', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db);

    await store.removeWhere({ 'co\u0000llectionId': 'c\u00001' });

    const filterJson = db.last.bindings[0] as string;
    expect(filterJson).not.toContain('\u0000');
    expect(JSON.parse(filterJson)).toEqual({ collectionId: 'c1' });
  });
});

describe('stripNulBytes helper', () => {
  it('removes NUL bytes from strings, recurses into arrays/objects (keys included), and leaves other values unchanged', () => {
    expect(stripNulBytes('a\u0000b')).toBe('ab');
    expect(stripNulBytes(['a\u0000b', 1, null])).toEqual(['ab', 1, null]);
    expect(stripNulBytes({ 'k\u0000ey': 'v\u0000al', n: 1 })).toEqual({ key: 'val', n: 1 });
    expect(stripNulBytes(42)).toBe(42);
    expect(stripNulBytes(null)).toBe(null);
    expect(stripNulBytes(undefined)).toBe(undefined);
  });

  it('keeps a __proto__-named key as an own property rather than losing it to the prototype setter', () => {
    // JSON.parse creates a real own property named "__proto__" (CreateDataProperty semantics) --
    // unlike the object-literal form { '__proto__': ... }, which sets the prototype instead.
    const input = JSON.parse('{"__proto__":"mal","safe":"ok"}') as Record<string, unknown>;

    const result = stripNulBytes(input);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('mal');
    expect(result.safe).toBe('ok');
  });

  it('passes a Date through unchanged rather than flattening it to a plain object', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');

    expect(stripNulBytes(date)).toBe(date);
  });

  it('passes a class instance through unchanged rather than flattening it to a plain object', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const point = new Point(1, 2);

    expect(stripNulBytes(point)).toBe(point);
  });
});

describe('PgVectorStore.schemaStatements', () => {
  it('emits the extension, table, and metric index DDL', () => {
    const store = new PgVectorStore(new RecordingDb(), { dimension: 768, metric: 'l2' });
    const statements = store.schemaStatements();

    expect(statements[0]).toBe('CREATE EXTENSION IF NOT EXISTS vector');
    expect(flat(statements[1]!)).toContain('CREATE TABLE IF NOT EXISTS agent_rag_chunks');
    expect(flat(statements[1]!)).toContain('embedding vector(768) NOT NULL');
    expect(flat(statements[2]!)).toContain('USING hnsw (embedding vector_l2_ops)');
  });
});

describe('ingestion chunk → embed → insert over PgVectorStore', () => {
  it('embeds each chunk and issues one INSERT per chunk with the embedded vector', async () => {
    const db = new RecordingDb();
    const store = new PgVectorStore(db, { dimension: 8 });
    const embedder = new FakeEmbeddingProvider(8);

    const count = await ingestDocuments(
      [{ id: 'doc', text: 'refunds and returns policy', source: 'README' }],
      { embedder, store },
    );

    expect(count).toBe(1);
    // One rawQuery — the single chunk's INSERT.
    const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO'));
    expect(inserts).toHaveLength(1);
    const [id, text, source, metadata, vector] = inserts[0]!.bindings;
    expect(id).toBe('doc#0');
    expect(text).toBe('refunds and returns policy');
    expect(source).toBe('README');
    expect(metadata).toBeNull();
    // The vector binding is the embedded query's literal — proves chunk→embed→store, not a passthrough.
    const [expected] = await embedder.embed(['refunds and returns policy']);
    expect(vector).toBe(toVectorLiteral(expected!));
  });
});

describe('PgVectorRetriever', () => {
  it('embeds the query then vector-searches with the default topK of 5', async () => {
    const db = new RecordingDb([
      { id: 'a#0', text: 'hit', source: null, metadata: null, score: 0.9 },
    ]);
    const store = new PgVectorStore(db, { dimension: 8 });
    const embedder = new FakeEmbeddingProvider(8);
    const retriever = new PgVectorRetriever(embedder, store);

    const passages = await retriever.retrieve('how do refunds work');

    expect(passages).toEqual([{ id: 'a#0', text: 'hit', score: 0.9 }]);
    // topK defaults to 5, bound as the LIMIT.
    expect(db.last.bindings.at(-1)).toBe(5);
    const [queryVec] = await embedder.embed(['how do refunds work']);
    expect(db.last.bindings[0]).toBe(toVectorLiteral(queryVec!));
  });
});
