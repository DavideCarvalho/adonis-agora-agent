import type { LucidRawRunner } from '../../stores/lucid.js';
import { buildMetadataWhere, normalizeRows, stripNulBytes } from '../pg-vector-store.js';
import { type DocumentTreeHeader, type DocumentTreeStore, headerOf } from './store.js';
import type { DocumentTree, TreeUnit } from './types.js';

export interface PgDocumentTreeStoreOptions {
  /** Trees table. Default `agent_rag_trees`. Validated against the identifier regex. */
  table?: string;
  /** Units (page/section text) table. Default `${table}_units`, i.e. `agent_rag_trees_units`. */
  unitsTable?: string;
  /** Unit rows per multi-row `INSERT`. Default 200. */
  insertBatchSize?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`PgDocumentTreeStore: invalid table name ${JSON.stringify(name)}`);
  }
  return name;
}

/** Lucid's `db` (and a transaction client) — `transaction` is used when present. */
interface TransactionRunner extends LucidRawRunner {
  transaction<T>(callback: (trx: unknown) => Promise<T>): Promise<T>;
}

/** A `jsonb` column comes back parsed on `pg`, as a string on some drivers — accept both. */
function json<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/** `WHERE a AND b` → `['a', 'b']`-style: the conditions of {@link buildMetadataWhere}, without the keyword. */
function metadataConditions(filter: Record<string, unknown> | undefined): {
  sql: string | undefined;
  bindings: unknown[];
} {
  const where = buildMetadataWhere(filter, 'metadata');
  return {
    sql: where.sql === '' ? undefined : where.sql.replace(/^WHERE\s+/, ''),
    bindings: where.bindings,
  };
}

/**
 * A Postgres {@link DocumentTreeStore} over Lucid's raw runner (`db` or `db.connection(name)` — the
 * same structural {@link LucidRawRunner} `PgVectorStore` takes, so `@adonisjs/lucid` stays an
 * optional peer): one row per tree (header columns, `metadata` as `jsonb` for filtering, the nodes as
 * `jsonb`) and one row per unit of text. Filters compile through the same builder as `PgVectorStore`'s
 * — scalar `@>` containment, array match-any, empty array denies — so the filter you pass the vector
 * store works here unchanged.
 *
 * Provision it with the published `create_agent_rag_trees` migration, or {@link ensureSchema} /
 * {@link schemaStatements}. Needs no extension. Writes run in one transaction when the runner has one.
 */
export class PgDocumentTreeStore implements DocumentTreeStore {
  protected readonly table: string;
  protected readonly unitsTable: string;
  private readonly insertBatchSize: number;

  constructor(
    protected readonly db: LucidRawRunner,
    options: PgDocumentTreeStoreOptions = {},
  ) {
    this.table = assertIdentifier(options.table ?? 'agent_rag_trees');
    this.unitsTable = assertIdentifier(options.unitsTable ?? `${this.table}_units`);
    this.insertBatchSize = Math.max(1, Math.floor(options.insertBatchSize ?? 200));
  }

  /** The idempotent DDL {@link ensureSchema} runs, in order. */
  schemaStatements(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        document_id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        structure TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        unit_count INTEGER NOT NULL,
        source TEXT,
        metadata JSONB,
        tree JSONB NOT NULL,
        built_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${this.table}_metadata_idx ON ${this.table} USING gin (metadata)`,
      `CREATE TABLE IF NOT EXISTS ${this.unitsTable} (
        document_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        page INTEGER,
        text TEXT NOT NULL,
        PRIMARY KEY (document_id, idx)
      )`,
    ];
  }

  async ensureSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      await this.db.rawQuery(statement);
    }
  }

  private async write(work: (runner: LucidRawRunner) => Promise<void>): Promise<void> {
    const transaction = (this.db as Partial<TransactionRunner>).transaction;
    if (typeof transaction !== 'function') {
      await work(this.db);
      return;
    }
    await transaction.call(this.db, async (trx: unknown) => {
      const runner = trx as Partial<LucidRawRunner>;
      await work(typeof runner.rawQuery === 'function' ? (runner as LucidRawRunner) : this.db);
    });
  }

  /** Replace the tree and its units (one transaction when the runner has one). */
  async put(tree: DocumentTree, units: TreeUnit[]): Promise<void> {
    const clean = stripNulBytes(tree);
    const { metadata, ...rest } = clean;
    await this.write(async (runner) => {
      await runner.rawQuery(`DELETE FROM ${this.unitsTable} WHERE document_id = ?`, [
        clean.documentId,
      ]);
      for (let start = 0; start < units.length; start += this.insertBatchSize) {
        const batch = units.slice(start, start + this.insertBatchSize);
        const bindings: unknown[] = [];
        for (const unit of batch) {
          bindings.push(clean.documentId, unit.index, unit.page ?? null, stripNulBytes(unit.text));
        }
        await runner.rawQuery(
          `INSERT INTO ${this.unitsTable} (document_id, idx, page, text) VALUES ${batch
            .map(() => '(?, ?, ?, ?)')
            .join(', ')}`,
          bindings,
        );
      }
      await runner.rawQuery(
        `INSERT INTO ${this.table}
           (document_id, title, description, structure, fingerprint, unit_count, source, metadata, tree, built_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
         ON CONFLICT (document_id) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description, structure = EXCLUDED.structure,
           fingerprint = EXCLUDED.fingerprint, unit_count = EXCLUDED.unit_count, source = EXCLUDED.source,
           metadata = EXCLUDED.metadata, tree = EXCLUDED.tree, built_at = EXCLUDED.built_at`,
        [
          clean.documentId,
          clean.title ?? null,
          clean.description ?? null,
          clean.structure,
          clean.fingerprint,
          clean.unitCount,
          clean.source ?? null,
          metadata === undefined ? null : JSON.stringify(metadata),
          JSON.stringify(rest),
          clean.builtAt,
        ],
      );
    });
  }

  async get(
    documentId: string,
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree | undefined> {
    return (await this.getMany([documentId], filter))[0];
  }

  async getMany(
    documentIds: readonly string[],
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree[]> {
    if (documentIds.length === 0) {
      return [];
    }
    const where = metadataConditions(filter);
    const rows = normalizeRows(
      await this.db.rawQuery(
        `SELECT document_id, metadata, tree FROM ${this.table}
          WHERE document_id = ANY(?::text[])${where.sql !== undefined ? ` AND ${where.sql}` : ''}`,
        [[...new Set(documentIds)], ...where.bindings],
      ),
    );
    return rows.map((row) => {
      const tree = json<DocumentTree>(row.tree) as DocumentTree;
      const metadata = json<Record<string, unknown>>(row.metadata);
      return { ...tree, ...(metadata !== undefined ? { metadata } : {}) };
    });
  }

  async list(
    options: {
      filter?: Record<string, unknown>;
      documentIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<DocumentTreeHeader[]> {
    const where = metadataConditions(options.filter);
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (where.sql !== undefined) {
      conditions.push(where.sql);
      bindings.push(...where.bindings);
    }
    if (options.documentIds !== undefined) {
      conditions.push('document_id = ANY(?::text[])');
      bindings.push([...options.documentIds]);
    }
    let limit = '';
    if (options.limit !== undefined) {
      limit = 'LIMIT ?';
      bindings.push(Math.max(0, Math.floor(options.limit)));
    }
    const rows = normalizeRows(
      await this.db.rawQuery(
        `SELECT document_id, title, description, structure, fingerprint, unit_count, source, metadata, built_at
           FROM ${this.table}
           ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
           ORDER BY document_id ${limit}`,
        bindings,
      ),
    );
    return rows.map((row) => {
      const metadata = json<Record<string, unknown>>(row.metadata);
      const builtAt = row.built_at;
      return headerOf({
        documentId: String(row.document_id),
        version: 1,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        structure: row.structure as DocumentTree['structure'],
        fingerprint: String(row.fingerprint),
        unitCount: Number(row.unit_count),
        nodes: [],
        stats: {
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          budgetExhausted: false,
          reusedSummaries: 0,
        },
        ...(metadata !== undefined ? { metadata } : {}),
        ...(typeof row.source === 'string' ? { source: row.source } : {}),
        builtAt:
          builtAt instanceof Date ? builtAt.toISOString() : new Date(String(builtAt)).toISOString(),
      });
    });
  }

  async readUnits(documentId: string, start: number, end: number): Promise<TreeUnit[]> {
    const rows = normalizeRows(
      await this.db.rawQuery(
        `SELECT idx, page, text FROM ${this.unitsTable}
          WHERE document_id = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
        [documentId, Math.max(0, start), end],
      ),
    );
    return rows.map((row) => ({
      index: Number(row.idx),
      text: String(row.text),
      ...(row.page !== null && row.page !== undefined ? { page: Number(row.page) } : {}),
    }));
  }

  async remove(documentId: string): Promise<void> {
    await this.write(async (runner) => {
      await runner.rawQuery(`DELETE FROM ${this.unitsTable} WHERE document_id = ?`, [documentId]);
      await runner.rawQuery(`DELETE FROM ${this.table} WHERE document_id = ?`, [documentId]);
    });
  }
}
