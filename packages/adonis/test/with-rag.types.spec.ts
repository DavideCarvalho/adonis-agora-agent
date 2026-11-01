import { compose } from '@adonisjs/core/helpers';
import { BaseModel } from '@adonisjs/lucid/orm';
import { describe, expect, it } from 'vitest';
import { MemoryVectorStore, withRag } from '../src/index.js';
import { FakeEmbeddingProvider } from '../src/testing/index.js';

/** Typing is the point here: `tsc -p tsconfig.tests.json` fails if `compose` loses the model's API. */
class Doc extends compose(
  BaseModel,
  withRag<{ id: string; body: string | null; projectId: string }>({
    store: () => new MemoryVectorStore(),
    embedder: () => new FakeEmbeddingProvider(),
    text: (row) => row.body,
    scope: ['projectId'],
  }),
) {
  static override table = 'docs';
  declare id: string;
  declare body: string | null;
  declare projectId: string;
}

async function typedUse() {
  const row = new Doc().merge({ id: '1', projectId: 'p1' });
  const found: Doc[] = await Doc.query().where('id', '1');
  const one: Doc | null = await Doc.find('1');
  const count: number = await row.ragIndex('text');
  await row.ragRemove();
  const hits = await Doc.ragSearch('q', { scope: { projectId: 'p1' } });
  return [found, one, count, hits[0]?.text];
}

describe('withRag typing', () => {
  it('keeps the Lucid API and adds the RAG one under compose', () => {
    expect(typeof typedUse).toBe('function');
    expect(typeof Doc.ragSearch).toBe('function');
  });
});
