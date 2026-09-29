import { execFileSync } from 'node:child_process';
import type {
  LucidClientLike,
  LucidDatabaseLike,
  LucidInsertBuilderLike,
  LucidQueryBuilderLike,
} from '../../src/index.js';
/**
 * Live-Postgres test harness: lets the REAL Postgres stores (`PgVectorStore`, `PgDocumentTreeStore`)
 * emit their REAL SQL against a real Postgres with a real `vector` extension. The recording-fake specs
 * prove we emit the SQL we meant to; only a live run proves the SQL is valid, that
 * `(metadata || patch) - keys[]` merges the way we claim, and that a filtered `DELETE` reaches exactly
 * the rows the matching `SELECT` does.
 *
 * This package has no `pg` driver in its dependency tree (Lucid is an optional peer, and adding a driver
 * to run one spec is not a trade worth making), so the {@link LucidDatabaseLike} here shells out to
 * `psql` inside a container instead. It is a test harness, not a shipped adapter: it interpolates
 * bindings as SQL literals, which is exactly what the production store refuses to do — acceptable here
 * because every value comes from the specs that use it.
 *
 * Specs using it skip unless `AGENT_PG_DOCKER` names a running pgvector container:
 *
 *   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres --name pgv pgvector/pgvector:pg17
 *   AGENT_PG_DOCKER=pgv npx vitest run test/rag-pgvector-live.spec.ts
 */
export const CONTAINER = process.env.AGENT_PG_DOCKER;
const PG_USER = process.env.AGENT_PG_USER ?? 'postgres';
const PG_DB = process.env.AGENT_PG_DB ?? 'postgres';

/** A binding rendered as a SQL literal. Test-only; see the file docblock. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Render `?` bindings as literals; a row-returning statement is wrapped to come back as one JSON document. */
function render(sql: string, bindings: unknown[]): { sql: string; returnsRows: boolean } {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  if (placeholders !== bindings.length) {
    throw new Error(
      `binding count mismatch: ${placeholders} placeholders, ${bindings.length} bindings`,
    );
  }
  let index = 0;
  const rendered = sql.replace(/\?/g, () => literal(bindings[index++]));
  // Statements that return rows are wrapped so psql hands back one JSON document. A data-modifying
  // CTE is legal in `WITH`, which is what makes `UPDATE … RETURNING` and `DELETE … RETURNING` work
  // here alongside plain `SELECT`s.
  const returnsRows = /\bRETURNING\b/i.test(rendered) || /^\s*SELECT\b/i.test(rendered);
  return {
    sql: returnsRows
      ? `WITH __q AS (${rendered}) SELECT COALESCE(json_agg(__q), '[]'::json)::text FROM __q`
      : rendered,
    returnsRows,
  };
}

/**
 * Run `statement` in one psql session, preceded by `before` and followed by `after` (one `-c` each),
 * and return only `statement`'s output: the others write to /dev/null (`\o`).
 */
function psql(statement: string, before: string[] = [], after: string[] = []): string {
  const quiet = (statements: string[]) =>
    statements.length === 0 ? [] : ['\\o /dev/null', ...statements, '\\o'];
  const commands = [...quiet(before), statement, ...quiet(after)];
  return execFileSync(
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
      '-qtA',
      '-v',
      'ON_ERROR_STOP=1',
      ...commands.flatMap((command) => ['-c', command]),
    ],
    { encoding: 'utf8' },
  );
}

export class PsqlDockerDb implements LucidDatabaseLike {
  readonly statements: string[] = [];

  async rawQuery(sql: string, bindings: unknown[] = []): Promise<unknown> {
    const statement = render(sql, bindings);
    this.statements.push(statement.sql);
    const out = psql(statement.sql);
    if (!statement.returnsRows) return [];
    return JSON.parse(out.trim() || '[]') as Record<string, unknown>[];
  }

  from(_table: string): LucidQueryBuilderLike {
    throw new Error('unused');
  }
  table(_table: string): LucidInsertBuilderLike {
    throw new Error('unused');
  }
  /**
   * A transaction without a persistent connection: every statement issued inside it runs as
   * `BEGIN; <every earlier statement of this transaction>; <this one>; COMMIT` in one psql session.
   * Replaying the prefix is sound for what the store sends here (`set_config` + a read).
   */
  transaction<T>(callback: (trx: LucidClientLike) => Promise<T>): Promise<T> {
    const prefix: string[] = [];
    const trx = {
      rawQuery: async (sql: string, bindings: unknown[] = []): Promise<unknown> => {
        const statement = render(sql, bindings);
        this.statements.push(statement.sql);
        const out = psql(statement.sql, ['BEGIN', ...prefix], ['COMMIT']);
        prefix.push(statement.sql);
        if (!statement.returnsRows) return [];
        return JSON.parse(out.trim() || '[]') as Record<string, unknown>[];
      },
    };
    return callback(trx as unknown as LucidClientLike);
  }
}
