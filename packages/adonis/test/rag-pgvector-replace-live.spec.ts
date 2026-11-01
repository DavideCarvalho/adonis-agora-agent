import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgVectorStore } from '../src/index.js';

// A real Lucid Database (so a real `transaction`) over pgvector. Skipped without AGENT_PGVECTOR_URL.
const url = process.env.AGENT_PGVECTOR_URL;

describe.skipIf(url === undefined)('PgVectorStore.replaceDocument', () => {
  let db: Database;
  let store: PgVectorStore;

  beforeAll(async () => {
    db = new Database(
      { connection: 'pg', connections: { pg: { client: 'pg', connection: url as string } } },
      new Logger({ enabled: false }),
      new Emitter(undefined as never),
    );
    store = new PgVectorStore(db as never, { table: `replace_live_${process.pid}`, dimension: 2 });
    await store.ensureSchema();
  });
  afterAll(async () => {
    await db.rawQuery(`drop table if exists replace_live_${process.pid}`);
    await db.manager.closeAll();
  });

  it('swaps a shorter version with no tail', async () => {
    await store.upsert([
      { id: 'd#0', text: 'a', embedding: [1, 0] },
      { id: 'd#1', text: 'b', embedding: [1, 0] },
    ]);
    await store.replaceDocument('d', [{ id: 'd#0', text: 'new', embedding: [1, 0] }]);
    const hits = await store.search([1, 0], { topK: 5 });
    expect(hits.map((hit) => hit.text)).toEqual(['new']);
  });

  it('concurrent swaps leave exactly one version, without deadlocks', async () => {
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, writer) =>
          store.replaceDocument(
            'race',
            Array.from({ length: 30 - writer * 3 }, (_, chunk) => ({
              id: `race#${chunk}`,
              text: `writer-${writer}`,
              embedding: [0, 1],
            })),
          ),
        ),
      );
      const { rows } = await db.rawQuery(
        `select distinct text from replace_live_${process.pid} where id like 'race#%'`,
      );
      expect(rows).toHaveLength(1);
    }
    await store.remove('race');
  });

  it('a failed write rolls the removal back', async () => {
    await expect(
      store.replaceDocument('d', [{ id: 'd#0', text: 'bad', embedding: [1] }]),
    ).rejects.toThrow();
    const hits = await store.search([1, 0], { topK: 5 });
    expect(hits.map((hit) => hit.text)).toEqual(['new']);
  });
});
