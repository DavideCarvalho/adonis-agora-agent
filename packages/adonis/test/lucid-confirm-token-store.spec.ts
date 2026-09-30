import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_TABLES,
  defineConfirmedTool,
  hashConfirmToken,
  LucidConfirmTokenStore,
} from '../src/index.js';
import { createNoopEmitUi } from '../src/testing/index.js';
import { asStoreDb, makeMemoryDb, makeStoreDb } from './helpers/make-db.js';

const claim = (hash: string, expiresAt = Date.now() + 60_000) => ({
  hash,
  actorRef: 'u1',
  tool: 'refund_order',
  expiresAt,
});

describe('LucidConfirmTokenStore', () => {
  let db: Database;
  let store: LucidConfirmTokenStore;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidConfirmTokenStore(asStoreDb(db), { autoCreateTables: false });
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('gives a hash to the first claim only', async () => {
    expect(await store.claim(claim('h1'))).toBe(true);
    expect(await store.claim(claim('h1'))).toBe(false);
    expect(await store.claim(claim('h2'))).toBe(true);
  });

  it('stores the hash, the actor and the tool — and nothing else', async () => {
    await store.claim(claim('h1', 1_900_000_000_000));
    const rows = await db.from(AGENT_TABLES.confirmTokens).select('*');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'actor_ref',
      'created_at',
      'expires_at',
      'hash',
      'tool',
    ]);
    expect(rows[0]).toMatchObject({ hash: 'h1', actor_ref: 'u1', tool: 'refund_order' });
    expect(Number(rows[0].expires_at)).toBe(1_900_000_000_000);
  });

  it('lets exactly one of several concurrent claims through', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(claim('race'))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a released hash can be claimed again', async () => {
    await store.claim(claim('h1'));
    await store.release('h1');
    expect(await store.claim(claim('h1'))).toBe(true);
  });

  it('purges only what expired, and says how many', async () => {
    await store.claim(claim('old-1', 1_000));
    await store.claim(claim('old-2', 2_000));
    await store.claim(claim('live', 10_000));
    expect(await store.purgeExpired(5_000)).toBe(2);
    expect(await store.purgeExpired(5_000)).toBe(0);
    const rows = await db.from(AGENT_TABLES.confirmTokens).select('hash');
    expect(rows.map((row) => row.hash)).toEqual(['live']);
  });

  it('provisions its table on first use by default', async () => {
    const fresh = makeMemoryDb();
    try {
      const own = new LucidConfirmTokenStore(asStoreDb(fresh));
      expect(await own.claim(claim('h1'))).toBe(true);
      expect(await own.claim(claim('h1'))).toBe(false);
    } finally {
      await fresh.manager.closeAll();
    }
  });

  it('makes a confirmed tool single use, keyed by the hash of the token', async () => {
    let commits = 0;
    const tool = defineConfirmedTool<{ id: string }, { id: string }>(
      {
        name: 'archive',
        description: 'Archive.',
        input: z.object({ id: z.string() }),
        secret: 'a-secret',
        store,
      },
      {
        prepare: (args) => args,
        preview: () => ({ summary: 'Archive?' }),
        commit: () => {
          commits += 1;
          return { summary: 'Archived.' };
        },
      },
    );
    const ctx = {
      actor: { id: 'u1' },
      threadId: 't',
      runId: 'r',
      requestId: 'q',
      emitUi: createNoopEmitUi('q'),
    };
    const preview = (await tool.handler.execute({ id: 'a' }, ctx)) as { confirmToken: string };
    const confirm = { id: 'a', confirm: true, confirmToken: preview.confirmToken };
    await tool.handler.execute(confirm, ctx);
    await expect(tool.handler.execute(confirm, ctx)).rejects.toThrow(/already confirmed/);
    expect(commits).toBe(1);
    const rows = await db.from(AGENT_TABLES.confirmTokens).select('*');
    expect(rows.map((row) => row.hash)).toEqual([hashConfirmToken(preview.confirmToken)]);
    expect(JSON.stringify(rows)).not.toContain(preview.confirmToken);
  });
});
