import type { EmbeddingProvider } from '../spi/embedding-provider.js';
import type { Passage } from '../spi/retriever.js';
import type { LucidRawRunner } from '../stores/lucid.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import type {
  IndexedDocument,
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
  /** Embedding width — must match your model (e.g. 1536 for text-embedding-3-small). Default 1536. */
  dimension?: number;
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
  score(embeddingColumn: string): string;
}

const METRICS: Record<PgVectorMetric, MetricSpec> = {
  cosine: {
    operator: '<=>',
    opclass: 'vector_cosine_ops',
    score: (col) => `1 - (${col} <=> ?::vector)`,
  },
  l2: {
    operator: '<->',
    opclass: 'vector_l2_ops',
    score: (col) => `-(${col} <-> ?::vector)`,
  },
  inner: {
    // pgvector's `<#>` returns the NEGATIVE inner product, so `-(a <#> b)` recovers the inner product
    // and `ORDER BY a <#> b ASC` ranks the largest inner product first — consistent with the others.
    operator: '<#>',
    opclass: 'vector_ip_ops',
    score: (col) => `-(${col} <#> ?::vector)`,
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
 */
function buildMetadataWhere(
  filter: Record<string, unknown> | undefined,
  metadataColumn: string,
): { sql: string; bindings: unknown[] } {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return { sql: '', bindings: [] };
  }
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const scalar: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
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
      bindings.push(key, key, key, value.map(String));
    } else {
      scalar[key] = value;
    }
  }
  if (Object.keys(scalar).length > 0) {
    clauses.push(`${metadataColumn} @> ?::jsonb`);
    bindings.push(JSON.stringify(scalar));
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, bindings };
}

/** Normalize whatever a Lucid `rawQuery` returns (PG `{rows}`, SQLite array, MySQL `[rows,fields]`). */
function normalizeRows(raw: unknown): Record<string, unknown>[] {
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
  private readonly table: string;
  private readonly dimension: number;
  private readonly metric: MetricSpec;
  private readonly metricName: PgVectorMetric;
  private readonly col: Required<PgVectorColumns>;

  constructor(
    private readonly db: LucidRawRunner,
    options: PgVectorStoreOptions = {},
  ) {
    this.table = assertIdentifier(options.table ?? 'agent_rag_chunks', 'table');
    this.dimension = options.dimension ?? 1536;
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
    return [
      'CREATE EXTENSION IF NOT EXISTS vector',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        ${c.id} TEXT PRIMARY KEY,
        ${c.text} TEXT NOT NULL,
        ${c.source} TEXT,
        ${c.metadata} JSONB,
        ${c.embedding} vector(${this.dimension}) NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${this.table}_${c.embedding}_idx
        ON ${this.table} USING hnsw (${c.embedding} ${this.metric.opclass})`,
    ];
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const c = this.col;
    for (const record of records) {
      await this.db.rawQuery(
        `INSERT INTO ${this.table} (${c.id}, ${c.text}, ${c.source}, ${c.metadata}, ${c.embedding})
         VALUES (?, ?, ?, ?::jsonb, ?::vector)
         ON CONFLICT (${c.id}) DO UPDATE SET
           ${c.text} = EXCLUDED.${c.text},
           ${c.source} = EXCLUDED.${c.source},
           ${c.metadata} = EXCLUDED.${c.metadata},
           ${c.embedding} = EXCLUDED.${c.embedding}`,
        [
          record.id,
          record.text,
          record.source ?? null,
          record.metadata !== undefined ? JSON.stringify(record.metadata) : null,
          toVectorLiteral(record.embedding),
        ],
      );
    }
  }

  async remove(documentId: string): Promise<void> {
    await this.db.rawQuery(`DELETE FROM ${this.table} WHERE ${documentIdExpr(this.col.id)} = ?`, [
      documentId,
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
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    const keys = effectivePatchKeys(patch);
    if (keys.length === 0) {
      return 0;
    }
    const set: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const key of keys) {
      if (patch[key] === null) {
        removed.push(key);
      } else {
        set[key] = patch[key];
      }
    }
    const c = this.col;
    const raw = await this.db.rawQuery(
      `UPDATE ${this.table}
          SET ${c.metadata} = (COALESCE(${c.metadata}, '{}'::jsonb) || ?::jsonb) - ?::text[]
        WHERE ${documentIdExpr(c.id)} = ?
        RETURNING ${c.id} AS id`,
      [JSON.stringify(set), removed, documentId],
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

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const c = this.col;
    const vector = toVectorLiteral(embedding);
    const scoreExpr = this.metric.score(c.embedding);
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
    const raw = await this.db.rawQuery(
      `SELECT ${c.id} AS id, ${c.text} AS text, ${c.source} AS source, ${c.metadata} AS metadata,
              ${scoreExpr} AS score
       FROM ${this.table}
       ${whereSql}
       ORDER BY ${c.embedding} ${this.metric.operator} ?::vector
       LIMIT ?`,
      bindings,
    );
    return normalizeRows(raw).map((row) => {
      const metadata = parseMetadata(row.metadata);
      const source = row.source;
      return {
        id: String(row.id),
        text: String(row.text),
        score: Number(row.score),
        ...(source !== null && source !== undefined ? { source: String(source) } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      };
    });
  }
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
