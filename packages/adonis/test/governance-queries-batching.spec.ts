import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  LucidAgentStore,
  LucidGovernanceQueries,
  LucidPricingStore,
  seedModelPrices,
} from '../src/index.js';
import { countingDb } from './helpers/counting-db.js';
import { indexNames } from './helpers/index-names.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

// What the governance read-model and the quota read cost the database as the tables grow: the
// number of statements and rows a call takes has to stay flat in the number of rows it summarizes.

let db: Database;
let store: LucidAgentStore;

const alice: Actor = { id: 'alice' };
const bob: Actor = { id: 'bob' };

beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidAgentStore(asStoreDb(db));
});

afterEach(async () => {
  await db?.manager.closeAll();
});

/** A read-model over a counting view of the database, already provisioned. */
async function counted(pricing?: LucidPricingStore) {
  const view = countingDb(asStoreDb(db));
  const queries = new LucidGovernanceQueries(view.db, pricing);
  await queries.ensureSchema();
  view.traffic.statements = 0;
  view.traffic.rows = 0;
  return { queries, traffic: view.traffic };
}

/** `count` calls pending approval, alternating between alice's and bob's runs; one has no run. */
async function seedPending(count: number): Promise<void> {
  const threads = {
    alice: await store.createThread({ actor: alice, title: 'a' }),
    bob: await store.createThread({ actor: bob, title: 'b' }),
  };
  for (const actor of [alice, bob]) {
    await store.recordRunStart({
      runId: `run-${actor.id}`,
      threadId: threads[actor.id as 'alice' | 'bob'].id,
      actor,
    });
  }
  for (let index = 0; index < count; index++) {
    const actor = index % 2 === 0 ? 'alice' : 'bob';
    const message = await store.appendMessage({
      threadId: threads[actor].id,
      role: 'assistant',
      content: `step ${index}`,
    });
    await store.recordToolCall({
      toolCallId: `call-${index}`,
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: { index },
      status: 'pending_approval',
      // The last call predates run tracking: its actor is its thread's.
      ...(index === count - 1 ? {} : { runId: `run-${actor}` }),
    });
  }
}

describe('LucidGovernanceQueries pendingApprovals', () => {
  it('reads an inbox in one statement however many calls are pending, filtered in the database', async () => {
    await seedPending(41);
    const { queries, traffic } = await counted();

    const all = await queries.pendingApprovals({ limit: 200 });
    expect(all).toHaveLength(41);
    expect(traffic.statements).toBe(1);

    traffic.statements = 0;
    traffic.rows = 0;
    const mine = await queries.pendingApprovals({ actor: 'bob', limit: 200 });
    expect(mine.map((row) => row.actorRef)).toEqual(Array(20).fill('bob'));
    expect(traffic).toEqual({ statements: 1, rows: 20 });
  });

  it('resolves each call’s thread, run and actor — through its thread for a call with no run', async () => {
    await seedPending(3);
    const { queries } = await counted();
    const rows = await queries.pendingApprovals();
    expect(
      rows.map(({ toolCallId, actorRef, runId }) => ({ toolCallId, actorRef, runId })),
    ).toEqual([
      { toolCallId: 'call-0', actorRef: 'alice', runId: 'run-alice' },
      { toolCallId: 'call-1', actorRef: 'bob', runId: 'run-bob' },
      { toolCallId: 'call-2', actorRef: 'alice', runId: null },
    ]);
    expect(rows[0]?.input).toEqual({ index: 0 });
    expect(rows.every((row) => row.threadId !== '')).toBe(true);
    // The limit caps what the actor filter kept, not the calls before it.
    expect(await queries.pendingApprovals({ actor: 'alice', limit: 1 })).toHaveLength(1);
  });

  it('counts the pending calls exactly, past the inbox cap, in one statement', async () => {
    await seedPending(205);
    const { queries, traffic } = await counted();
    expect(await queries.countPendingApprovals()).toBe(205);
    expect(await queries.countPendingApprovals({ actor: 'bob' })).toBe(102);
    expect(traffic.statements).toBe(2);
  });
});

describe('LucidGovernanceQueries dashboard aggregates', () => {
  it('sums a range’s usage in the database, not row by row in the process', async () => {
    const pricing = new LucidPricingStore(asStoreDb(db));
    await seedModelPrices(pricing, [
      { modelId: 'gpt-x', inputPricePer1m: 3, outputPricePer1m: 15 },
    ]);
    const thread = await store.createThread({ actor: alice, title: 'a' });
    for (let index = 0; index < 120; index++) {
      await store.recordUsage({
        threadId: thread.id,
        actorRef: index % 3 === 0 ? 'bob' : 'alice',
        modelId: index % 2 === 0 ? 'gpt-x' : 'free-y',
        purpose: 'chat',
        usage: { inputTokens: 1000, outputTokens: 100 },
        // Every fourth row carries its provider's own figure, which wins over the estimate.
        ...(index % 4 === 0 ? { costUsd: 0.5 } : {}),
      });
    }
    const today = new Date().toISOString().slice(0, 10);
    const { queries, traffic } = await counted(pricing);

    const byModel = await queries.spendByModel({ fromDay: today, toDay: today });
    // gpt-x: 60 rows, 30 of them reported at 0.5; the other 30 at 0.003 + 0.0015 each.
    expect(byModel.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(15.135, 9);
    expect(byModel.find((row) => row.modelId === 'gpt-x')?.requests).toBe(60);
    expect(byModel.find((row) => row.modelId === 'free-y')?.costUsd).toBe(0);
    const byActor = await queries.spendByActor({ fromDay: today, toDay: today });
    expect(byActor.reduce((sum, row) => sum + row.requests, 0)).toBe(120);
    const trend = await queries.usageTrend({ fromDay: today, toDay: today });
    expect(trend).toEqual([{ day: today, totalTokens: 132_000, costUsd: expect.any(Number) }]);
    expect(trend[0]?.costUsd).toBeCloseTo(15.135, 9);
    // Three calls, each one grouped statement (plus the price list) — never the 120 rows.
    expect(traffic.rows).toBeLessThan(20);
  });

  it('rolls up recent threads in a fixed number of statements', async () => {
    for (let index = 0; index < 12; index++) {
      const thread = await store.createThread({ actor: alice, title: `t${index}` });
      for (let turn = 0; turn <= index % 3; turn++) {
        await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' });
      }
      await store.recordUsage({
        threadId: thread.id,
        actorRef: 'alice',
        modelId: 'm',
        purpose: 'chat',
        usage: { inputTokens: index, outputTokens: 1 },
      });
    }
    const { queries, traffic } = await counted();
    const rows = await queries.recentThreads(50);
    expect(rows).toHaveLength(12);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get('t5')).toMatchObject({ messageCount: 3, totalTokens: 6 });
    expect(byTitle.get('t9')).toMatchObject({ messageCount: 1, totalTokens: 10 });
    expect(traffic.statements).toBe(3);
  });

  it('resolves recent tool calls’ threads in one statement for the page', async () => {
    const thread = await store.createThread({ actor: alice, title: 'a' });
    for (let index = 0; index < 15; index++) {
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'x',
      });
      await store.recordToolCall({
        toolCallId: `c-${index}`,
        messageId: message.id,
        toolName: 'search',
        toolType: 'read',
        input: {},
        status: 'executed',
      });
    }
    const { queries, traffic } = await counted();
    const calls = await queries.recentToolCalls(50);
    expect(calls).toHaveLength(15);
    expect(calls.every((call) => call.threadId === thread.id)).toBe(true);
    expect(traffic.statements).toBe(2);
  });

  it('counts a thread’s runs and messages without reading them', async () => {
    const thread = await store.createThread({ actor: alice, title: 'a' });
    for (let index = 0; index < 80; index++) {
      await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' });
    }
    for (let index = 0; index < 30; index++) {
      await store.recordRunStart({ runId: `r-${index}`, threadId: thread.id, actor: alice });
    }
    const { queries, traffic } = await counted();
    const detail = await queries.threadDetail(thread.id);
    expect(detail?.usage).toMatchObject({ runCount: 30, messageCount: 80, costUsd: null });
    // The thread row, 20 runs and 50 messages for the drill-down, and a row per count.
    expect(traffic.rows).toBeLessThanOrEqual(1 + 20 + 50 + 2);
  });
});

describe('LucidAgentStore quota reads', () => {
  it('sums an actor’s window in the database', async () => {
    const thread = await store.createThread({ actor: alice, title: 'a' });
    for (let index = 0; index < 90; index++) {
      await store.recordUsage({
        threadId: thread.id,
        actorRef: 'alice',
        modelId: 'm',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 5 },
        ...(index % 3 === 0 ? { costUsd: 0.01 } : {}),
      });
    }
    const view = countingDb(asStoreDb(db));
    const reader = new LucidAgentStore(view.db);
    await reader.ensureSchema();
    view.traffic.statements = 0;
    view.traffic.rows = 0;

    const day = new Date().toISOString().slice(0, 10);
    const totals = await reader.usageBetween('alice', day, day);
    expect(totals.usedTokens).toBe(1350);
    expect(totals.costUsd).toBeCloseTo(0.3, 9);
    expect((await reader.quotaToday('alice', day)).usedTokens).toBe(1350);
    expect(view.traffic).toEqual({ statements: 2, rows: 2 });
  });
});

describe('the indexes those reads use', () => {
  it('are provisioned on this dialect', async () => {
    const names = async (table: string) => indexNames(asStoreDb(db), table);
    expect(await names('agent_message')).toContain('agent_message_thread_seq_idx');
    expect(await names('agent_tool_call')).toContain('agent_tool_call_message_idx');
    expect(await names('agent_token_usage')).toEqual(
      expect.arrayContaining(['agent_token_usage_thread_idx', 'agent_token_usage_created_idx']),
    );
    expect(await names('agent_run')).toContain('agent_run_thread_started_idx');
    expect(await names('agent_stream_frame')).toContain('agent_stream_frame_created_idx');
  });
});
