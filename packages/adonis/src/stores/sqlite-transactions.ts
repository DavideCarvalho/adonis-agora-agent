import type { LucidClientLike, LucidDatabaseLike } from './lucid.js';
import { dialectOf } from './sql-dialect.js';

let sqliteWriter: Promise<void> = Promise.resolve();
/**
 * A synchronous SQLite driver cannot wait for another writer in this process while that writer
 * needs the JS event loop to finish its transaction. Queue our own transactions before opening
 * them; actual database locks and proposal version fences still govern other processes.
 */
export async function withStoreTransaction<T>(
  db: LucidDatabaseLike,
  callback: (client: LucidClientLike) => Promise<T>,
): Promise<T> {
  if (!/sqlite/i.test(dialectOf(db))) return db.transaction(callback);
  const previous = sqliteWriter;
  let release!: () => void;
  sqliteWriter = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await db.transaction(callback);
  } finally {
    release();
  }
}
