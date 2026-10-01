/**
 * Which SQL dialect a Lucid client speaks, and the few spellings that differ between them.
 *
 * The agent's raw SQL is written once, Postgres/SQLite-style, with `"double-quoted"` identifiers —
 * which MySQL reads as string literals unless the server runs with `ANSI_QUOTES`. {@link portableSql}
 * is the one place that turns them into MySQL's backticks.
 */

/** The slice of a Lucid client (or the `Database` manager) that names its dialect. */
interface DialectShape {
  dialect?: { name?: string };
  connection?: () => { dialect?: { name?: string } };
}

/** The dialect name Lucid reports (`postgres`, `mysql`, `better-sqlite3`, …), or `''` when unknown. */
export function dialectOf(db: unknown): string {
  const client = db as DialectShape | null;
  if (typeof client?.dialect?.name === 'string') return client.dialect.name;
  try {
    return client?.connection?.().dialect?.name ?? '';
  } catch {
    return '';
  }
}

/** Does this client talk to MySQL (or MariaDB)? */
export function isMySql(db: unknown): boolean {
  return /mysql|maria/i.test(dialectOf(db));
}

/**
 * `sql` with its `"identifiers"` in the client's quoting: backticks on MySQL, unchanged elsewhere.
 * Every statement this is given quotes identifiers only — values are always bound (`?`) or written
 * in single quotes — so swapping the character is a full translation.
 */
export function portableSql(db: unknown, sql: string): string {
  return isMySql(db) ? sql.replaceAll('"', '`') : sql;
}
