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
    /** One page per call; MATCH `prefix*` only, which is all the store asks. */
    async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...kv.keys()].filter((k) => k.startsWith(prefix))];
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
  it('keeps two long issuers apart that differ only in their last character', async () => {
    // On MySQL the key is a hash of the issuer (the full one is past InnoDB's key limit): exact,
    // where a prefix index would have folded these two into one row.
    const store = await make();
    const prefix = `https://shop.example/${'p'.repeat(1000)}`;
    const record = {
      owner: 'acct-1',
      domain: 'shop.example',
      organization: 'Shop',
      scope: '',
      status: 'active' as const,
      state: 'sealed',
      createdAt: 1,
      updatedAt: 1,
    };
    await store.saveConnection({ ...record, issuer: `${prefix}a` });
    await store.saveConnection({ ...record, issuer: `${prefix}b`, organization: 'Other' });
    await store.saveConnection({ ...record, issuer: `${prefix}a`, scope: 'orders:read' });
    expect((await store.listConnections('acct-1')).map((c) => c.issuer).sort()).toEqual([
      `${prefix}a`,
      `${prefix}b`,
    ]);
    expect(await store.getConnection('acct-1', `${prefix}a`)).toMatchObject({
      scope: 'orders:read',
    });
    expect(await store.getConnection('acct-1', `${prefix}b`)).toMatchObject({
      organization: 'Other',
    });
    await store.deleteConnection('acct-1', `${prefix}a`);
    expect((await store.listConnections('acct-1')).map((c) => c.issuer)).toEqual([`${prefix}b`]);
  });

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

  it('lists its sealed values and swaps one only while it is unchanged', async () => {
    const store = await make();
    const connection = {
      owner: 'acct-1',
      issuer: 'https://shop.example/poppy',
      domain: 'shop.example',
      organization: 'Shop',
      scope: '',
      status: 'active' as const,
      state: 'sealed-state',
      createdAt: 1,
      updatedAt: 1,
    };
    await store.saveConnection(connection);
    const pending = {
      id: 'q'.repeat(32),
      owner: 'acct-1',
      domain: 'shop.example',
      issuer: connection.issuer,
      organization: 'Shop',
      scope: '',
      actor: null,
      threadId: null,
      runId: null,
      toolCallId: null,
      flow: 'sealed-flow',
      status: 'open' as const,
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
    };
    await store.createPending(pending);
    await store.createPending({ ...pending, id: 'r'.repeat(32), flow: null });
    const sealed = await store.listSealed?.();
    expect(sealed).toEqual(
      expect.arrayContaining([
        {
          ref: { table: 'connection', owner: 'acct-1', issuer: connection.issuer },
          value: 'sealed-state',
        },
        { ref: { table: 'pending', id: pending.id }, value: 'sealed-flow' },
      ]),
    );
    expect(sealed).toHaveLength(2);
    const ref = { table: 'connection' as const, owner: 'acct-1', issuer: connection.issuer };
    expect(await store.replaceSealed?.(ref, 'stale', 'new')).toBe(false);
    expect(await store.replaceSealed?.(ref, 'sealed-state', 'new')).toBe(true);
    expect(await store.getConnection('acct-1', connection.issuer)).toMatchObject({ state: 'new' });
    const pendingRef = { table: 'pending' as const, id: pending.id };
    expect(await store.replaceSealed?.(pendingRef, 'sealed-flow', 'new-flow')).toBe(true);
    expect(await store.getPending(pending.id)).toMatchObject({ flow: 'new-flow' });
  });
});

describe('Sealer', () => {
  it('round-trips, and refuses a tampered value or another secret', async () => {
    const sealer = new Sealer('s'.repeat(32));
    const sealed = await sealer.seal({ refreshToken: 'rt_secret' }, 'row:1');
    expect(sealed).not.toContain('rt_secret');
    expect(await sealer.open(sealed, 'row:1')).toEqual({ refreshToken: 'rt_secret' });
    // Flip one bit of the DECODED ciphertext: a base64 character swap can decode to the same
    // bytes (the old flaky `slice(0, -2) + 'AA'`), a flipped bit never does.
    // `agora:v1:<id>.v1:<ciphertext>.<iv>.<tag>`: flip a bit of the decoded tag.
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[0] = tag[0]! ^ 0x01;
    parts[3] = tag.toString('base64url');
    await expect(sealer.open(parts.join('.'), 'row:1')).rejects.toThrow(/did not open/);
    await expect(sealer.open(sealed, 'row:2')).rejects.toThrow(/did not open/);
    await expect(new Sealer('t'.repeat(32)).open(sealed, 'row:1')).rejects.toThrow();
    expect(() => new Sealer('short')).toThrow(/16/);
  });
});
