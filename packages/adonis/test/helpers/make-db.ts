import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { createAgentTables, type LucidDatabaseLike } from '../../src/index.js';

/**
 * Build a standalone Lucid `Database` over an in-memory SQLite (`better-sqlite3`) — the "Lucid outside
 * an app" pattern (same three args Lucid's provider passes). The `:memory:` db is per-connection, so
 * the pool is pinned to 1 so every query hits the same database.
 */
export function makeMemoryDb(filename = ':memory:'): Database {
  const logger = new Logger({ enabled: false });
  const emitter = new Emitter(undefined as never);
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename },
          useNullAsDefault: true,
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter,
  );
}

/**
 * A fresh database with the agent tables already created — in-memory SQLite, or, in the `postgres` /
 * `mysql` test projects (`AGENT_TEST_BACKEND`), a throwaway database on that server (see
 * `vitest.config.ts` and `test/helpers/real-db.ts`), so every spec built on this runs on all three.
 * `db.manager.closeAll()` also drops the throwaway database.
 */
export async function makeStoreDb(): Promise<Database> {
  const backend = process.env.AGENT_TEST_BACKEND;
  if (backend === 'postgres' || backend === 'mysql') {
    const { openBackend } = await import('./real-db.js');
    const handle = await openBackend(backend);
    const closeAll = handle.db.manager.closeAll.bind(handle.db.manager);
    handle.db.manager.closeAll = async (...args: Parameters<typeof closeAll>) => {
      await closeAll(...args);
      await handle.close();
    };
    return handle.db;
  }
  const db = makeMemoryDb();
  await createAgentTables(db as unknown as LucidDatabaseLike);
  return db;
}

/** Cast a real Lucid `Database` to the structural type `LucidAgentStore` accepts. */
export function asStoreDb(db: Database): LucidDatabaseLike {
  return db as unknown as LucidDatabaseLike;
}
