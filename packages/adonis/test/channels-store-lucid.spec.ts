import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lucidChannelStore } from '../src/channels/index.js';
import { AGENT_TABLES } from '../src/index.js';
import { asStoreDb, makeMemoryDb, makeStoreDb } from './helpers/make-db.js';

describe('lucidChannelStore', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeStoreDb();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('claims a key once — the primary key is the lock', async () => {
    const store = lucidChannelStore(asStoreDb(db), { autoCreateTables: false });
    expect(await store.claim('whatsapp:m1', 60_000)).toBe(true);
    expect(await store.claim('whatsapp:m1', 60_000)).toBe(false);
    expect(await store.claim('whatsapp:m2', 60_000)).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.claim('whatsapp:race', 60_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('frees an expired key, and purges expired rows', async () => {
    const store = lucidChannelStore(asStoreDb(db), { autoCreateTables: false, purgeEveryMs: 0 });
    expect(await store.claim('telegram:1', 1)).toBe(true);
    expect(await store.claim('telegram:old', 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.claim('telegram:1', 60_000)).toBe(true);
    const keys = (await db.from(AGENT_TABLES.channelState).select('key')).map((row) => row.key);
    expect(keys).toEqual(['telegram:1']);
  });

  it('holds values with a TTL, replaces and deletes them', async () => {
    const store = lucidChannelStore(asStoreDb(db), { autoCreateTables: false });
    expect(await store.get('q')).toBeNull();
    await store.set('q', '{"index":0}', 60_000);
    expect(await store.get('q')).toBe('{"index":0}');
    await store.set('q', '{"index":1}', 60_000);
    expect(await store.get('q')).toBe('{"index":1}');
    await store.set('gone', 'x', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.get('gone')).toBeNull();
    await store.delete('q');
    expect(await store.get('q')).toBeNull();
  });

  it('stores a key longer than the column by its hash', async () => {
    const store = lucidChannelStore(asStoreDb(db), { autoCreateTables: false });
    const long = `whatsapp:${'x'.repeat(400)}`;
    expect(await store.claim(long, 60_000)).toBe(true);
    expect(await store.claim(long, 60_000)).toBe(false);
  });
});

describe('lucidChannelStore table provisioning', () => {
  it('creates its own table (under any name) on first use', async () => {
    const db = makeMemoryDb();
    try {
      const store = lucidChannelStore(asStoreDb(db), { table: 'my_channel_state' });
      expect(await store.claim('k', 60_000)).toBe(true);
      expect(await db.from('my_channel_state').select('key')).toEqual([{ key: 'k' }]);
    } finally {
      await db.manager.closeAll();
    }
  });
});
