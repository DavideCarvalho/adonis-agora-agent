import type { LucidDatabaseLike } from '../../src/index.js';

/** The names of the indexes on `table`, from whichever catalog the dialect has. */
export async function indexNames(db: LucidDatabaseLike, table: string): Promise<string[]> {
  const dialect = (db as unknown as { connection(): { dialect: { name: string } } }).connection()
    .dialect.name;
  const [sql, bindings] = /mysql/.test(dialect)
    ? [
        'SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?',
        [table],
      ]
    : /postgres|pg/.test(dialect)
      ? ['SELECT indexname AS name FROM pg_indexes WHERE tablename = ?', [table]]
      : [`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, [table]];
  const result = (await db.rawQuery(sql, bindings)) as unknown;
  const rows = Array.isArray(result)
    ? Array.isArray(result[0])
      ? result[0]
      : result
    : ((result as { rows: unknown[] }).rows ?? []);
  return (rows as Record<string, unknown>[]).map((row) => String(row.name ?? row.NAME));
}
