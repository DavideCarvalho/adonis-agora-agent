import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataTool, GroupTableAccessPolicy } from '../src/index.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { asStoreDb, makeMemoryDb } from './helpers/make-db.js';

let db: Database;

const tableAccess = new GroupTableAccessPolicy({
  roleGroups: { ANALYST: ['OPERATIONAL'] },
  tablesByGroup: { OPERATIONAL: ['vehicle'] },
});

function ctx(tenantRef?: string): AiToolCtx {
  return {
    threadId: 't',
    runId: 'r',
    requestId: 'q',
    actor: { id: 'a', roles: ['ANALYST'], ...(tenantRef === undefined ? {} : { tenantRef }) },
  };
}

beforeEach(async () => {
  db = makeMemoryDb();
  await db.rawQuery('CREATE TABLE vehicle (id INTEGER PRIMARY KEY, name TEXT, base_id TEXT)');
  await db.rawQuery("INSERT INTO vehicle (id, name, base_id) VALUES (1, 'alpha', 'tenant-1')");
  await db.rawQuery("INSERT INTO vehicle (id, name, base_id) VALUES (2, 'bravo', 'tenant-1')");
  await db.rawQuery("INSERT INTO vehicle (id, name, base_id) VALUES (3, 'charlie', 'tenant-2')");
});

afterEach(async () => {
  await db?.manager.closeAll();
});

describe('dataTool over a real Lucid SQLite connection', () => {
  it('runs a governed SELECT and returns rows', async () => {
    const tool = dataTool({ db: asStoreDb(db), tableAccess });

    const result = (await tool.handler.execute({ sql: 'SELECT id, name FROM vehicle' }, ctx())) as {
      rows: Array<{ id: number; name: string }>;
      rowCount: number;
    };

    expect(result.rowCount).toBe(3);
    expect(result.rows.map((r) => r.name).sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('scopes the SELECT to the caller tenant end-to-end', async () => {
    const tool = dataTool({
      db: asStoreDb(db),
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    const result = (await tool.handler.execute(
      { sql: 'SELECT id, name FROM vehicle' },
      ctx('tenant-1'),
    )) as { rows: Array<{ id: number }>; rowCount: number };

    // Only tenant-1's two rows come back — tenant-2's row is filtered out by the injected predicate.
    expect(result.rowCount).toBe(2);
    expect(result.rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it('null tenant returns nothing (fail-closed) rather than every tenant', async () => {
    const tool = dataTool({
      db: asStoreDb(db),
      tableAccess,
      tenant: { tenantColumn: 'base_id', scopedTables: ['vehicle'] },
    });

    const result = (await tool.handler.execute(
      { sql: 'SELECT id FROM vehicle' },
      ctx(null as unknown as string),
    )) as { rowCount: number };

    // base_id = 'null' matches no row → 0, proving null never became the privileged all-tenants read.
    expect(result.rowCount).toBe(0);
  });
});
