/**
 * The `schema` option: put the agent's tables in a database schema other than the connection's (a
 * Postgres schema, a MySQL database). Every statement the stores issue names the schema itself —
 * never `SET search_path`, which leaks to other clients' connections behind PgBouncer in
 * transaction mode.
 *
 * Query-builder calls take {@link qualifiedName} (`schema.table`, which knex quotes as two
 * identifiers); raw SQL takes {@link qualifiedSql} (`"schema"."table"`, turned into backticks on
 * MySQL by `portableSql` / `forDialect` like every other identifier the statements quote).
 */
import type { LucidRawRunner } from './lucid.js';
import { dialectOf, isMySql } from './sql-dialect.js';

const PKG = '[@adonis-agora/agent]';

/** A schema name the agent accepts: a plain identifier. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** Postgres truncates identifiers at 63 bytes; MySQL database names stop at 64. */
const MAX_SCHEMA_LENGTH = 63;

/** Is `dialect` (a Lucid dialect name) one without schemas? */
function isSchemaless(dialect: string): boolean {
  return /sqlite|libsql/i.test(dialect);
}

/**
 * Check a `schema` option: `undefined` passes through (today's behaviour — unqualified names, the
 * connection's current schema), anything else must be a plain identifier of at most 63 characters.
 * `where` names the option in the error (`stores.lucid()`, `config/agent.ts`, …).
 */
export function assertSchemaName(schema: unknown, where: string): string | undefined {
  if (schema === undefined) return undefined;
  if (
    typeof schema !== 'string' ||
    !SCHEMA_NAME.test(schema) ||
    schema.length > MAX_SCHEMA_LENGTH
  ) {
    throw new Error(
      `${PKG} ${where}: \`schema\` must be a plain identifier (letters, digits, _ and $, not ` +
        `starting with a digit, at most ${MAX_SCHEMA_LENGTH} characters); got ${JSON.stringify(schema)}.`,
    );
  }
  return schema;
}

/**
 * {@link assertSchemaName}, plus the dialect: a connection without schemas (SQLite) cannot honour
 * `schema`, so it fails here — at boot — rather than falling back to the main database. A client
 * whose dialect cannot be told is let through: every statement names the schema anyway.
 */
export function validateSchema(db: unknown, schema: unknown, where: string): string | undefined {
  const name = assertSchemaName(schema, where);
  if (name === undefined) return undefined;
  const dialect = dialectOf(db);
  if (isSchemaless(dialect)) {
    throw new Error(
      `${PKG} ${where} sets \`schema: "${name}"\`, but its connection is ${dialect}, which has no ` +
        'schemas. Remove `schema`, or use a Postgres or MySQL connection.',
    );
  }
  return name;
}

/** A table for Lucid's query builder: `schema.table` (knex quotes each part), or the bare table. */
export function qualifiedName(table: string, schema: string | undefined): string {
  return schema === undefined ? table : `${schema}.${table}`;
}

/**
 * A table for raw SQL: `"schema"."table"`, or `"table"` without a schema. Double quotes, like every
 * identifier in the agent's statements: `portableSql` / `forDialect` swap them for MySQL.
 */
export function qualifiedSql(table: string, schema: string | undefined): string {
  return schema === undefined ? `"${table}"` : `"${schema}"."${table}"`;
}

/** Rows of a raw query result, whatever the driver wraps them in. */
function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
  }
  const list = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/**
 * Does `schema` exist? `pg_namespace` on Postgres (it lists every schema, while
 * `information_schema.schemata` hides the ones the role has no privilege on), the `SCHEMATA` view on
 * MySQL. A read: no lock.
 */
export async function schemaExists(db: LucidRawRunner, schema: string): Promise<boolean> {
  const found = isMySql(db)
    ? await db.rawQuery(
        'SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ?',
        [schema],
      )
    : await db.rawQuery('SELECT 1 AS found FROM pg_catalog.pg_namespace WHERE nspname = ?', [
        schema,
      ]);
  return rows(found).length > 0;
}

/** A missing privilege: Postgres 42501, MySQL 1044 / 1142 / 1227. */
function isPermissionDenied(error: unknown): boolean {
  for (let current = error; current !== null && typeof current === 'object'; ) {
    const { code, errno } = current as { code?: unknown; errno?: unknown };
    if (
      code === '42501' ||
      code === 'ER_DBACCESS_DENIED_ERROR' ||
      code === 'ER_TABLEACCESS_DENIED_ERROR' ||
      code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' ||
      errno === 1044 ||
      errno === 1142 ||
      errno === 1227
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Create `schema` when it is missing: `CREATE SCHEMA IF NOT EXISTS` on Postgres, `CREATE DATABASE IF
 * NOT EXISTS` on MySQL. The catalog is read first, so a role that may use an existing schema but not
 * create one boots fine. When the role cannot create it, the error names the schema and the grant.
 * What the stores run before their own DDL when they provision their tables.
 */
export async function ensureDatabaseSchema(db: LucidRawRunner, schema: string): Promise<void> {
  const mysql = isMySql(db);
  if (await schemaExists(db, schema)) return;
  const statement = mysql
    ? `CREATE DATABASE IF NOT EXISTS \`${schema}\``
    : `CREATE SCHEMA IF NOT EXISTS "${schema}"`;
  try {
    await db.rawQuery(statement);
  } catch (error) {
    // Two processes booting at once: the other one created it.
    if (await schemaExists(db, schema).catch(() => false)) return;
    if (!isPermissionDenied(error)) throw error;
    const grant = mysql
      ? `GRANT ALL ON \`${schema}\`.* TO <app user>`
      : `GRANT CREATE ON DATABASE <database> TO <app role> (or create it once: CREATE SCHEMA "${schema}" AUTHORIZATION <app role>)`;
    throw new Error(
      `${PKG} cannot create the ${mysql ? 'database' : 'schema'} "${schema}": the connection's ` +
        `role is not allowed to. Create it beforehand, or grant the role: ${grant}.`,
      { cause: error },
    );
  }
}
