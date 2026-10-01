import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentStore, LucidAgentStore } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const IMAGE = { url: 'https://example.test/a.png', contentType: 'image/png', name: 'a.png' };

/**
 * `referencedMediaIds`: of some media ids, which are still carried by a message that exists in one
 * of the actor's own threads. Re-derived from the surviving message rows on every call rather than
 * read off a flag written at send time — `truncateFrom` (what regenerating a turn does) makes a
 * reference disappear, and a one-way flag would then grant access to a file nothing points at.
 *
 * After `nestjs-agent`'s `core/src/attachment-references.spec.ts`, run against both stores.
 */
let db: Database | undefined;
afterEach(async () => {
  await db?.manager.closeAll();
  db = undefined;
});

const backends: Array<[string, () => Promise<AgentStore>]> = [
  ['InMemoryAgentStore', async () => new InMemoryAgentStore()],
  [
    'LucidAgentStore',
    async () => {
      db = await makeStoreDb();
      return new LucidAgentStore(asStoreDb(db));
    },
  ],
];

describe.each(backends)('%s — which media a live message still references', (_name, make) => {
  async function referenced(store: AgentStore, actorRef: string, ids: string[]) {
    if (store.referencedMediaIds === undefined) throw new Error('store lacks referencedMediaIds');
    return store.referencedMediaIds(actorRef, ids);
  }

  it('answers with the referenced subset and ignores ids nothing carries', async () => {
    const store = await make();
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look at this',
      attachments: [{ mediaId: 'sent', ...IMAGE }],
    });
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'nice' });

    expect(await referenced(store, 'u1', ['sent', 'never-sent'])).toEqual(['sent']);
    expect(await referenced(store, 'u1', [])).toEqual([]);
    expect(await referenced(store, 'nobody', ['sent'])).toEqual([]);
  });

  it('re-derives after truncateFrom, so a regenerated turn stops granting the file', async () => {
    const store = await make();
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look at this',
      attachments: [{ mediaId: 'sent', ...IMAGE }],
    });
    expect(await referenced(store, 'u1', ['sent'])).toEqual(['sent']);

    await store.truncateFrom(thread.id, message.id);

    expect(await referenced(store, 'u1', ['sent'])).toEqual([]);
  });

  it('never reports another actor’s reference, so an id that is not yours reads like one that does not exist', async () => {
    const store = await make();
    const mine = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    const theirs = await store.createThread({ actor: { id: 'u2' }, persona: 'default' });
    await store.appendMessage({
      threadId: mine.id,
      role: 'user',
      content: 'mine',
      attachments: [{ mediaId: 'mine', ...IMAGE }],
    });
    await store.appendMessage({
      threadId: theirs.id,
      role: 'user',
      content: 'theirs',
      attachments: [{ mediaId: 'theirs', ...IMAGE }],
    });

    expect(await referenced(store, 'u1', ['mine', 'theirs', 'imaginary'])).toEqual(['mine']);
  });

  it('returns each id once, in the order asked, however many messages carry it', async () => {
    const store = await make();
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    for (const content of ['first', 'second']) {
      await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content,
        attachments: [{ mediaId: 'b', ...IMAGE }],
      });
    }
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'third',
      attachments: [{ mediaId: 'a', ...IMAGE }],
    });

    expect(await referenced(store, 'u1', ['b', 'a', 'b'])).toEqual(['b', 'a']);
  });
});
