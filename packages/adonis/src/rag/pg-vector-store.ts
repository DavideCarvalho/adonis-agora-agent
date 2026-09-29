import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import type { Passage } from '../spi/retriever.js';
import type { LucidRawRunner } from '../stores/lucid.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import {
  anyTermTsquery,
  DEFAULT_STOP_WORDS,
  hasSearchSyntax,
  keywordTerms,
} from './lexical-query.js';
import type {
  IndexedDocument,
  LexicalVectorStore,
  MetadataPatch,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from './vector-store.js';
import { assertRemovalFilter, effectivePatchKeys, filterDeniesAll } from './vector-store.js';

/**
 * The similarity metric — which pgvector distance operator ranks results (and which index opclass the
 * migration should build). `cosine` (the default) is scale-invariant and the right choice for most
 * embedding models; `l2` (Euclidean) and `inner` (inner product) are offered for models trained for them.
 */
export type PgVectorMetric = 'cosine' | 'l2' | 'inner';

/**
 * Physical column names for the pgvector chunk table. Every field defaults to the mirror of the
 * in-memory store's record shape (`id`/`text`/`source`/`metadata`/`embedding`); override to point the
 * store at an existing table. Each name is validated against a strict identifier regex before it is ever
 * spliced into SQL — the ONLY parts of a statement not passed as a positional binding.
 */
export interface PgVectorColumns {
  /** Chunk id column (PK). Chunk ids are `${documentId}#<n>`. Default `id`. */
  id?: string;
  /** Chunk text column. Default `text`. */
  text?: string;
  /** Citation/source column (nullable). Default `source`. */
  source?: string;
  /** `jsonb` metadata column (nullable). Default `metadata`. */
  metadata?: string;
  /** `vector(N)` embedding column. Default `embedding`. */
  embedding?: string;
}

export interface PgVectorStoreOptions {
  /** Table name. Default `agent_rag_chunks`. Validated against the identifier regex. */
  table?: string;
  /**
   * Embedding width — must match your model (e.g. 1536 for text-embedding-3-small). Default 1536.
   *
   * Pass a **list** to let several models' vectors share one table (mixed dimensions — say, while
   * migrating from a 768-wide local model to a 1536-wide hosted one): the column becomes an untyped
   * `vector`, the schema gets one *partial* HNSW index per listed width
   * (`((embedding::vector(n))) … WHERE vector_dims(embedding) = n`), and `search` only compares the
   * query against vectors of its own width, through that width's index. A width that is not listed is
   * still answered — exactly, by a sequential scan. Put the model in the chunk metadata and filter on
   * it when two models share a width.
   */
  dimension?: number | readonly number[];
  /**
   * Allow chunks with no embedding (`embedding: []` on upsert is stored as `NULL`): index text first
   * and embed later, or keep full-text-only chunks. `search` skips them; the lexical leg of
   * {@link PgLexicalVectorStore} still finds them. Default `false` — the column stays `NOT NULL`. Only
   * changes the DDL for a table that does not exist yet.
   */
  nullableEmbeddings?: boolean;
  /**
   * pgvector ≥ 0.8 iterative index scans for `search`: keep walking the HNSW graph until enough rows
   * pass the metadata filter, instead of returning fewer than `topK` when a selective filter (one
   * tenant of many) rejects most of what the index produced. Applied with `SET LOCAL` inside a
   * transaction, so it needs a handle with `transaction` (Lucid's `db` has one); silently skipped on an
   * older pgvector or a runner without transactions. Default off.
   */
  iterativeScan?: 'strict_order' | 'relaxed_order';
  /** `hnsw.ef_search` for `search` (candidate list size; pgvector's default is 40). Needs `transaction`. */
  efSearch?: number;
  /**
   * Rows per multi-row `INSERT … ON CONFLICT` statement in `upsert`. Default 100. Duplicate ids in one
   * `upsert` call collapse to the last occurrence (as the old row-by-row loop left them).
   */
  upsertBatchSize?: number;
  /** Similarity metric / distance operator. Default `cosine`. */
  metric?: PgVectorMetric;
  /** Override the physical column names (each validated). */
  columns?: PgVectorColumns;
}

/** A single metric's pgvector operator + score expression + index opclass. */
interface MetricSpec {
  /** The distance operator; `ORDER BY embedding <op> ?::vector` (ascending) always ranks nearest first. */
  operator: string;
  /** pgvector index operator class the migration builds for this metric. */
  opclass: string;
  /**
   * Builds a SELECT-list score expression (higher = more relevant) from the embedding column and a
   * `?::vector` placeholder. Cosine maps distance `d∈[0,2]` to similarity `1-d`; L2/inner negate the
   * distance so the returned `score` stays monotonically increasing in relevance across all metrics.
   */
  score(embeddingColumn: string, vectorType?: string): string;
}

const METRICS: Record<PgVectorMetric, MetricSpec> = {
  cosine: {
    operator: '<=>',
    opclass: 'vector_cosine_ops',
    score: (col, type = 'vector') => `1 - (${col} <=> ?::${type})`,
  },
  l2: {
    operator: '<->',
    opclass: 'vector_l2_ops',
    score: (col, type = 'vector') => `-(${col} <-> ?::${type})`,
  },
  inner: {
    // pgvector's `<#>` returns the NEGATIVE inner product, so `-(a <#> b)` recovers the inner product
    // and `ORDER BY a <#> b ASC` ranks the largest inner product first — consistent with the others.
    operator: '<#>',
    opclass: 'vector_ip_ops',
    score: (col, type = 'vector') => `-(${col} <#> ?::${type})`,
  },
};

/** Only unqualified SQL identifiers (letter/underscore start, then letters/digits/underscores) are allowed. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject any table/column name that is not a bare SQL identifier. Table and column names are the only
 * parts of a pgvector statement that CANNOT be a positional binding (an identifier is not a value), so
 * every one is validated here before it is spliced in — closing the injection vector that raw operator
 * SQL would otherwise open. Embeddings, filters, top-K are always `?` bindings and never reach this path.
 */
function assertIdentifier(name: string, role: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${role} "${name}": a pgvector identifier must match ${IDENTIFIER.source}`,
    );
  }
  return name;
}

/** pgvector accepts a `'[1,2,3]'` text literal cast to `vector`; the literal itself is a `?` binding. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Strip every NUL byte (`0x00`) from a value before it can reach a Postgres `text`/`jsonb` binding.
 * Postgres rejects `0x00` in those types outright (`invalid byte sequence for encoding "UTF8": 0x00`),
 * while source systems like Qdrant accept it — so text extracted from PDFs that happens to carry a stray
 * NUL byte works fine right up until it is written to pgvector. Strings have the byte removed (the rest
 * of the text is kept intact); arrays and PLAIN objects are walked recursively, including object KEYS
 * (a NUL in a metadata key would otherwise reach `JSON.stringify` and then Postgres just the same); every
 * other value (numbers, booleans, `null`, `undefined`, embeddings, a `Date`, a class instance, a
 * `Buffer`, …) passes through unchanged, by reference.
 *
 * Two things a naive `for...in` + assignment walk gets wrong, both handled here:
 *
 * - **Only plain objects are walked.** The check is `Object.getPrototypeOf(v) === Object.prototype ||
 *   === null`, never `typeof v === 'object'` alone — a `Date`, a class instance, a `Buffer`, … would
 *   otherwise be torn down into a plain `{}` of its enumerable own properties, silently losing its
 *   prototype (and, for a `Date`, every method on it).
 * - **The result is built with `Object.fromEntries`, never `result[key] = value` on a fresh `{}`.** A
 *   metadata key literally named `__proto__`, assigned that way, does not create an own property — it
 *   hits the inherited `Object.prototype` accessor instead, which (for the ordinary case, a string
 *   value) silently no-ops, so the key is dropped rather than round-tripped. `Object.fromEntries` uses
 *   `CreateDataProperty` under the hood, which always creates a real own property, `__proto__` included.
 */
export function stripNulBytes<T>(value: T): T {
  if (typeof value === 'string') {
    // split/join rather than a regex literal -- a bare NUL inside a RegExp trips biome's
    // noControlCharactersInRegex lint, and split/join needs no escaping at all.
    return value.split('\u0000').join('') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNulBytes(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // Not a plain object -- a Date, a class instance, a Buffer, a Map, ... -- leave it exactly as is.
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        stripNulBytes(key),
        stripNulBytes(val),
      ]),
    ) as unknown as T;
  }
  return value;
}

/**
 * Build the metadata `WHERE` fragment for a filter, using Lucid/Knex positional `?` bindings (never
 * string interpolation). Two predicate kinds:
 *
 * - **scalar** filter values collapse into a single jsonb-containment check (`metadata @> ?::jsonb`) —
 *   exact-match, byte-for-byte the previous behavior so scalar filters stay backward compatible.
 * - an **array** filter value is a **match-any** (OR / set membership) check: the record matches when
 *   its value for that key — scalar or array — shares an element with the filter array. An empty array
 *   can never match (the `false` deny primitive).
 *
 * Set membership uses `jsonb_exists_any(jsonb, text[])` — the function form of the `?|` operator, chosen
 * because bare `?|` collides with Knex's `?` binding placeholder. The metadata KEY is itself a `?`
 * binding (`metadata->?`), so a caller-supplied key can never inject SQL; only the (already validated)
 * table/column identifiers are ever spliced in. Returns `{ sql: '', bindings: [] }` when there is no
 * filter, preserving the previous unfiltered query shape.
 *
 * Every binding built here — the key, the scalar containment JSON, each array token — is run through
 * {@link stripNulBytes} first, the same as every write path: a filter key or value can carry a NUL byte
 * just as easily as stored text can, Postgres rejects it here exactly as it would on a write, and
 * stripping it here keeps a filter lookup consistent with the already-stripped data it is matched against.
 */
export function buildMetadataWhere(
  filter: Record<string, unknown> | undefined,
  metadataColumn: string,
): { sql: string; bindings: unknown[] } {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return { sql: '', bindings: [] };
  }
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  // Accumulated as [key, value] pairs, not `scalar[cleanKey] = value` on a fresh `{}` -- a filter key
  // literally named `__proto__` would otherwise hit the inherited `Object.prototype` accessor instead
  // of creating an own property, and (for the ordinary case, a non-object value) that setter silently
  // no-ops, dropping the key before it ever reaches `JSON.stringify`. `Object.fromEntries` below builds
  // the object with `CreateDataProperty`, the same fix {@link stripNulBytes} makes for its own walk.
  const scalarEntries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(filter)) {
    const cleanKey = stripNulBytes(key);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        clauses.push('false');
        continue;
      }
      // Coerce the record's value to an array (a scalar becomes a one-element array) so `?|` set
      // membership works uniformly, then test overlap with the caller's tokens.
      clauses.push(
        `jsonb_exists_any(CASE WHEN jsonb_typeof(${metadataColumn}->?) = 'array' ` +
          `THEN ${metadataColumn}->? ELSE jsonb_build_array(${metadataColumn}->?) END, ?::text[])`,
      );
      bindings.push(
        cleanKey,
        cleanKey,
        cleanKey,
        value.map((token) => stripNulBytes(String(token))),
      );
    } else {
      scalarEntries.push([cleanKey, value]);
    }
  }
  if (scalarEntries.length > 0) {
    clauses.push(`${metadataColumn} @> ?::jsonb`);
    bindings.push(JSON.stringify(stripNulBytes(Object.fromEntries(scalarEntries))));
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, bindings };
}

/** Normalize whatever a Lucid `rawQuery` returns (PG `{rows}`, SQLite array, MySQL `[rows,fields]`). */
export function normalizeRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    if (raw.length > 0 && Array.isArray(raw[0])) {
      return raw[0] as Record<string, unknown>[];
    }
    return raw as Record<string, unknown>[];
  }
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    return (raw as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/** A `jsonb` column comes back parsed (object) on `pg` or as a string on some drivers — accept both. */
function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * SQL that collapses a chunk id (`${documentId}#<n>`) back to its source document id — the pgvector
 * mirror of {@link import('./vector-store.js').documentIdOf}. Shared by `remove` and `listDocuments` so
 * both key on the exact same definition of "chunk belongs to document". `col` is a validated identifier.
 */
function documentIdExpr(col: string): string {
  return `regexp_replace(${col}, '#[0-9]+$', '')`;
}

/**
 * A pgvector-backed {@link VectorStore} — the production RAG adapter, the durable twin of
 * {@link import('./memory-vector-store.js').MemoryVectorStore}. It runs over the structural
 * {@link LucidRawRunner} (so `@adonisjs/lucid` stays an optional peer — this file imports no Lucid
 * types) with raw SQL for the pgvector operators. Similarity ranks via the `<=>`/`<->`/`<#>` operator for
 * the configured {@link PgVectorMetric}; the query embedding is always a `?::vector` positional binding
 * (NEVER string-interpolated). Scalar metadata filters are an `@> ?::jsonb` containment binding; an
 * array filter value is set-membership (`jsonb_exists_any`, the `?|` function form) — the capability-token
 * ACL primitive. Only the (validated) table/column identifiers are ever spliced into a statement.
 *
 * Usually you don't construct this directly: `config/agent.ts` selects it via `retrievers.pgvector({...})`
 * and the provider builds it, lazily importing `@adonisjs/lucid` only when the pgvector retriever is
 * chosen. Call {@link PgVectorStore.ensureSchema} once (or run the bundled migration) to provision the
 * `vector` extension, the chunk table, and the metric's index.
 */
export class PgVectorStore implements VectorStore {
  protected readonly table: string;
  /** The single width (fixed-dimension table), or `undefined` for a mixed-dimension table. */
  private readonly dimension: number | undefined;
  /** The widths with a partial HNSW index, for a mixed-dimension table. */
  private readonly indexedDimensions: readonly number[];
  private readonly nullableEmbeddings: boolean;
  private readonly iterativeScan: PgVectorStoreOptions['iterativeScan'];
  private readonly efSearch: number | undefined;
  private readonly upsertBatchSize: number;
  private iterativeScanSupport: Promise<boolean> | undefined;
  private readonly metric: MetricSpec;
  private readonly metricName: PgVectorMetric;
  protected readonly col: Required<PgVectorColumns>;

  constructor(
    protected readonly db: LucidRawRunner,
    options: PgVectorStoreOptions = {},
  ) {
    this.table = assertIdentifier(options.table ?? 'agent_rag_chunks', 'table');
    const dimension = options.dimension ?? 1536;
    if (typeof dimension === 'number') {
      this.dimension = dimension;
      this.indexedDimensions = [];
    } else {
      for (const width of dimension) {
        if (!Number.isInteger(width) || width <= 0) {
          throw new Error(
            `Invalid pgvector dimension ${String(width)}: must be a positive integer`,
          );
        }
      }
      this.dimension = undefined;
      this.indexedDimensions = [...new Set(dimension)];
    }
    this.nullableEmbeddings = options.nullableEmbeddings ?? false;
    this.iterativeScan = options.iterativeScan;
    this.efSearch = options.efSearch;
    this.upsertBatchSize = Math.max(1, Math.floor(options.upsertBatchSize ?? 100));
    this.metricName = options.metric ?? 'cosine';
    this.metric = METRICS[this.metricName];
    const columns = options.columns ?? {};
    this.col = {
      id: assertIdentifier(columns.id ?? 'id', 'column'),
      text: assertIdentifier(columns.text ?? 'text', 'column'),
      source: assertIdentifier(columns.source ?? 'source', 'column'),
      metadata: assertIdentifier(columns.metadata ?? 'metadata', 'column'),
      embedding: assertIdentifier(columns.embedding ?? 'embedding', 'column'),
    };
  }

  /**
   * Idempotent DDL — the `vector` extension, the chunk table, and the metric's index. Handy for tests
   * and scripts; an AdonisJS app should prefer the bundled migration so the schema is versioned.
   */
  async ensureSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      await this.db.rawQuery(statement);
    }
  }

  /** The `CREATE EXTENSION` / `CREATE TABLE` / `CREATE INDEX` statements {@link ensureSchema} issues. */
  schemaStatements(): string[] {
    const c = this.col;
    const mixed = this.dimension === undefined;
    const statements = [
      'CREATE EXTENSION IF NOT EXISTS vector',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        ${c.id} TEXT PRIMARY KEY,
        ${c.text} TEXT NOT NULL,
        ${c.source} TEXT,
        ${c.metadata} JSONB,
        ${c.embedding} ${mixed ? 'vector' : `vector(${this.dimension})`}${this.nullableEmbeddings ? '' : ' NOT NULL'}
      )`,
    ];
    if (mixed) {
      for (const width of this.indexedDimensions) {
        statements.push(
          `CREATE INDEX IF NOT EXISTS ${this.table}_${c.embedding}_${width}_idx
        ON ${this.table} USING hnsw ((${c.embedding}::vector(${width})) ${this.metric.opclass})
        WHERE vector_dims(${c.embedding}) = ${width}`,
        );
      }
    } else {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${this.table}_${c.embedding}_idx
        ON ${this.table} USING hnsw (${c.embedding} ${this.metric.opclass})`,
      );
    }
    return statements;
  }

  /**
   * Every `text`/`jsonb` binding (id, text, source, metadata — including nested metadata values, array
   * items and object keys) is run through {@link stripNulBytes} first: Postgres rejects the NUL byte
   * (`0x00`) in `text`/`jsonb` outright, while upstream sources (PDF extraction, Qdrant) happily carry
   * it, so an unstripped chunk would otherwise fail this INSERT with `invalid byte sequence for encoding
   * "UTF8": 0x00`. The embedding is untouched — it is never text/jsonb.
   *
   * Written as multi-row `INSERT … ON CONFLICT` statements of {@link PgVectorStoreOptions.upsertBatchSize}
   * rows each (one round trip per batch instead of per chunk). An empty `embedding` is written as `NULL`.
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    // The id is stripped before de-duplication, so two ids differing only by a NUL byte are the one
    // row they would be stored as. One statement can't touch a row twice (`ON CONFLICT DO UPDATE
    // command cannot affect row a second time`), so duplicates collapse to the LAST occurrence — the
    // same last-write-wins the old row-by-row loop had.
    const byId = new Map<string, VectorRecord>();
    for (const record of records) {
      const id = stripNulBytes(record.id);
      byId.delete(id);
      byId.set(id, { ...record, id });
    }
    const unique = [...byId.values()];
    const c = this.col;
    for (let start = 0; start < unique.length; start += this.upsertBatchSize) {
      const batch = unique.slice(start, start + this.upsertBatchSize);
      const bindings: unknown[] = [];
      for (const record of batch) {
        bindings.push(
          record.id,
          stripNulBytes(record.text),
          stripNulBytes(record.source ?? null),
          record.metadata !== undefined ? JSON.stringify(stripNulBytes(record.metadata)) : null,
          // An empty embedding is a chunk with no vector yet — NULL (see `nullableEmbeddings`).
          record.embedding.length > 0 ? toVectorLiteral(record.embedding) : null,
        );
      }
      await this.db.rawQuery(
        `INSERT INTO ${this.table} (${c.id}, ${c.text}, ${c.source}, ${c.metadata}, ${c.embedding})
         VALUES ${batch.map(() => '(?, ?, ?, ?::jsonb, ?::vector)').join(', ')}
         ON CONFLICT (${c.id}) DO UPDATE SET
           ${c.text} = EXCLUDED.${c.text},
           ${c.source} = EXCLUDED.${c.source},
           ${c.metadata} = EXCLUDED.${c.metadata},
           ${c.embedding} = EXCLUDED.${c.embedding}`,
        bindings,
      );
    }
  }

  /**
   * `documentId` is run through {@link stripNulBytes} before binding — the stored `id` column never
   * carries a NUL byte (it went through the same stripping on `upsert`), so a raw NUL in the lookup
   * value could only ever fail to match; stripping it here keeps the lookup consistent with the data
   * instead of trusting a caller-supplied string to already be clean.
   */
  async remove(documentId: string): Promise<void> {
    await this.db.rawQuery(`DELETE FROM ${this.table} WHERE ${documentIdExpr(this.col.id)} = ?`, [
      stripNulBytes(documentId),
    ]);
  }

  /**
   * {@link VectorStore.updateMetadata} — one `UPDATE` for the whole document, with the
   * {@link import('./vector-store.js').MetadataPatch} merge done **in Postgres** rather than read back
   * into JS: `(COALESCE(metadata, '{}') || <set>) - <removed keys>`. `||` is jsonb concatenation, which
   * at the top level is exactly a shallow merge (right-hand keys win, wholesale); `jsonb - text[]`
   * removes keys, which is how a `null` in the patch deletes. So there is no read-modify-write and no
   * lost-update window between a `SELECT` and an `UPDATE`.
   *
   * The embedding is untouched **structurally**: `SET` names only the metadata column, so no statement
   * this method can emit is capable of writing `embedding` or `text`. The row is not re-inserted, so
   * pgvector never re-parses a vector literal either.
   *
   * `RETURNING` the id column yields the chunk count without a second query.
   *
   * The patch is run through {@link stripNulBytes} first (values AND keys) for the same reason as
   * {@link PgVectorStore.upsert}: Postgres rejects the NUL byte (`0x00`) in `jsonb`, so an unstripped
   * value or key would otherwise fail this `UPDATE`. `documentId` is stripped too, for the same
   * lookup-consistency reason as {@link PgVectorStore.remove}.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    const cleanPatch = stripNulBytes(patch);
    const keys = effectivePatchKeys(cleanPatch);
    if (keys.length === 0) {
      return 0;
    }
    // Accumulated as [key, value] pairs, not `set[key] = cleanPatch[key]` on a fresh `{}` -- see the
    // matching comment in `buildMetadataWhere`: a patch key literally named `__proto__` would otherwise
    // be silently dropped by the inherited prototype setter instead of surviving as an own property.
    const setEntries: [string, unknown][] = [];
    const removed: string[] = [];
    for (const key of keys) {
      if (cleanPatch[key] === null) {
        removed.push(key);
      } else {
        setEntries.push([key, cleanPatch[key]]);
      }
    }
    const set = Object.fromEntries(setEntries);
    const c = this.col;
    const raw = await this.db.rawQuery(
      `UPDATE ${this.table}
          SET ${c.metadata} = (COALESCE(${c.metadata}, '{}'::jsonb) || ?::jsonb) - ?::text[]
        WHERE ${documentIdExpr(c.id)} = ?
        RETURNING ${c.id} AS id`,
      [JSON.stringify(set), removed, stripNulBytes(documentId)],
    );
    return normalizeRows(raw).length;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const c = this.col;
    const docExpr = documentIdExpr(c.id);
    const where = buildMetadataWhere(filter, c.metadata);
    const raw = await this.db.rawQuery(
      `SELECT DISTINCT ON (${docExpr}) ${docExpr} AS doc_id, ${c.metadata} AS metadata
       FROM ${this.table}
       ${where.sql}
       ORDER BY ${docExpr}`,
      where.bindings,
    );
    return normalizeRows(raw).map((row) => {
      const metadata = parseMetadata(row.metadata);
      return {
        id: String(row.doc_id),
        ...(metadata !== undefined ? { metadata } : {}),
      };
    });
  }

  /**
   * {@link VectorStore.listDocumentIds} — `SELECT DISTINCT` of the document-id expression. Unlike
   * {@link PgVectorStore.listDocuments} it never selects the `jsonb` metadata column, so Postgres does not
   * transfer it and {@link parseMetadata} is never called: on a large corpus that is most of the cost.
   * The `WHERE` comes from the same {@link buildMetadataWhere} `search` uses.
   */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    const docExpr = documentIdExpr(this.col.id);
    const where = buildMetadataWhere(filter, this.col.metadata);
    const raw = await this.db.rawQuery(
      `SELECT DISTINCT ${docExpr} AS doc_id
         FROM ${this.table}
         ${where.sql}
        ORDER BY doc_id`,
      where.bindings,
    );
    return normalizeRows(raw).map((row) => String(row.doc_id));
  }

  /**
   * {@link VectorStore.removeWhere} — one `DELETE … RETURNING`, so the chunk count comes back from the
   * same statement that does the deleting: no count-then-delete, no race between the two, one round trip.
   *
   * Filter parity with {@link PgVectorStore.search} is by construction — the `WHERE` fragment is produced
   * by the identical {@link buildMetadataWhere} call, so an empty-array value emits the same `false`
   * clause here as it does there, and a scalar the same `@> ?::jsonb` containment.
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    assertRemovalFilter(filter);
    if (filterDeniesAll(filter)) {
      return 0;
    }
    const where = buildMetadataWhere(filter, this.col.metadata);
    const raw = await this.db.rawQuery(
      `DELETE FROM ${this.table} ${where.sql} RETURNING ${this.col.id} AS id`,
      where.bindings,
    );
    return normalizeRows(raw).length;
  }

  /**
   * Nearest first by the configured metric. On a mixed-dimension table only vectors as wide as the
   * query are compared (through that width's partial index when it has one); a chunk without an
   * embedding is never returned.
   */
  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    if (embedding.length === 0) {
      return [];
    }
    const c = this.col;
    const vector = toVectorLiteral(embedding);
    // A fixed-width table keeps the exact expression its index was built on (`embedding`); a mixed one
    // casts both sides to the query's width so the planner can match that width's partial index.
    let vectorType = 'vector';
    const shapeClauses: string[] = [];
    if (this.dimension === undefined) {
      const width = embedding.length;
      if (this.indexedDimensions.includes(width)) {
        vectorType = `vector(${width})`;
      }
      shapeClauses.push(`${c.embedding} IS NOT NULL`, `vector_dims(${c.embedding}) = ${width}`);
    } else if (this.nullableEmbeddings) {
      shapeClauses.push(`${c.embedding} IS NOT NULL`);
    }
    const column = vectorType === 'vector' ? c.embedding : `(${c.embedding}::${vectorType})`;
    const scoreExpr = this.metric.score(column, vectorType);
    const meta = buildMetadataWhere(options.filter, c.metadata);
    // Combine the metadata predicate with an optional minScore relevance floor. Filtering the score
    // expression in SQL (not in JS after the fact) keeps the floor applied BEFORE `LIMIT`, so the K
    // returned are all above the floor. `buildMetadataWhere` prefixes `WHERE ` (6 chars) — strip it so
    // the clauses can be re-joined with the floor via AND. When neither is present the query shape and
    // binding order are byte-for-byte identical to before.
    const clauses: string[] = [];
    const whereBindings: unknown[] = [];
    if (meta.sql !== '') {
      clauses.push(meta.sql.slice('WHERE '.length));
      whereBindings.push(...meta.bindings);
    }
    clauses.push(...shapeClauses);
    if (options.minScore !== undefined) {
      // The score expression carries its own `?::vector`, so the embedding is bound again here.
      clauses.push(`${scoreExpr} >= ?`);
      whereBindings.push(vector, options.minScore);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Bindings are consumed positionally, in the exact order the `?`s appear: score expr (embedding),
    // then the optional filter/minScore clause(s), then the ORDER BY embedding, then the LIMIT. The
    // embedding is bound once per `?::vector` because a positional `?` cannot be reused like a `$1`.
    const bindings: unknown[] = [vector, ...whereBindings, vector, options.topK];
    const sql = `SELECT ${c.id} AS id, ${c.text} AS text, ${c.source} AS source, ${c.metadata} AS metadata,
              ${scoreExpr} AS score
       FROM ${this.table}
       ${whereSql}
       ORDER BY ${column} ${this.metric.operator} ?::${vectorType}
       LIMIT ?`;
    const raw = await this.withSearchSettings((runner) => runner.rawQuery(sql, bindings));
    return normalizeRows(raw).map(toPassage);
  }

  /** Run a read with the configured HNSW settings `SET LOCAL` in one transaction, when possible. */
  private async withSearchSettings(
    read: (runner: LucidRawRunner) => Promise<unknown>,
  ): Promise<unknown> {
    const transaction = (this.db as Partial<LucidTransactionRunner>).transaction;
    if (typeof transaction !== 'function') {
      return read(this.db);
    }
    const iterative = this.iterativeScan !== undefined && (await this.supportsIterativeScan());
    if (!iterative && this.efSearch === undefined) {
      return read(this.db);
    }
    return transaction.call(this.db, async (trx) => {
      // Lucid's transaction client is a full query client (it has `rawQuery`); the structural type
      // this file sees only promises `from`/`table`, hence the check.
      const runner = trx as Partial<LucidRawRunner>;
      if (typeof runner.rawQuery !== 'function') {
        return read(this.db);
      }
      const tx = runner as LucidRawRunner;
      if (iterative) {
        await tx.rawQuery(`SELECT set_config('hnsw.iterative_scan', ?, true)`, [
          this.iterativeScan as string,
        ]);
      }
      if (this.efSearch !== undefined) {
        await tx.rawQuery(`SELECT set_config('hnsw.ef_search', ?, true)`, [String(this.efSearch)]);
      }
      return read(tx);
    });
  }

  /** `hnsw.iterative_scan` exists from pgvector 0.8.0; setting it on an older one is an error. */
  private supportsIterativeScan(): Promise<boolean> {
    this.iterativeScanSupport ??= this.db
      .rawQuery(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)
      .then((raw) => {
        const version = String(normalizeRows(raw)[0]?.extversion ?? '0.0');
        const [major = 0, minor = 0] = version.split('.').map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => false);
    return this.iterativeScanSupport;
  }
}

/** Where the lexical leg of a {@link PgLexicalVectorStore} reads its `tsvector` from. */
export interface PgFullTextOptions {
  /**
   * Text-search configuration (`simple`, `english`, `portuguese`, …). Default `simple` — no stemming
   * or stop words, so it works for any language and matches exact terms. Must be the configuration
   * the index was built with, or Postgres cannot use the index and scans the table.
   */
  config?: string;
  /**
   * A `tsvector` column you maintain yourself (typically `GENERATED ALWAYS AS (…) STORED` in a
   * migration, e.g. weighting a title above the body) with its own GIN index. When omitted the store
   * searches `to_tsvector(config, text)`, and {@link PgVectorStore.schemaStatements} adds a GIN
   * expression index over exactly that.
   */
  column?: string;
  /**
   * Search natural-language questions by their meaningful terms (default `true`): the question's
   * stop words are dropped (see {@link PgFullTextOptions.stopWords}) and rows holding any remaining
   * term (at most 24) are ranked by the sum of the matched terms' IDF among those rows (BM25 without
   * term frequencies), `ts_rank_cd` breaking ties; a question with explicit search syntax (a quoted
   * phrase, `-word`) is first tried as written. `false`: only `websearch_to_tsquery` on the query as
   * written (every word must appear).
   */
  anyTermFallback?: boolean;
  /**
   * Stop word lists dropped from questions, by language; only the list(s) with the most words in the
   * question apply, so a word that is a stop word in another language stays a term. Default
   * {@link DEFAULT_STOP_WORDS} (English, Portuguese, Spanish: Postgres' Snowball lists). `false` keeps
   * every word. With a language `config` (`english`) Postgres drops that language's stop words too.
   */
  stopWords?: Readonly<Record<string, ReadonlySet<string>>> | false;
}

/**
 * {@link PgVectorStore} plus Postgres full-text search: a {@link LexicalVectorStore}, so a
 * {@link import('./lexical-retriever.js').LexicalRetriever} and a
 * {@link import('./hybrid-retriever.js').HybridRetriever} can fuse the dense and lexical legs over the
 * same rows and ids. `retrievers.pgvector({ fullText: {} })` wires exactly that.
 *
 * A question is searched by its meaningful terms: its stop words dropped, rows holding any remaining
 * term ranked by IDF-weighted coverage, `ts_rank_cd` (cover density) breaking ties (see
 * {@link PgFullTextOptions.anyTermFallback}); explicit syntax (quoted phrases, `-exclusions`) goes
 * through `websearch_to_tsquery` first.
 *
 * A separate class rather than a method on {@link PgVectorStore} on purpose: full-text search needs a
 * GIN index, which on a populated table belongs in a migration you run and watch (`CREATE INDEX` in
 * `ensureSchema` takes a write lock at boot), and a store that silently grew `searchText` on upgrade
 * would be picked up by every `isLexicalVectorStore` check and scan an unindexed table.
 */
export class PgLexicalVectorStore extends PgVectorStore implements LexicalVectorStore {
  private readonly tsConfig: string;
  private readonly tsColumn: string | undefined;
  private readonly anyTermFallback: boolean;
  private readonly stopWords: Readonly<Record<string, ReadonlySet<string>>>;

  constructor(
    db: LucidRawRunner,
    options: PgVectorStoreOptions & { fullText?: PgFullTextOptions } = {},
  ) {
    super(db, options);
    this.tsConfig = assertIdentifier(options.fullText?.config ?? 'simple', 'text search config');
    this.tsColumn =
      options.fullText?.column !== undefined
        ? assertIdentifier(options.fullText.column, 'column')
        : undefined;
    this.anyTermFallback = options.fullText?.anyTermFallback ?? true;
    const stopWords = options.fullText?.stopWords;
    this.stopWords = stopWords === false ? {} : (stopWords ?? DEFAULT_STOP_WORDS);
  }

  override schemaStatements(): string[] {
    const statements = super.schemaStatements();
    if (this.tsColumn === undefined) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${this.table}_${this.col.text}_tsv_idx
        ON ${this.table} USING gin (${this.tsvector()})`,
      );
    }
    return statements;
  }

  /**
   * Full-text search over the chunk text. `score` is an IDF / `ts_rank_cd` rank — not a similarity,
   * and not on the vector leg's scale — so `minScore` is deliberately not applied here.
   */
  async searchText(query: string, options: VectorSearchOptions): Promise<Passage[]> {
    if ((options.filter !== undefined && filterDeniesAll(options.filter)) || query.trim() === '') {
      return [];
    }
    if (!this.anyTermFallback || hasSearchSyntax(query)) {
      const strict = await this.runTextSearch(query, options);
      if (strict.length > 0 || !this.anyTermFallback) {
        return strict;
      }
    }
    const terms = keywordTerms(query, 24, this.stopWords);
    return terms.length === 0 ? [] : this.runRankedTermSearch(terms, options);
  }

  /** `websearch_to_tsquery` on the query as written: every word, quoted phrases, `-exclusions`. */
  private async runTextSearch(query: string, options: VectorSearchOptions): Promise<Passage[]> {
    const c = this.col;
    const where = buildMetadataWhere(options.filter, c.metadata);
    // The parsed query is a lateral relation, so the one `?` binding feeds both the match and the rank.
    const clauses = [`${this.tsvector()} @@ __tsq.q`];
    if (where.sql !== '') {
      clauses.push(where.sql.slice('WHERE '.length));
    }
    const raw = await this.db.rawQuery(
      `SELECT ${c.id} AS id, ${c.text} AS text, ${c.source} AS source, ${c.metadata} AS metadata,
              ts_rank_cd(${this.tsvector()}, __tsq.q) AS score
       FROM ${this.table}, websearch_to_tsquery('${this.tsConfig}', ?) AS __tsq(q)
       WHERE ${clauses.join(' AND ')}
       ORDER BY score DESC, ${c.id}
       LIMIT ?`,
      [query, ...where.bindings, options.topK],
    );
    return normalizeRows(raw).map(toPassage);
  }

  /**
   * Rows holding any of `terms`, ranked by the sum of the matched terms' IDF among those rows,
   * `ln(1 + (N - df + 0.5) / (df + 0.5))`, then `ts_rank_cd`. Each (row, term) match is evaluated
   * once, and `ts_rank_cd` only for the rows ranked within `topK` (ties included): a question full of
   * common words can match most of the table. Terms are letter/digit runs: space-joined in one
   * binding (no array binding), each quoted as a literal lexeme.
   */
  private async runRankedTermSearch(
    terms: string[],
    options: VectorSearchOptions,
  ): Promise<Passage[]> {
    const c = this.col;
    const cfg = this.tsConfig;
    const where = buildMetadataWhere(options.filter, c.metadata);
    const clauses = [`${this.tsvector()} @@ __any.q`];
    if (where.sql !== '') {
      clauses.push(where.sql.slice('WHERE '.length));
    }
    const raw = await this.db.rawQuery(
      `SELECT id, text, source, metadata, score FROM (
         WITH __terms AS (
           SELECT DISTINCT to_tsquery('${cfg}', quote_literal(t)) AS q
           FROM regexp_split_to_table(?, ' ') AS t
         ), __cand AS MATERIALIZED (
           SELECT ${c.id} AS id, ${c.text} AS text, ${c.source} AS source, ${c.metadata} AS metadata,
                  ${this.tsvector()} AS __tsv, __any.q AS __q
           FROM ${this.table}, to_tsquery('${cfg}', ?) AS __any(q)
           WHERE ${clauses.join(' AND ')}
         ), __hits AS MATERIALIZED (
           SELECT __cand.id AS __id, __terms.q FROM __cand JOIN __terms ON __cand.__tsv @@ __terms.q
         ), __idf AS (
           SELECT q, ln(1 + ((SELECT count(*) FROM __cand) - count(*) + 0.5) / (count(*) + 0.5)) AS w
           FROM __hits GROUP BY q
         ), __scored AS (
           SELECT __hits.__id, sum(__idf.w) AS s, rank() OVER (ORDER BY sum(__idf.w) DESC) AS r
           FROM __hits JOIN __idf USING (q) GROUP BY __hits.__id
         )
         SELECT __cand.id, __cand.text, __cand.source, __cand.metadata,
                __scored.s AS __s, ts_rank_cd(__cand.__tsv, __cand.__q, 32) AS __tr,
                __scored.s + ts_rank_cd(__cand.__tsv, __cand.__q, 32) AS score
         FROM __scored JOIN __cand ON __cand.id = __scored.__id
         WHERE __scored.r <= ?
       ) AS __ranked
       ORDER BY __s DESC, __tr DESC, id
       LIMIT ?`,
      [terms.join(' '), anyTermTsquery(terms), ...where.bindings, options.topK, options.topK],
    );
    return normalizeRows(raw).map(toPassage);
  }

  /** Must be character-for-character the index expression, or the planner won't use the index. */
  private tsvector(): string {
    return this.tsColumn ?? `to_tsvector('${this.tsConfig}'::regconfig, ${this.col.text})`;
  }
}

/** A Lucid handle that can also open a transaction (Lucid's `db` / a connection). */
interface LucidTransactionRunner extends LucidRawRunner {
  transaction<T>(callback: (trx: unknown) => Promise<T>): Promise<T>;
}

function toPassage(row: Record<string, unknown>): Passage {
  const metadata = parseMetadata(row.metadata);
  const source = row.source;
  return {
    id: String(row.id),
    text: String(row.text),
    score: Number(row.score),
    ...(source !== null && source !== undefined ? { source: String(source) } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * A {@link import('../spi/retriever.js').Retriever} over a {@link PgVectorStore}: embed the query, then
 * pgvector-search. The production sibling of the in-memory {@link EmbeddingRetriever} wiring — this is
 * what `retrievers.pgvector({...})` builds. Construct it directly for programmatic use, or let the factory.
 */
export class PgVectorRetriever extends EmbeddingRetriever {
  // biome-ignore lint/complexity/noUselessConstructor: not useless — it NARROWS `store` from the base's `VectorStore` to `PgVectorStore`, which is this subclass's whole point. Delete it and `new PgVectorRetriever(embedder, anyInMemoryStore)` starts compiling.
  constructor(embedder: EmbeddingProvider, store: PgVectorStore) {
    super(embedder, store);
  }
}
