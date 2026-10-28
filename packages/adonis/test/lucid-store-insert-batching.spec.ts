import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Actor,
  AGENT_TABLES,
  LucidAgentStore,
  type LucidClientLike,
  type LucidDatabaseLike,
  type RecordGenuiCallInput,
} from '../src/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

// `forkThread` and `recordGenuiCalls` write many rows: with Lucid's `multiInsert` they go out in a
// handful of statements; a client without it (a custom/structural one) still gets one insert per
// row. Both paths must write the very same rows, in the same order, in the same transaction.

let db: Database;
const actor: Actor = { id: 'alice', roles: ['ADMIN'] };

beforeEach(async () => {
  db = await makeStoreDb();
});

afterEach(async () => {
  await db?.manager.closeAll();
});

interface InsertTraffic {
  insert: number;
  multiInsert: number;
}

/** `base`, counting insert statements (inside transactions too), optionally hiding `multiInsert`. */
function instrumented(
  base: LucidDatabaseLike,
  options: { multiInsert: boolean },
): { db: LucidDatabaseLike; traffic: InsertTraffic } {
  const traffic: InsertTraffic = { insert: 0, multiInsert: 0 };
  const wrapBuilder = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === 'multiInsert' && !options.multiInsert) return undefined;
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'insert' || prop === 'multiInsert') {
          return (...args: unknown[]) => {
            traffic[prop] += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const wrapClient = <T extends object>(client: T): T =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'table') {
          return (table: string) =>
            wrapBuilder((value as (t: string) => object).call(target, table));
        }
        if (prop === 'transaction') {
          return (callback: (trx: LucidClientLike) => Promise<unknown>) =>
            (value as LucidDatabaseLike['transaction']).call(target, (trx) =>
              callback(wrapClient(trx)),
            );
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return { db: wrapClient(base), traffic };
}

/** A thread of `count` messages of varied shape (agent name / sent-at set on some, not others). */
async function seedThread(store: LucidAgentStore, count: number) {
  const thread = await store.createThread({ actor, title: 'source' });
  let last = '';
  for (let index = 0; index < count; index++) {
    const message = await store.appendMessage({
      threadId: thread.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      ...(index % 7 === 3 ? { agentName: 'helper' } : {}),
      ...(index % 11 === 5 ? { sentAt: new Date(1_700_000_000_000 + index).toISOString() } : {}),
      ...(index % 5 === 1 ? { usage: { inputTokens: index, outputTokens: 1 } } : {}),
    });
    last = message.id;
  }
  return { thread, last };
}

async function forkedRows(withMultiInsert: boolean) {
  const seedStore = new LucidAgentStore(asStoreDb(db));
  const { thread, last } = await seedThread(seedStore, 120);
  const view = instrumented(asStoreDb(db), { multiInsert: withMultiInsert });
  const store = new LucidAgentStore(view.db);
  await store.ensureSchema();
  const fork = await store.forkThread(thread.id, last);
  const read = async (threadId: string) =>
    (
      await db
        .from(AGENT_TABLES.messages)
        .where('thread_id', threadId)
        .orderBy('seq', 'asc')
        .select('*')
    ).map(({ id: _id, thread_id: _threadId, ...rest }) => rest);
  const strip = async (threadId: string) =>
    (await store.getThread(threadId))?.messages.map(({ id: _id, ...rest }) => rest);
  return {
    traffic: view.traffic,
    source: await read(thread.id),
    rows: await read(fork.id),
    sourceDetail: await strip(thread.id),
    detail: await strip(fork.id),
  };
}

function genuiRow(threadId: string, index: number): RecordGenuiCallInput {
  return {
    toolCallId: `call-${String(index).padStart(3, '0')}`,
    runId: 'run-1',
    threadId,
    actorRef: actor.id,
    ...(index % 3 === 0 ? { agentName: 'helper' } : {}),
    step: index,
    toolName: 'ui__show',
    channel: 'web',
    mode: 'sandbox',
    modelId: 'm',
    attempt: 1,
    outcome: 'ok',
    validity: 'first_try',
    inputTokens: index,
    outputTokens: 1,
    ...(index % 4 === 0 ? { costUsd: 0.01, costSource: 'provider' as const } : {}),
    payloadBytes: 20,
    ...(index % 5 === 0 ? { payload: `{"n":${index}}` } : {}),
  };
}

async function genuiRows(withMultiInsert: boolean) {
  const seedStore = new LucidAgentStore(asStoreDb(db));
  const thread = await seedStore.createThread({ actor, title: 't' });
  const view = instrumented(asStoreDb(db), { multiInsert: withMultiInsert });
  const store = new LucidAgentStore(view.db);
  await store.ensureSchema();
  const input = Array.from({ length: 100 }, (_, index) => genuiRow(thread.id, index));
  await store.recordGenuiCalls(input);
  // Replayed step: re-recording replaces the rows rather than duplicating them.
  await store.recordGenuiCalls(input.slice(0, 10));
  const rows = await db
    .from(AGENT_TABLES.genuiCalls)
    .where('thread_id', thread.id)
    .orderBy('id', 'asc')
    .select('*');
  return {
    traffic: view.traffic,
    rows: rows.map(({ created_at: _createdAt, thread_id: _threadId, ...rest }) => rest),
  };
}

describe('LucidAgentStore multi-row inserts', () => {
  it('forks a long thread in a few statements, writing the same rows as one insert per row', async () => {
    const batched = await forkedRows(true);
    await db.manager.closeAll();
    db = await makeStoreDb();
    const perRow = await forkedRows(false);

    // Each path copies the source verbatim (all columns, same order).
    for (const run of [batched, perRow]) {
      expect(run.rows).toHaveLength(120);
      expect(run.rows).toEqual(run.source);
      expect(run.detail).toEqual(run.sourceDetail);
    }
    expect(batched.detail?.map((m) => m.content)).toEqual(
      Array.from({ length: 120 }, (_, index) => `message ${index}`),
    );
    // Per row: the thread row plus one insert per message.
    expect(perRow.traffic).toEqual({ insert: 121, multiInsert: 0 });
    // Batched: one statement per run of same-shaped rows — far fewer than 120.
    expect(batched.traffic.insert + batched.traffic.multiInsert).toBeLessThan(60);
    expect(batched.traffic.multiInsert).toBeGreaterThan(0);
  });

  it('forks a uniform thread in one statement per bind-parameter-sized slice', async () => {
    const seedStore = new LucidAgentStore(asStoreDb(db));
    const thread = await seedStore.createThread({ actor, title: 'uniform' });
    let last = '';
    for (let index = 0; index < 200; index++) {
      last = (
        await seedStore.appendMessage({ threadId: thread.id, role: 'user', content: `m${index}` })
      ).id;
    }
    const view = instrumented(asStoreDb(db), { multiInsert: true });
    const store = new LucidAgentStore(view.db);
    await store.ensureSchema();
    const fork = await store.forkThread(thread.id, last);
    // The thread row, then 200 messages in a handful of multi-row statements (was 201 inserts).
    expect(view.traffic.insert).toBe(1);
    expect(view.traffic.multiInsert).toBeLessThanOrEqual(6);
    expect((await store.getThread(fork.id))?.messages.map((m) => m.content)).toEqual(
      Array.from({ length: 200 }, (_, index) => `m${index}`),
    );
  });

  it('records genui calls in a few statements, writing the same rows as one insert per row', async () => {
    const batched = await genuiRows(true);
    await db.manager.closeAll();
    db = await makeStoreDb();
    const perRow = await genuiRows(false);

    expect(batched.rows).toHaveLength(100);
    expect(batched.rows).toEqual(perRow.rows);
    expect(perRow.traffic).toEqual({ insert: 110, multiInsert: 0 });
    expect(batched.traffic.insert + batched.traffic.multiInsert).toBeLessThan(80);
    expect(batched.traffic.multiInsert).toBeGreaterThan(0);
  });

  it('rolls the whole fork back when a batched insert fails', async () => {
    const seedStore = new LucidAgentStore(asStoreDb(db));
    const { thread, last } = await seedThread(seedStore, 10);
    const base = asStoreDb(db);
    const failing = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'transaction') return typeof value === 'function' ? value.bind(target) : value;
        return (callback: (trx: LucidClientLike) => Promise<unknown>) =>
          target.transaction((trx) =>
            callback(
              new Proxy(trx, {
                get(t, p, r) {
                  const v = Reflect.get(t, p, r);
                  if (p !== 'table') return typeof v === 'function' ? v.bind(t) : v;
                  return (table: string) => {
                    const builder = trx.table(table);
                    if (table !== AGENT_TABLES.messages) return builder;
                    return {
                      insert: (row: Record<string, unknown>) => builder.insert(row),
                      multiInsert: () => Promise.reject(new Error('boom')),
                    };
                  };
                },
              }),
            ),
          );
      },
    });
    const store = new LucidAgentStore(failing);
    await store.ensureSchema();
    const before = await db.from(AGENT_TABLES.threads).count('* as n');
    await expect(store.forkThread(thread.id, last)).rejects.toThrow('boom');
    expect(await db.from(AGENT_TABLES.threads).count('* as n')).toEqual(before);
  });
});
