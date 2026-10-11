import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TABLES,
  createAgentTables,
  LucidAgentStore,
  LucidGovernanceQueries,
  LucidPricingStore,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryGovernanceQueries } from '../src/testing/index.js';
import { GENUI_TELEMETRY_STORE_CONTRACT } from './helpers/genui-telemetry-contract.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor = { id: 'u1' };

describe('genui telemetry — in memory', () => {
  for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const store = new InMemoryAgentStore();
      const thread = await store.createThread({ actor, persona: 'default' });
      await contractCase.run({
        store,
        governance: new InMemoryGovernanceQueries(store),
        threadId: thread.id,
        actorRef: actor.id,
      });
    });
  }
});

describe('genui telemetry — Lucid (agent_genui_call)', () => {
  let db: Database;
  let store: LucidAgentStore;
  let governance: LucidGovernanceQueries;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
    governance = new LucidGovernanceQueries(asStoreDb(db), new LucidPricingStore(asStoreDb(db)));
  });

  afterEach(async () => {
    await db?.manager.closeAll();
  });

  for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const thread = await store.createThread({ actor, persona: 'default' });
      await contractCase.run({ store, governance, threadId: thread.id, actorRef: actor.id });
    });
  }

  const base = (threadId: string, toolCallId: string) => ({
    toolCallId,
    runId: 'run-1',
    threadId,
    actorRef: actor.id,
    step: 0,
    toolName: 'ui__sandbox',
    channel: 'web',
    mode: 'sandbox' as const,
    modelId: 'm',
    attempt: 1,
    outcome: 'ok' as const,
    validity: 'first_try' as const,
    inputTokens: 1,
    outputTokens: 1,
    payloadBytes: 20,
  });

  it('keeps a payload only when one was sampled', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordGenuiCalls([
      base(thread.id, 'plain'),
      { ...base(thread.id, 'sampled'), payload: '{"html":"<b>x</b>"}' },
    ]);
    const rows = await db
      .from(AGENT_TABLES.genuiCalls)
      .select('id', 'payload')
      .orderBy('id', 'asc');
    expect(rows.map((row) => [row.id, row.payload])).toEqual([
      ['plain', null],
      ['sampled', '{"html":"<b>x</b>"}'],
    ]);
  });

  it("goes with its thread (the thread's deletion cascades)", async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordGenuiCalls([base(thread.id, 'gone')]);
    await db.from(AGENT_TABLES.threads).where('id', thread.id).delete();
    expect(await db.from(AGENT_TABLES.genuiCalls).where('id', 'gone').select('id')).toEqual([]);
  });

  it('the boot heal creates the table on a database that predates it', async () => {
    await db.rawQuery(`DROP TABLE "${AGENT_TABLES.genuiCalls}"`.replace(/"/g, quoteFor(db)));
    await createAgentTables(asStoreDb(db));
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordGenuiCalls([base(thread.id, 'after-heal')]);
    const stats = await governance.genuiStats({
      fromDay: new Date().toISOString().slice(0, 10),
      toDay: new Date().toISOString().slice(0, 10),
    });
    expect(stats.totals.calls).toBe(1);
  });
});

function quoteFor(db: Database): string {
  const name = (db.connection() as unknown as { dialect?: { name?: string } }).dialect?.name ?? '';
  return /mysql/i.test(name) ? '`' : '"';
}
