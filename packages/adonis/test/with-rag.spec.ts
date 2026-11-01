import { describe, expect, it } from 'vitest';
import { MemoryVectorStore, RagScopeRequiredError, withRag } from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

/** The bits of a Lucid model the mixin touches. The real one is exercised by the host apps. */
class FakeBase {
  static table = 'documents';
  static hooks: Array<(row: any) => Promise<void>> = [];
  static boot() {}
  static after(_event: string, hook: (row: any) => Promise<void>) {
    FakeBase.hooks.push(hook);
  }
  $primaryKeyValue = '';
  constructor(fields: Record<string, unknown> = {}) {
    Object.assign(this, fields);
    this.$primaryKeyValue = String(fields.id);
  }
}

function setup(extra: Record<string, unknown> = {}) {
  const store = new MemoryVectorStore();
  const embedder = new FakeEmbeddingProvider();
  const mixin = withRag<any>({
    store: () => store,
    embedder: () => embedder,
    text: (row) => row.body,
    source: (row) => row.title,
    scope: ['projectId'],
    ...extra,
  });
  const Doc = mixin(FakeBase as never) as any;
  return { store, embedder, Doc };
}

describe('withRag', () => {
  it('indexes with the scope in the metadata and finds it inside the scope', async () => {
    const { Doc } = setup();
    await new Doc({ id: '1', body: 'gatos dormem', title: 'A', projectId: 'p1' }).ragIndex();

    const hits = await Doc.ragSearch('gatos dormem', { scope: { projectId: 'p1' } });

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('A');
    expect(hits[0].metadata.projectId).toBe('p1');
  });

  it('two models sharing a store do not see each other, with the same scope', async () => {
    const { store, embedder } = setup();
    const mixin = withRag<any>({
      store: () => store,
      embedder: () => embedder,
      text: (row) => row.body,
      scope: ['projectId'],
    });
    class A extends (mixin(FakeBase as never) as any) {
      static table = 'a';
    }
    class B extends (mixin(FakeBase as never) as any) {
      static table = 'b';
    }
    await new (A as any)({ id: '1', body: 'gatos', projectId: 'p' }).ragIndex();
    await new (B as any)({ id: '1', body: 'gatos', projectId: 'p' }).ragIndex();

    const hits = await (A as any).ragSearch('gatos', { scope: { projectId: 'p' } });

    expect(hits.map((hit: { id: string }) => hit.id)).toEqual(['a:1#0']);
  });

  it('removes chunks after the commit when the row was deleted inside a transaction', async () => {
    FakeBase.hooks = [];
    const { Doc, store } = setup();
    Doc.boot();
    const row = new Doc({ id: '1', body: 'gatos', projectId: 'p1' });
    await row.ragIndex();
    const handlers: Array<() => Promise<void>> = [];
    row.$trx = { after: (_event: string, handler: () => Promise<void>) => handlers.push(handler) };

    await Promise.all(FakeBase.hooks.map((hook) => hook(row)));
    expect(await store.listDocumentIds()).toEqual(['documents:1']);

    await handlers[0]?.();
    expect(await store.listDocumentIds()).toEqual([]);
  });

  it('never returns another scope, even when the filter asks for it', async () => {
    const { Doc } = setup();
    await new Doc({ id: '1', body: 'gatos dormem', projectId: 'p1' }).ragIndex();

    const hits = await Doc.ragSearch('gatos dormem', {
      scope: { projectId: 'p2' },
      filter: { projectId: 'p1' },
    });

    expect(hits).toEqual([]);
  });

  it('refuses to search without the scope, before spending on an embedding', async () => {
    const { Doc, embedder } = setup();
    let calls = 0;
    const embed = embedder.embed.bind(embedder);
    embedder.embed = (texts: string[]) => {
      calls += 1;
      return embed(texts);
    };

    await expect(Doc.ragSearch('x')).rejects.toBeInstanceOf(RagScopeRequiredError);
    await expect(Doc.ragSearch('x', { scope: { projectId: null } })).rejects.toBeInstanceOf(
      RagScopeRequiredError,
    );
    expect(calls).toBe(0);
  });

  it('replaces the chunks on reindex, leaving no tail from a longer version', async () => {
    const { Doc, store } = setup({ chunk: { chunkSize: 20, overlap: 0 } });
    const row = new Doc({ id: '1', body: 'palavra '.repeat(20), projectId: 'p1' });
    const first = await row.ragIndex();
    expect(first).toBeGreaterThan(1);

    expect(await row.ragIndex('curto')).toBe(1);

    expect(await store.listDocumentIds()).toEqual(['documents:1']);
    const hits = await Doc.ragSearch('curto', { scope: { projectId: 'p1' }, topK: 50 });
    expect(hits).toHaveLength(1);
  });

  it('keeps the old chunks when the embedder fails', async () => {
    const { Doc, embedder, store } = setup();
    const row = new Doc({ id: '1', body: 'gatos dormem', projectId: 'p1' });
    await row.ragIndex();
    embedder.embed = async () => {
      throw new Error('no key');
    };

    await expect(row.ragIndex('novo texto')).rejects.toThrow('no key');

    expect(await store.listDocumentIds()).toEqual(['documents:1']);
  });

  it('empty text removes the chunks', async () => {
    const { Doc, store } = setup();
    const row = new Doc({ id: '1', body: 'gatos', projectId: 'p1' });
    await row.ragIndex();

    expect(await row.ragIndex(null)).toBe(0);

    expect(await store.listDocumentIds()).toEqual([]);
  });

  it('applies maxChunks and chunkMetadata', async () => {
    const { Doc } = setup({
      maxChunks: 2,
      chunk: { chunkSize: 20, overlap: 0 },
      chunkMetadata: (chunk: string) => ({ size: chunk.length }),
    });
    const row = new Doc({ id: '1', body: 'palavra '.repeat(30), projectId: 'p1' });

    expect(await row.ragIndex()).toBe(2);

    const [hit] = await Doc.ragSearch('palavra', { scope: { projectId: 'p1' } });
    expect(hit.metadata.size).toBeGreaterThan(0);
  });

  it('refuses to index a row without its scope, instead of orphaning the chunks', async () => {
    const { Doc, store } = setup();

    await expect(new Doc({ id: '1', body: 'gatos' }).ragIndex()).rejects.toBeInstanceOf(
      RagScopeRequiredError,
    );

    expect(await store.listDocumentIds()).toEqual([]);
  });

  it('chunkMetadata and metadata cannot retag a chunk to another scope', async () => {
    const { Doc } = setup({
      metadata: () => ({ projectId: 'p2' }),
      chunkMetadata: () => ({ projectId: 'p2' }),
    });
    await new Doc({ id: '1', body: 'gatos', projectId: 'p1' }).ragIndex();

    expect(await Doc.ragSearch('gatos', { scope: { projectId: 'p2' } })).toEqual([]);
    expect(await Doc.ragSearch('gatos', { scope: { projectId: 'p1' } })).toHaveLength(1);
  });

  it('no chunks left after the cut still removes the old ones', async () => {
    const { Doc, store } = setup({ maxChunks: 0 });
    const row = new Doc({ id: '1', body: 'gatos', projectId: 'p1' });
    await store.upsert([{ id: 'documents:1#0', text: 'velho', embedding: [1] }]);

    expect(await row.ragIndex()).toBe(0);

    expect(await store.listDocumentIds()).toEqual([]);
  });
});
