import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/index.js';
import { LucidAgentStore } from '../src/stores/lucid.js';
import { LucidGovernanceQueries } from '../src/stores/lucid-governance-queries.js';
import { LucidPricingStore } from '../src/stores/lucid-pricing.js';
import { asStoreDb, makeMemoryDb } from './helpers/make-db.js';

const actor: Actor = { id: 'user-1', roles: ['ADMIN'] };

// Each test gets a FRESH empty db (no tables) so we prove the store provisions them itself. A fresh
// db object is also a fresh memo key, so tests don't contaminate each other.
describe('autoCreateTables defaults to true (the lib manages its own schema)', () => {
  let db: Database;
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('the agent store auto-creates on first use with no options', async () => {
    db = makeMemoryDb();
    const store = new LucidAgentStore(asStoreDb(db));
    const thread = await store.createThread({ actor, persona: 'default', title: 'x' });
    expect(thread.id).toBeTruthy();
  });

  it('autoCreateTables:false opts out — a query hits a missing table', async () => {
    db = makeMemoryDb();
    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    await expect(store.createThread({ actor, persona: 'default' })).rejects.toThrow();
  });

  it('the PRICING store provisions the schema before any agent run (the seed gap)', async () => {
    db = makeMemoryDb();
    // Only the pricing store touches this fresh db — no agent store ran first.
    const pricing = new LucidPricingStore(asStoreDb(db));
    await pricing.upsertModelPrice({
      modelId: 'gpt-4o-mini',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const prices = await pricing.listCurrentPrices();
    expect(prices.map((p) => p.modelId)).toEqual(['gpt-4o-mini']);
  });

  it('pricing autoCreateTables:false opts out — the write hits a missing table', async () => {
    db = makeMemoryDb();
    const pricing = new LucidPricingStore(asStoreDb(db), { autoCreateTables: false });
    await expect(
      pricing.upsertModelPrice({ modelId: 'm', inputPricePer1m: 1, outputPricePer1m: 1 }),
    ).rejects.toThrow();
  });

  it('the GOVERNANCE read-model provisions the schema on a fresh deploy (the dashboard gap)', async () => {
    db = makeMemoryDb();
    // Only governance touches this fresh db — dashboard opened before the first agent run.
    const gov = new LucidGovernanceQueries(asStoreDb(db));
    const rows = await gov.spendByModel({ fromDay: '2026-01-01', toDay: '2026-12-31' });
    expect(rows).toEqual([]);
  });

  it('governance autoCreateTables:false opts out — the read hits a missing table', async () => {
    db = makeMemoryDb();
    const gov = new LucidGovernanceQueries(asStoreDb(db), undefined, { autoCreateTables: false });
    await expect(
      gov.spendByModel({ fromDay: '2026-01-01', toDay: '2026-12-31' }),
    ).rejects.toThrow();
  });

  it('the three stores share the memo — provisioning runs once per db client', async () => {
    db = makeMemoryDb();
    let ddlCount = 0;
    const real = db.rawQuery.bind(db);
    // Count CREATE TABLE statements issued against this db across all three stores.
    (db as unknown as { rawQuery: (sql: string, b?: unknown[]) => Promise<unknown> }).rawQuery = (
      sql: string,
      bindings?: unknown[],
    ) => {
      if (/CREATE TABLE/i.test(sql)) ddlCount += 1;
      return real(sql, bindings);
    };
    const store = new LucidAgentStore(asStoreDb(db));
    const pricing = new LucidPricingStore(asStoreDb(db));
    const gov = new LucidGovernanceQueries(asStoreDb(db));
    await store.createThread({ actor, persona: 'default' });
    await pricing.listCurrentPrices();
    await gov.spendByModel({ fromDay: '2026-01-01', toDay: '2026-12-31' });
    // Six tables, created exactly once — not eighteen (6 × 3 stores).
    expect(ddlCount).toBe(6);
  });
});
