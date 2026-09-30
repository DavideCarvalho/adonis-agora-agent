import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  AGENT_TABLES,
  createAgentTables,
  dropAgentTables,
  LucidAgentStore,
  type LucidDatabaseLike,
} from '../src/index.js';

/**
 * The schema against a real Postgres, because the bug this guards is a Postgres LOCK and no fake or
 * SQLite database has it: `CREATE INDEX IF NOT EXISTS` takes the table lock before it looks whether
 * the index exists, and that lock waits for any open transaction that wrote to the table. A Japa suite
 * runs inside one global transaction that never commits, so the library's "no-op" provisioning on
 * first use waited forever and the whole run hung.
 *
 * Runs when `AGENT_TEST_PG_URL` names a database this may create and drop the agent tables in (CI
 * provides one); skipped otherwise.
 */
const url = process.env.AGENT_TEST_PG_URL;

const actor: Actor = { id: 'user-1', roles: ['ADMIN'] };

function makePgDb(): Database {
  const target = new URL(url as string);
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: {
            host: target.hostname,
            port: Number(target.port || 5432),
            user: decodeURIComponent(target.username),
            password: decodeURIComponent(target.password),
            database: target.pathname.slice(1),
          },
          pool: { min: 0, max: 8 },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

const asStoreDb = (db: unknown) => db as LucidDatabaseLike;

/** Reject when `work` has not settled in `ms` — a hang becomes a failure instead of a stuck suite. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe.skipIf(url === undefined)('agent schema provisioning on Postgres', () => {
  let db: Database;

  beforeEach(async () => {
    db = makePgDb();
    await dropAgentTables(asStoreDb(db));
  });

  afterEach(async () => {
    if (db.connectionGlobalTransactions.size > 0) await db.rollbackGlobalTransaction();
    await dropAgentTables(asStoreDb(db));
    await db.manager.closeAll();
  });

  it('a first agent call does not wait for an open global transaction (the hung test suite)', async () => {
    await createAgentTables(asStoreDb(db));
    // What `stores.lucid({ connection })` holds: a plain client taken at boot, before any test ran.
    const store = new LucidAgentStore(asStoreDb(db.connection('pg')));

    // The suite's global transaction, holding a write on `agent_thread` that it never commits.
    await db.beginGlobalTransaction();
    await new LucidAgentStore(asStoreDb(db), { autoCreateTables: false }).createThread({
      actor,
      persona: 'default',
    });

    // The store's first use provisions the (already current) schema. It must not queue behind the
    // transaction above.
    const thread = await within(5000, store.createThread({ actor, persona: 'default' }));
    expect(thread.id).toBeTruthy();
  });

  it('provisions outside a global transaction: the tables survive its rollback and it is not aborted', async () => {
    const store = new LucidAgentStore(asStoreDb(db));

    await db.beginGlobalTransaction();
    // First use, on an EMPTY database, through the manager — whose every query is the transaction.
    const thread = await within(5000, store.createThread({ actor, persona: 'default' }));
    // The column probes fail by design on a missing column; inside the transaction that would have
    // aborted it and this read would throw "current transaction is aborted".
    expect((await store.getThread(thread.id))?.id).toBe(thread.id);
    await db.rollbackGlobalTransaction();

    // The thread was the test's and is gone; the schema was the library's and is not.
    expect(await store.getThread(thread.id)).toBeNull();
    const indexes = await db.rawQuery(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`,
      [AGENT_TABLES.threads],
    );
    expect(indexes.rows.length).toBeGreaterThan(1);
  });

  it('several processes provisioning an empty database at once all succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createAgentTables(asStoreDb(db.connection('pg')))),
    );
    expect(results).toHaveLength(6);
    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    expect((await store.createThread({ actor, persona: 'default' })).id).toBeTruthy();
  });

  it('several processes repairing an out-of-date database at once all succeed', async () => {
    await createAgentTables(asStoreDb(db));
    await db.rawQuery(`ALTER TABLE "${AGENT_TABLES.threads}" DROP COLUMN "queue_pause"`);
    await db.rawQuery(`ALTER TABLE "${AGENT_TABLES.messages}" DROP COLUMN "feedback"`);
    await db.rawQuery(`DROP TABLE "${AGENT_TABLES.queuedMessages}"`);

    await Promise.all(
      Array.from({ length: 6 }, () => createAgentTables(asStoreDb(db.connection('pg')))),
    );
    // Current again: a further pass finds nothing to repair.
    expect(await createAgentTables(asStoreDb(db))).toEqual([]);
  });
});
