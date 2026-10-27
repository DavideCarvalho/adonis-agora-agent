import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Actor, LucidAgentStore, LucidGovernanceQueries } from '../src/index.js';
import { countingDb } from './helpers/counting-db.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

// What the store's per-turn and per-thread reads cost the database as a thread grows: the number of
// statements (and rows) has to stay flat in the length of the thread.

let db: Database;
let store: LucidAgentStore;
const actor: Actor = { id: 'alice', roles: ['ADMIN'] };

beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidAgentStore(asStoreDb(db));
});

afterEach(async () => {
  await db?.manager.closeAll();
});

/** A store over a counting view of the same database, already provisioned. */
async function counted() {
  const view = countingDb(asStoreDb(db));
  const countedStore = new LucidAgentStore(view.db);
  await countedStore.ensureSchema();
  view.traffic.statements = 0;
  view.traffic.rows = 0;
  return { store: countedStore, traffic: view.traffic };
}

/** A thread with `steps` assistant messages, each carrying one auto-executed read call. */
async function seedThread(steps: number) {
  const thread = await store.createThread({ actor, title: 't' });
  await store.appendMessage({ threadId: thread.id, role: 'user', content: 'hi' });
  for (let index = 0; index < steps; index++) {
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: `step ${index}`,
      toolCalls: [{ id: `read-${index}`, name: 'lookup', input: { q: 'x'.repeat(200) } }],
    });
    await store.recordToolCall({
      toolCallId: `read-${index}`,
      messageId: message.id,
      toolName: 'lookup',
      toolType: 'read',
      input: { q: 'x'.repeat(200) },
      status: 'auto_executed',
      runId: 'run-1',
    });
    await store.updateToolCall({
      toolCallId: `read-${index}`,
      runId: 'run-1',
      status: 'executed',
      output: { rows: 'y'.repeat(500) },
    });
  }
  return thread;
}

describe('LucidAgentStore reads that stay flat in the thread length', () => {
  it('reads only the calls that carry an approval when it opens a thread', async () => {
    const thread = await seedThread(40);
    const last = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'needs a person',
    });
    await store.recordToolCall({
      toolCallId: 'act-1',
      messageId: last.id,
      toolName: 'purge',
      toolType: 'action',
      input: { key: 'k' },
      status: 'pending_approval',
      runId: 'run-1',
      approver: 'requester',
    });

    const { store: view, traffic } = await counted();
    const detail = await view.getThread(thread.id);

    // The thread row, its 42 messages, and the one call with an approver — not the 40 read calls.
    expect(traffic.rows).toBe(1 + 42 + 1);
    const withApproval = detail?.messages.filter((message) => message.approvals !== undefined);
    expect(withApproval?.map((message) => message.id)).toEqual([last.id]);
    expect(withApproval?.[0]?.approvals).toEqual([
      expect.objectContaining({ toolCallId: 'act-1', approver: 'requester', status: 'pending' }),
    ]);
  });

  it('answers remembered approvals in a fixed number of statements, scoped to the thread', async () => {
    const thread = await seedThread(60);
    const other = await store.createThread({ actor, title: 'other' });
    for (const [threadId, toolName] of [
      [thread.id, 'purge'],
      [other.id, 'deploy'],
    ] as const) {
      const message = await store.appendMessage({ threadId, role: 'assistant', content: 'ask' });
      await store.recordToolCall({
        toolCallId: `call-${toolName}`,
        messageId: message.id,
        toolName,
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId: `run-${toolName}`,
        approver: 'requester',
      });
      await store.updateToolCall({
        toolCallId: `call-${toolName}`,
        runId: `run-${toolName}`,
        status: 'executed',
        remember: true,
      });
    }

    const { store: view, traffic } = await counted();
    expect(await view.rememberedApprovals(thread.id)).toEqual(['purge']);
    // Thread scope + proposal tools + the remembered calls, whatever the thread's length.
    expect(traffic.statements).toBe(3);
    expect(await view.rememberedApprovals(other.id)).toEqual(['deploy']);
    expect(await view.rememberedApprovals('no-such-thread')).toEqual([]);
  });

  it('truncates a long tail in a bounded number of statements, tool calls included', async () => {
    const thread = await seedThread(80);
    const before = await store.getThread(thread.id);
    const cut = before?.messages[11];
    if (cut === undefined) throw new Error('seed too short');

    // Inside a transaction, so counted at the driver: every statement but the transaction framing.
    const sql: string[] = [];
    const knex = db.connection().getWriteClient();
    const onQuery = (query: { sql: string }) => sql.push(query.sql);
    knex.on('query', onQuery);
    await store.truncateFrom(thread.id, cut.id);
    knex.off('query', onQuery);
    // One read of the ids, one delete of the calls, one of the messages — not two per message.
    expect(sql.filter((statement) => /^\s*(select|delete)/i.test(statement))).toHaveLength(3);

    const after = await store.getThread(thread.id);
    expect(after?.messages.map((message) => message.id)).toEqual(
      before?.messages.slice(0, 11).map((message) => message.id),
    );
    const governance = new LucidGovernanceQueries(asStoreDb(db));
    const stats = await governance.perToolStats();
    // 10 assistant messages survive the cut (the user message is the first of the 11 kept).
    expect(stats).toEqual([expect.objectContaining({ toolName: 'lookup', calls: 10 })]);
  });

  it('updates a tool call reading only its key', async () => {
    const thread = await seedThread(1);
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'again',
    });
    await store.recordToolCall({
      toolCallId: 'big',
      messageId: message.id,
      toolName: 'lookup',
      toolType: 'read',
      input: { q: 'z'.repeat(10_000) },
      status: 'auto_executed',
      runId: 'run-2',
    });

    const view = countingDb(asStoreDb(db));
    const countedStore = new LucidAgentStore(view.db);
    await countedStore.ensureSchema();
    const selected: string[][] = [];
    const from = view.db.from.bind(view.db);
    view.db.from = ((table: string) => {
      const builder = from(table);
      const select = builder.select.bind(builder);
      builder.select = (...columns: string[]) => {
        selected.push(columns);
        return select(...columns);
      };
      return builder;
    }) as typeof view.db.from;

    await countedStore.updateToolCall({
      toolCallId: 'big',
      runId: 'run-2',
      status: 'executed',
      output: { ok: true },
    });
    expect(selected).toEqual([['id']]);
    expect(await store.toolCallOutcomes(['big'])).toEqual([
      expect.objectContaining({ id: 'big', status: 'executed', output: { ok: true } }),
    ]);
  });
});
