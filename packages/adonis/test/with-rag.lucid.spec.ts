import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryVectorStore, withRag } from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';
import { makeMemoryDb } from './helpers/make-db.js';

// The real Lucid: hooks, `$trx` and commit handlers, on SQLite.
const store = new MemoryVectorStore();
const db = makeMemoryDb();

class Doc extends compose(
  BaseModel,
  withRag<{ id: number; body: string | null; projectId: string }>({
    store: () => store,
    embedder: () => new FakeEmbeddingProvider(),
    text: (row) => row.body,
    scope: ['projectId'],
  }),
) {
  static override table = 'lucid_docs';
  @column({ isPrimary: true }) declare id: number;
  @column() declare body: string | null;
  @column() declare projectId: string;
}

describe('withRag on the real Lucid', () => {
  beforeAll(async () => {
    BaseModel.$adapter = db.modelAdapter();
    await db.rawQuery(
      'create table lucid_docs (id integer primary key, body text, project_id text)',
    );
  });
  afterAll(() => db.manager.closeAll());

  async function indexed(id: number) {
    const row = await Doc.create({ id, body: 'gatos dormem', projectId: 'p' });
    await row.ragIndex();
    return row;
  }

  beforeEach(async () => {
    await db.rawQuery('delete from lucid_docs');
    for (const id of await store.listDocumentIds()) await store.remove(id);
  });

  it('removes the chunks on a plain delete', async () => {
    const row = await indexed(1);
    await row.delete();
    expect(await store.listDocumentIds()).toEqual([]);
  });

  it('a rollback keeps the row and its chunks', async () => {
    const row = await indexed(2);
    const trx = await db.transaction();
    row.useTransaction(trx);
    await row.delete();
    await trx.rollback();
    expect(await Doc.find(2)).not.toBeNull();
    expect(await store.listDocumentIds()).toEqual(['lucid_docs:2']);
  });

  it('a commit removes the chunks, and not before it', async () => {
    const row = await indexed(3);
    const trx = await db.transaction();
    row.useTransaction(trx);
    await row.delete();
    expect(await store.listDocumentIds()).toEqual(['lucid_docs:3']);
    await trx.commit();
    expect(await store.listDocumentIds()).toEqual([]);
  });

  it('ragSearch filters by model and scope', async () => {
    await indexed(4);
    const hits = await Doc.ragSearch('gatos dormem', { scope: { projectId: 'p' } });
    expect(hits.map((hit) => hit.id)).toEqual(['lucid_docs:4#0']);
  });
});
