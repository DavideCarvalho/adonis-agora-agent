import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  createAgentTables,
  LucidAgentStore,
  type LucidRawRunner,
  schemaRunner,
} from '../src/index.js';
import { asStoreDb, makeMemoryDb } from './helpers/make-db.js';

const actor: Actor = { id: 'user-1', roles: ['ADMIN'] };

/** Record every statement `createAgentTables` issues against `db`. */
function recording(db: Database): { runner: LucidRawRunner; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    runner: {
      rawQuery(sql, bindings) {
        statements.push(sql);
        return db.rawQuery(sql, bindings as never);
      },
    },
  };
}

describe('provisioning a schema that is already current', () => {
  let db: Database;
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('issues no CREATE INDEX and no ALTER — nothing that takes a table lock', async () => {
    db = makeMemoryDb();
    await createAgentTables(asStoreDb(db));

    const { runner, statements } = recording(db);
    expect(await createAgentTables(runner)).toEqual([]);

    // On Postgres `CREATE INDEX IF NOT EXISTS` locks the table BEFORE it checks for the index, so a
    // re-issued one waits for any open transaction that wrote to the table. Existing indexes are
    // found in the catalog instead.
    expect(statements.filter((sql) => /^(CREATE INDEX|ALTER)/.test(sql))).toEqual([]);
  });

  it('still creates an index that is missing', async () => {
    db = makeMemoryDb();
    await createAgentTables(asStoreDb(db));
    await db.rawQuery('DROP INDEX "agent_thread_actor_updated_idx"');

    const { runner, statements } = recording(db);
    await createAgentTables(runner);

    expect(statements.filter((sql) => sql.startsWith('CREATE INDEX'))).toEqual([
      expect.stringContaining('"agent_thread_actor_updated_idx"'),
    ]);
  });
});

describe('a DDL statement that lost a race to another process', () => {
  /** A database where everything exists, but whose DDL fails the way a lost race does. */
  function racing(statements: string[]): LucidRawRunner {
    return {
      async rawQuery(sql) {
        statements.push(sql);
        if (/^(CREATE TABLE|CREATE INDEX)/.test(sql)) throw new Error('already exists');
        // Probes: no index catalog on this "dialect", every table and column is there.
        if (/pg_indexes|sqlite_master/.test(sql)) throw new Error('no such catalog');
        return [];
      },
    };
  }

  it('is done when what it meant to create exists', async () => {
    const statements: string[] = [];
    const db = racing(statements);
    // Tables: the failed CREATE is re-checked, the table is there. Indexes with no catalog to
    // re-check against cannot be proven, so that failure surfaces.
    await expect(createAgentTables(db)).rejects.toThrow('already exists');
    expect(statements.filter((sql) => sql.startsWith('CREATE TABLE'))).toHaveLength(9);
  });

  it('still throws when it does not — a real failure is never swallowed', async () => {
    const db: LucidRawRunner = {
      async rawQuery() {
        throw new Error('permission denied');
      },
    };
    await expect(createAgentTables(db)).rejects.toThrow('permission denied');
  });
});

describe('schemaRunner — the client DDL runs on', () => {
  let db: Database;
  afterEach(async () => {
    if (db !== undefined && db.connectionGlobalTransactions.size > 0) {
      await db.rollbackGlobalTransaction();
    }
    await db?.manager.closeAll();
  });

  it('is the db itself when no global transaction is open', () => {
    db = makeMemoryDb();
    expect(schemaRunner(asStoreDb(db))).toBe(db);
  });

  it('stays inside a SQLite global transaction (one writer: a second connection could only wait)', async () => {
    db = makeMemoryDb();
    await db.beginGlobalTransaction();
    expect(schemaRunner(asStoreDb(db))).toBe(db);

    // And the store provisions and works there, on a pool of ONE connection the transaction holds.
    const store = new LucidAgentStore(asStoreDb(db));
    expect((await store.createThread({ actor, persona: 'default' })).id).toBeTruthy();
  });

  it('steps outside a global transaction on a server dialect, and leaves it registered', () => {
    const transaction = { isTransaction: true, dialect: { name: 'postgres' } };
    const plain = { rawQuery: async () => [] };
    const manager = {
      primaryConnectionName: 'pg',
      connectionGlobalTransactions: new Map([['pg', transaction]]),
      connection(name: string) {
        return this.connectionGlobalTransactions.get(name) ?? plain;
      },
      rawQuery: async () => [],
    };
    expect(schemaRunner(manager as unknown as LucidRawRunner)).toBe(plain);
    expect(manager.connectionGlobalTransactions.get('pg')).toBe(transaction);
  });

  it('returns anything that is not the Database manager unchanged', () => {
    const client: LucidRawRunner = { rawQuery: async () => [] };
    expect(schemaRunner(client)).toBe(client);
  });
});
