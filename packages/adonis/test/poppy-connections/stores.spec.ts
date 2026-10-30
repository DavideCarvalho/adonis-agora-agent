import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryPoppyConnectionStore,
  LucidPoppyConnectionStore,
  type PoppyConnectionStore,
  redisPoppyConnectionStore,
  Sealer,
} from '../../src/poppy-connections/index.js';
import { makeStoreDb } from '../helpers/make-db.js';

/** A Map-backed slice of ioredis — enough for the connection store. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async get(k: string) {
      return kv.get(k) ?? null;
    },
    async set(k: string, v: string, ...args: (string | number)[]) {
      if (args.includes('NX') && kv.has(k)) return null;
      kv.set(k, v);
      return 'OK';
    },
    async del(...keys: string[]) {
      for (const k of keys) kv.delete(k);
      return keys.length;
    },
    async sadd(k: string, ...m: string[]) {
      const s = sets.get(k) ?? new Set();
      for (const x of m) s.add(x);
      sets.set(k, s);
      return m.length;
    },
    async srem(k: string, ...m: string[]) {
      for (const x of m) sets.get(k)?.delete(x);
      return m.length;
    },
    async smembers(k: string) {
      return [...(sets.get(k) ?? [])];
    },
  };
}

let db: Awaited<ReturnType<typeof makeStoreDb>> | null = null;
afterEach(async () => {
  await db?.manager.closeAll();
  db = null;
});

const kinds: [string, () => Promise<PoppyConnectionStore>][] = [
  ['memory', async () => new InMemoryPoppyConnectionStore()],
  ['redis', async () => redisPoppyConnectionStore(fakeRedis())],
  [
    'lucid',
    async () => {
      db = await makeStoreDb();
      return new LucidPoppyConnectionStore(db as never);
    },
  ],
];

describe.each(kinds)('poppy connection store (%s)', (_name, make) => {
  it('upserts connections per owner and keeps pending connects', async () => {
    const store = await make();
    const base = {
      owner: 'acct-1',
      issuer: 'https://shop.example/poppy',
      domain: 'shop.example',
      organization: 'Shop',
      scope: '',
      status: 'pending' as const,
      state: 'sealed',
      createdAt: 1,
      updatedAt: 1,
    };
    await store.saveConnection(base);
    await store.saveConnection({ ...base, status: 'active', scope: 'orders:read', updatedAt: 2 });
    await store.saveConnection({ ...base, owner: 'acct-2' });
    expect(await store.listConnections('acct-1')).toEqual([
      { ...base, status: 'active', scope: 'orders:read', updatedAt: 2 },
    ]);
    expect(await store.getConnection('acct-2', base.issuer)).toMatchObject({ status: 'pending' });
    await store.deleteConnection('acct-1', base.issuer);
    expect(await store.listConnections('acct-1')).toEqual([]);

    const pending = {
      id: 'p'.repeat(32),
      owner: 'acct-1',
      domain: 'shop.example',
      issuer: base.issuer,
      organization: 'Shop',
      scope: 'orders:read',
      actor: { id: 'u1', tenantRef: 'acct-1' },
      threadId: 't1',
      runId: 'r1',
      toolCallId: 'c1',
      flow: null,
      status: 'open' as const,
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
    };
    await store.createPending(pending);
    await store.createPending({ ...pending, scope: 'other' }); // idempotent
    await store.updatePending(pending.id, { status: 'connected', flow: 'x' });
    expect(await store.getPending(pending.id)).toEqual({
      ...pending,
      status: 'connected',
      flow: 'x',
    });
    expect(await store.getPending('nope')).toBeNull();
  });
});

describe('Sealer', () => {
  it('round-trips, and refuses a tampered value or another secret', () => {
    const sealer = new Sealer('s'.repeat(32));
    const sealed = sealer.seal({ refreshToken: 'rt_secret' });
    expect(sealed).not.toContain('rt_secret');
    expect(sealer.open(sealed)).toEqual({ refreshToken: 'rt_secret' });
    const parts = sealed.split('.');
    parts[3] = `${parts[3]!.slice(0, -2)}AA`;
    expect(() => sealer.open(parts.join('.'))).toThrow();
    expect(() => new Sealer('t'.repeat(32)).open(sealed)).toThrow();
    expect(() => new Sealer('short')).toThrow(/16/);
  });
});
