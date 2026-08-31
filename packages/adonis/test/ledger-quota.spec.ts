import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, QuotaStore } from '../src/index.js';
import { LedgerQuotaStore, LucidAgentStore, utcDay } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

describe('LedgerQuotaStore (in-memory ledger)', () => {
  it('enforces the limit off the persisted ledger, and treats bump as a no-op', async () => {
    const store = new InMemoryAgentStore();
    const day = utcDay();
    const thread = await store.createThread({ actor, persona: 'default' });
    // Typed as the SPI: `bump` is exercised the way the agent loop calls it (actorRef, day, tokens).
    // `LedgerQuotaStore.bump()` declares zero params because it is a deliberate no-op.
    const quota: QuotaStore = new LedgerQuotaStore(store, 100);

    expect(await quota.check('u1', day)).toEqual({
      usedTokens: 0,
      limitTokens: 100,
      withinLimit: true,
    });

    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 60, outputTokens: 50 },
    });
    // bump must not double-count — recordUsage already wrote the tokens the ledger sums.
    await quota.bump('u1', day, 999);

    const after = await quota.check('u1', day);
    expect(after.usedTokens).toBe(110);
    expect(after.withinLimit).toBe(false);
  });

  it('isolates accounting by actor', async () => {
    const store = new InMemoryAgentStore();
    const day = utcDay();
    const thread = await store.createThread({ actor, persona: 'default' });
    const quota = new LedgerQuotaStore(store, 1_000);
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    expect((await quota.check('u1', day)).usedTokens).toBe(200);
    expect((await quota.check('u2', day)).usedTokens).toBe(0);
  });
});

describe('LedgerQuotaStore (Lucid ledger)', () => {
  let db: Database;
  let store: LucidAgentStore;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it("reads today's tokens from the append-only token-usage table (cache tokens never re-added)", async () => {
    const day = utcDay();
    const thread = await store.createThread({ actor, persona: 'default' });
    const quota = new LedgerQuotaStore(store, 150);

    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 90 },
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const state = await quota.check('u1', day);
    expect(state.usedTokens).toBe(155);
    expect(state.withinLimit).toBe(false);
    // A different day is empty and within limit.
    expect(await quota.check('u1', '2000-01-01')).toEqual({
      usedTokens: 0,
      limitTokens: 150,
      withinLimit: true,
    });
  });
});
