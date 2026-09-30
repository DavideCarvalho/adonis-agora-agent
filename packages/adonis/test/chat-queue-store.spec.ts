import { describe, expect, it } from 'vitest';
import { isChatQueueStore, LucidAgentStore } from '../src/index.js';
import { CHAT_QUEUE_STORE_CONTRACT, InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor = { id: 'contract-actor' };

describe('InMemoryAgentStore — the chat queue contract', () => {
  it('is a ChatQueueStore', () => {
    expect(isChatQueueStore(new InMemoryAgentStore())).toBe(true);
  });

  for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const store = new InMemoryAgentStore();
      const thread = await store.createThread({ actor, persona: 'default' });
      await contractCase.run({ store, threadId: thread.id });
    });
  }
});

describe('LucidAgentStore — the chat queue contract', () => {
  it('is a ChatQueueStore', async () => {
    const db = await makeStoreDb();
    expect(isChatQueueStore(new LucidAgentStore(asStoreDb(db)))).toBe(true);
    await db.manager.closeAll();
  });

  for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const db = await makeStoreDb();
      try {
        const store = new LucidAgentStore(asStoreDb(db));
        const thread = await store.createThread({ actor, persona: 'default' });
        await contractCase.run({ store, threadId: thread.id });
      } finally {
        await db.manager.closeAll();
      }
    });
  }

  it("drops a thread's queue with the thread row", async () => {
    const db = await makeStoreDb();
    try {
      const store = new LucidAgentStore(asStoreDb(db));
      const thread = await store.createThread({ actor, persona: 'default' });
      await store.enqueueMessage({ threadId: thread.id, actor, content: 'a' });
      expect(await store.listQueue(thread.id)).toHaveLength(1);
      expect(await store.clearQueue(thread.id)).toBe(1);
    } finally {
      await db.manager.closeAll();
    }
  });
});
