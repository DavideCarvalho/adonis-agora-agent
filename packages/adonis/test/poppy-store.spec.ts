import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryPoppyStore,
  LucidPoppyStore,
  POPPY_TABLES,
  type PoppyConversationRecord,
  type PoppyRedisClient,
  type PoppyStore,
  redisPoppyStore,
} from '../src/poppy/index.js';
import { eventIdSeq } from '../src/poppy/store.js';
import { makeStoreDb } from './helpers/make-db.js';

function record(id: string): PoppyConversationRecord {
  const now = Date.now();
  return {
    id,
    clientId: 'https://pa.example',
    userId: 'u1',
    accountRef: null,
    agentName: 'support',
    threadId: null,
    parentId: null,
    openDirectId: null,
    status: 'idle',
    responder: 'agent',
    context: { locale: 'en-US' },
    activeRunId: null,
    turnSeq: 0,
    grant: { actor: { id: 'a1', roles: ['personal_agent'] }, scopes: [], signedIn: false },
    prunedSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** An in-memory stand-in for the Redis server: values with NX and PX. */
function fakeRedis(): PoppyRedisClient {
  const values = new Map<string, { value: string; until: number }>();
  const read = (key: string) => {
    const found = values.get(key);
    if (!found) return null;
    if (found.until <= Date.now()) {
      values.delete(key);
      return null;
    }
    return found.value;
  };
  return {
    get: async (key) => read(key),
    mget: async (...keys) => keys.map(read),
    async set(key, value, ...args) {
      const nx = args.includes('NX');
      const px = args.indexOf('PX');
      if (nx && read(key) !== null) return null;
      values.set(key, {
        value,
        until: px === -1 ? Number.POSITIVE_INFINITY : Date.now() + Number(args[px + 1]),
      });
      return 'OK';
    },
    async del(...keys) {
      for (const key of keys) values.delete(key);
      return keys.length;
    },
    async incr(key) {
      const next = (Number(read(key)) || 0) + 1;
      values.set(key, { value: String(next), until: Number.POSITIVE_INFINITY });
      return next;
    },
  };
}

let db: Database | null = null;

afterEach(async () => {
  await db?.manager.closeAll();
  db = null;
});

const backends: [string, () => Promise<PoppyStore>][] = [
  ['memory', async () => new InMemoryPoppyStore()],
  ['redis', async () => redisPoppyStore(fakeRedis())],
  [
    'lucid',
    async () => {
      db = await makeStoreDb();
      return new LucidPoppyStore(db as never);
    },
  ],
];

describe.each(backends)('PoppyStore contract (%s)', (_name, make) => {
  it('creates, reads and patches a conversation', async () => {
    const store = await make();
    await store.createConversation(record('cnv_1'));
    expect(await store.getConversation('cnv_nope')).toBeNull();
    await store.updateConversation('cnv_1', {
      status: 'working',
      accountRef: 'acct-1',
      context: { locale: 'pt-BR', user_available: true },
      grant: { actor: { id: 'acct-1' }, scopes: ['poppy:read'], signedIn: true },
      turnSeq: 3,
    });
    expect(await store.getConversation('cnv_1')).toMatchObject({
      status: 'working',
      accountRef: 'acct-1',
      context: { locale: 'pt-BR', user_available: true },
      grant: { scopes: ['poppy:read'], signedIn: true },
      turnSeq: 3,
      agentName: 'support',
    });
  });

  it('appends events in order, dedupes by key, finds and pages them', async () => {
    const store = await make();
    await store.createConversation(record('cnv_1'));
    const a = await store.appendEvent('cnv_1', {
      type: 'state',
      status: 'working',
      responder: 'agent',
    });
    const b = await store.appendEvent(
      'cnv_1',
      { type: 'user_requested', reason: 'x' },
      { key: 'once' },
    );
    const again = await store.appendEvent(
      'cnv_1',
      { type: 'user_requested', reason: 'y' },
      { key: 'once' },
    );
    expect(again.created).toBe(false);
    expect(again.event.event.id).toBe(b.event.event.id);
    expect([a.event.seq, b.event.seq]).toEqual([1, 2]);
    expect(eventIdSeq(b.event.event.id)).toBe(2);
    const all = await store.listEvents('cnv_1', 0, 10);
    expect(all.map((e) => e.event.type)).toEqual(['state', 'user_requested']);
    expect(await store.listEvents('cnv_1', 1, 10)).toHaveLength(1);
    expect(await store.findEventSeq('cnv_1', b.event.event.id)).toBe(2);
    expect(await store.findEventSeq('cnv_2', b.event.event.id)).toBeNull();
  });

  it('concurrent appends get distinct positions', async () => {
    const store = await make();
    await store.createConversation(record('cnv_1'));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.appendEvent('cnv_1', { type: 'user_requested', reason: String(i) }),
      ),
    );
    const seqs = (await store.listEvents('cnv_1', 0, 100)).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('prunes old events but keeps the last, and remembers how far', async () => {
    const store = await make();
    await store.createConversation(record('cnv_1'));
    for (let i = 0; i < 3; i++) {
      await store.appendEvent('cnv_1', { type: 'user_requested', reason: String(i) });
    }
    await store.pruneEvents('cnv_1', Date.now() + 1000);
    const left = await store.listEvents('cnv_1', 0, 10);
    expect(left.map((e) => e.seq)).toEqual([3]);
    expect((await store.getConversation('cnv_1'))?.prunedSeq).toBe(2);
    const next = await store.appendEvent('cnv_1', { type: 'user_requested', reason: 'n' });
    expect(next.event.seq).toBe(4);
  });

  it('claims a message id once, and releases it', async () => {
    const store = await make();
    const receipt = {
      fingerprint: 'f1',
      conversationId: 'cnv_1',
      response: { status: 201, body: { conversation_id: 'cnv_1' } },
    };
    expect(await store.claimMessage('owner', 'msg_1', receipt)).toEqual({ status: 'claimed' });
    expect(await store.claimMessage('owner', 'msg_1', { ...receipt, fingerprint: 'f2' })).toEqual({
      status: 'existing',
      ...receipt,
    });
    expect((await store.claimMessage('other', 'msg_1', receipt)).status).toBe('claimed');
    await store.releaseMessage('owner', 'msg_1');
    expect((await store.claimMessage('owner', 'msg_1', receipt)).status).toBe('claimed');
  });

  it('leases the reader to one holder at a time', async () => {
    const store = await make();
    await store.createConversation(record('cnv_1'));
    expect(await store.leaseReader('cnv_1', 'a', 60_000)).toBe(true);
    expect(await store.leaseReader('cnv_1', 'b', 60_000)).toBe(false);
    expect(await store.leaseReader('cnv_1', 'a', 60_000)).toBe(true);
    await store.releaseReader('cnv_1', 'a');
    expect(await store.leaseReader('cnv_1', 'b', 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.leaseReader('cnv_1', 'a', 60_000)).toBe(true);
  });
});

describe('LucidPoppyStore schema', () => {
  it('creates its tables on first use, idempotently', async () => {
    db = await makeStoreDb();
    const store = new LucidPoppyStore(db as never);
    await store.ready();
    await new LucidPoppyStore(db as never).ready();
    for (const table of Object.values(POPPY_TABLES)) {
      expect(await db.from(table).select('*')).toEqual([]);
    }
  });
});
