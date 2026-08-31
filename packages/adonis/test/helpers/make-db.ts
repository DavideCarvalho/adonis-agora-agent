import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { createAgentTables, type LucidDatabaseLike } from '../../src/index.js';

/**
 * Build a standalone Lucid `Database` over an in-memory SQLite (`better-sqlite3`) — the "Lucid outside
 * an app" pattern (same three args Lucid's provider passes). The `:memory:` db is per-connection, so
 * the pool is pinned to 1 so every query hits the same database.
 */
export function makeMemoryDb(): Database {
  const logger = new Logger({ enabled: false });
  const emitter = new Emitter(undefined as never);
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter,
  );
}

/** A fresh in-memory db with the five agent tables already created. */
export async function makeStoreDb(): Promise<Database> {
  const db = makeMemoryDb();
  await createAgentTables(db as unknown as LucidDatabaseLike);
  return db;
}

/** Cast a real Lucid `Database` to the structural type `LucidAgentStore` accepts. */
export function asStoreDb(db: Database): LucidDatabaseLike {
  return db as unknown as LucidDatabaseLike;
}
