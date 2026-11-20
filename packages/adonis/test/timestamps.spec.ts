import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureA2aTables, InMemoryA2aStore, LucidA2aStore } from '../src/a2a/index.js';
import {
  createAgentTables,
  LucidAgentStore,
  LucidGovernanceQueries,
  LucidPricingStore,
  toModelPriceDto,
} from '../src/index.js';
import { toDate, toIsoOrNull } from '../src/stores/timestamps.js';
import {
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  InMemoryPricingStore,
} from '../src/testing/index.js';
import { asStoreDb, makeMemoryDb, makeStoreDb } from './helpers/make-db.js';

/**
 * createdAt / updatedAt on every mutable row the agent owns: model prices, A2A contexts and the
 * threads feed of the governance read-model. Append-only rows (messages, tool calls, usage, runs,
 * stream frames…) keep their single `created_at` / `started_at`.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('toDate / toIsoOrNull', () => {
  it('normalises epoch ms, numeric strings, ISO strings, Dates and Luxon-like values', () => {
    const at = Date.UTC(2026, 10, 20, 12, 0, 0);
    const iso = new Date(at).toISOString();
    expect(toDate(at)?.toISOString()).toBe(iso);
    expect(toDate(BigInt(at))?.toISOString()).toBe(iso);
    expect(toDate(String(at))?.toISOString()).toBe(iso);
    expect(toDate(iso)?.toISOString()).toBe(iso);
    expect(toDate(new Date(at))?.toISOString()).toBe(iso);
    expect(toDate({ toJSDate: () => new Date(at) })?.toISOString()).toBe(iso);
    expect(toIsoOrNull(at)).toBe(iso);
  });

  it('is undefined / null for an unknown time', () => {
    for (const value of [null, undefined, '', 'not a date', {}]) {
      expect(toDate(value)).toBeUndefined();
      expect(toIsoOrNull(value)).toBeNull();
    }
  });
});

describe('model price timestamps', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeStoreDb();
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('LucidPricingStore sets both on insert and moves updated_at (only) when a row is retired', async () => {
    const store = new LucidPricingStore(asStoreDb(db));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });

    const [first] = await store.listCurrentPrices();
    expect(first?.createdAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));
    expect(first?.updatedAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));

    vi.setSystemTime(new Date('2026-11-20T11:00:00.000Z'));
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 5, outputPricePer1m: 20 });

    const [current] = await store.listCurrentPrices();
    expect(current?.createdAt).toEqual(new Date('2026-11-20T11:00:00.000Z'));
    expect(current?.updatedAt).toEqual(new Date('2026-11-20T11:00:00.000Z'));

    const retired = await db
      .from('agent_model_pricing')
      .where('model_id', 'm')
      .where('is_current', 0)
      .first();
    expect(Number(retired.created_at)).toBe(Date.parse('2026-11-20T10:00:00.000Z'));
    expect(Number(retired.updated_at)).toBe(Date.parse('2026-11-20T11:00:00.000Z'));
  });

  it('reads a row written before the columns existed with neither, and the DTO sends null', async () => {
    const store = new LucidPricingStore(asStoreDb(db));
    await db.table('agent_model_pricing').insert({
      id: 'old',
      model_id: 'legacy',
      input_price_per_1m: 1,
      output_price_per_1m: 2,
      effective_from: Date.parse('2026-01-01T00:00:00.000Z'),
      is_current: 1,
    });
    const [legacy] = await store.listCurrentPrices();
    expect(legacy?.createdAt).toBeUndefined();
    expect(legacy?.updatedAt).toBeUndefined();
    expect(toModelPriceDto(legacy as NonNullable<typeof legacy>)).toEqual({
      modelId: 'legacy',
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      createdAt: null,
      updatedAt: null,
    });
  });

  it('the DTO carries ISO strings', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    const [price] = await store.listCurrentPrices();
    const dto = toModelPriceDto(price as NonNullable<typeof price>);
    expect(dto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(dto.updatedAt).toBe(dto.createdAt);
  });
});

describe('model price timestamp columns on an existing database', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  /** `agent_model_pricing` as a database provisioned before the timestamps still has it. */
  async function legacyPricingTable(): Promise<void> {
    await db.connection('sqlite').rawQuery(
      `CREATE TABLE "agent_model_pricing" ("id" VARCHAR(255) PRIMARY KEY NOT NULL,
       "model_id" VARCHAR(255) NOT NULL, "input_price_per_1m" DOUBLE PRECISION NOT NULL,
       "output_price_per_1m" DOUBLE PRECISION NOT NULL, "cache_write_price_per_1m" DOUBLE PRECISION NULL,
       "cache_read_price_per_1m" DOUBLE PRECISION NULL, "effective_from" BIGINT NOT NULL,
       "is_current" INTEGER NOT NULL)`,
    );
  }

  it('createAgentTables adds them NULL-able, leaving old rows without a value', async () => {
    await legacyPricingTable();
    await db.table('agent_model_pricing').insert({
      id: 'old',
      model_id: 'legacy',
      input_price_per_1m: 1,
      output_price_per_1m: 2,
      effective_from: 1,
      is_current: 1,
    });

    const repairs = await createAgentTables(asStoreDb(db));

    expect(repairs).toEqual(
      expect.arrayContaining(['agent_model_pricing.created_at', 'agent_model_pricing.updated_at']),
    );
    const row = await db.from('agent_model_pricing').where('id', 'old').first();
    expect(row.created_at).toBeNull();
    expect(row.updated_at).toBeNull();
    // A second run is a no-op.
    expect(await createAgentTables(asStoreDb(db))).toEqual([]);
  });

  it('with autoCreateTables off, a store on the old table still writes prices (without timestamps)', async () => {
    await legacyPricingTable();
    const store = new LucidPricingStore(asStoreDb(db), { autoCreateTables: false });
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 4, outputPricePer1m: 16 });
    const prices = await store.listCurrentPrices();
    expect(prices).toHaveLength(1);
    expect(prices[0]?.createdAt).toBeUndefined();
  });
});

describe('A2A context timestamps', () => {
  const context = {
    id: 'ctx-1',
    brand: 'acme',
    agentIssuer: 'https://issuer.example',
    agentSub: 'sub-1',
    accountRef: null,
  };

  it('InMemoryA2aStore sets both on create and moves updatedAt (only) on bind', async () => {
    const store = new InMemoryA2aStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    await store.createContext(context);
    vi.setSystemTime(new Date('2026-11-20T10:05:00.000Z'));
    expect(await store.bindAccount('ctx-1', 'acct-1')).toBe(true);
    const read = await store.getContext('ctx-1');
    expect(read?.createdAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));
    expect(read?.updatedAt).toEqual(new Date('2026-11-20T10:05:00.000Z'));
  });

  describe('LucidA2aStore', () => {
    let db: Database;

    beforeEach(() => {
      db = makeMemoryDb();
    });

    afterEach(async () => {
      await db?.manager.closeAll();
    });

    it('sets both on create and moves updated_at (only) on bind', async () => {
      await ensureA2aTables(asStoreDb(db));
      const store = new LucidA2aStore(asStoreDb(db));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
      await store.createContext(context);
      const created = await store.getContext('ctx-1');
      expect(created?.createdAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));
      expect(created?.updatedAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));

      vi.setSystemTime(new Date('2026-11-20T10:05:00.000Z'));
      expect(await store.bindAccount('ctx-1', 'acct-1')).toBe(true);
      const bound = await store.getContext('ctx-1');
      expect(bound?.createdAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));
      expect(bound?.updatedAt).toEqual(new Date('2026-11-20T10:05:00.000Z'));
    });

    it('ensureA2aTables adds updated_at to a context table that predates it', async () => {
      await db.connection('sqlite').rawQuery(
        `CREATE TABLE "agent_a2a_context" ("id" VARCHAR(255) PRIMARY KEY NOT NULL,
         "brand" VARCHAR(255) NOT NULL, "agent_issuer" VARCHAR(2048) NOT NULL,
         "agent_sub" VARCHAR(255) NOT NULL, "account_ref" VARCHAR(255) NULL,
         "created_at" BIGINT NOT NULL)`,
      );
      await db.table('agent_a2a_context').insert({
        id: 'old',
        brand: 'acme',
        agent_issuer: 'https://issuer.example',
        agent_sub: 'sub-0',
        account_ref: null,
        created_at: Date.parse('2026-01-01T00:00:00.000Z'),
      });

      await ensureA2aTables(asStoreDb(db));

      expect(
        await db.connection('sqlite').schema.hasColumn('agent_a2a_context', 'updated_at'),
      ).toBe(true);
      const old = await new LucidA2aStore(asStoreDb(db)).getContext('old');
      expect(old?.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(old?.updatedAt).toBeUndefined();
    });
  });
});

describe('governance threads feed timestamps', () => {
  it('LucidGovernanceQueries sends the thread createdAt / updatedAt', async () => {
    const db = await makeStoreDb();
    try {
      const store = new LucidAgentStore(asStoreDb(db));
      const thread = await store.createThread({
        actor: { id: 'alice', roles: [] },
        persona: 'default',
        title: 'Hello',
      });
      const queries = new LucidGovernanceQueries(asStoreDb(db));
      const [row] = await queries.recentThreads(10);
      expect(row?.createdAt).toBe(thread.createdAt);
      expect(row?.updatedAt).toBe(thread.updatedAt);
      const detail = await queries.threadDetail(thread.id);
      expect(detail?.createdAt).toBe(thread.createdAt);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('InMemoryGovernanceQueries sends the real createdAt (not updatedAt)', async () => {
    const store = new InMemoryAgentStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    const thread = await store.createThread({
      actor: { id: 'alice', roles: [] },
      persona: 'default',
      title: 'Hello',
    });
    vi.setSystemTime(new Date('2026-11-20T10:30:00.000Z'));
    await store.setTitle(thread.id, 'Renamed');
    const queries = new InMemoryGovernanceQueries(store);
    const [row] = await queries.recentThreads(10);
    expect(row?.createdAt).toBe('2026-11-20T10:00:00.000Z');
    const detail = await queries.threadDetail(thread.id);
    expect(detail?.createdAt).toBe('2026-11-20T10:00:00.000Z');
    expect(detail?.updatedAt).toBe(row?.updatedAt);
  });
});
