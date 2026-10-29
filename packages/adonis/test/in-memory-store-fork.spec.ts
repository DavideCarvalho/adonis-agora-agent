import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';

const actor: Actor = { id: 'user-1', roles: [], tenantRef: 'tenant-1' };

describe('InMemoryAgentStore.forkThread', () => {
  it('forks into another actor when asked, keeping the source and the default as they were', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor });
    const m1 = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'one' });
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'two' });

    const fork = await store.forkThread(thread.id, m1.id, { actorRef: 'reader-1' });
    expect(await store.getThreadActorRef(fork.id)).toBe('reader-1');
    expect((await store.getThread(fork.id))?.messages.map((m) => m.content)).toEqual(['one']);
    expect(await store.getThreadActorRef(thread.id)).toBe('user-1');

    const own = await store.forkThread(thread.id, m1.id);
    expect(await store.getThreadActorRef(own.id)).toBe('user-1');

    // Tenant: absent keeps the source's, `null` clears it, a value sets it.
    expect((await store.getThreadActionProposalScope(fork.id))?.tenantRef).toBe('tenant-1');
    const cleared = await store.forkThread(thread.id, m1.id, {
      actorRef: 'reader-2',
      tenantRef: null,
    });
    expect((await store.getThreadActionProposalScope(cleared.id))?.tenantRef ?? null).toBeNull();
    const moved = await store.forkThread(thread.id, m1.id, {
      actorRef: 'reader-3',
      tenantRef: 't-2',
    });
    expect((await store.getThreadActionProposalScope(moved.id))?.tenantRef).toBe('t-2');
  });
});
