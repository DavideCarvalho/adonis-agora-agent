import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Actor, AgentStore, ModelProvider, ModelTurnResult } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  createAgentTables,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  ToolRegistry,
} from '../src/index.js';
import { hasToolCallIdColumn, rowsOf } from '../src/stores/lucid-schema.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

/**
 * A provider only promises a tool call id is unique within one response. Some (short `call_<digits>`
 * ids behind OpenRouter) hand another run the same one, and `agent_tool_call` used that id as its
 * primary key: the second run's insert failed on the first run's row and the thread was left with a
 * call answered by nothing (issue #183). Rows are now keyed per assistant message — one per model
 * response — which also covers a provider that numbers calls per response (`call_0` again on the
 * next step of the same run) and a call recorded without a run.
 */

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const SHORT_ID = 'call_710817';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks for `lookup` under the same id on every run, then answers. */
const sameIdEveryRun: ModelProvider = {
  async runTurn(args): Promise<ModelTurnResult> {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const answered = args.messages.some((message) => (message.toolResults?.length ?? 0) > 0);
    return answered
      ? { text: 'answer', toolCalls: [], usage }
      : { text: '', toolCalls: [{ id: SHORT_ID, name: 'lookup', input: { q: 'x' } }], usage };
  },
};

describe('two runs handed the same tool call id (Lucid store)', () => {
  let db: Database;
  let store: LucidAgentStore;
  let gov: LucidGovernanceQueries;

  beforeEach(async () => {
    db = await makeStoreDb();
    store = new LucidAgentStore(asStoreDb(db));
    gov = new LucidGovernanceQueries(asStoreDb(db));
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('records and settles both calls, each under the id the model gave it', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'lookup',
        kind: 'read',
        description: 'reads',
        inputSchema: z.object({ q: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ found: true }) },
    );
    const factory = new AgentDepsFactory({
      model: sameIdEveryRun,
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);

    const runIds: string[] = [];
    for (const message of ['first thread', 'second thread']) {
      const { runId } = await service.chat({ actor, message });
      for await (const _frame of service.subscribe(runId)) {
        /* drain */
      }
      for (let i = 0; i < 200; i += 1) {
        const status = (await gov.runDetail(runId))?.run.status;
        if (status === 'completed' || status === 'failed') break;
        await sleep(5);
      }
      runIds.push(runId);
    }

    for (const runId of runIds) {
      const detail = await gov.runDetail(runId);
      expect(detail?.run.status).toBe('completed');
      expect(detail?.toolCalls.map((call) => [call.toolCallId, call.status])).toEqual([
        [SHORT_ID, 'executed'],
      ]);
    }
  });
});

const stores: [string, () => Promise<{ store: AgentStore; close: () => Promise<void> }>][] = [
  [
    'LucidAgentStore',
    async () => {
      const db = await makeStoreDb();
      return { store: new LucidAgentStore(asStoreDb(db)), close: () => db.manager.closeAll() };
    },
  ],
  ['InMemoryAgentStore', async () => ({ store: new InMemoryAgentStore(), close: async () => {} })],
];

describe.each(stores)('%s: one model id, two runs', (_name, make) => {
  let store: AgentStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ store, close } = await make());
  });
  afterEach(async () => {
    await close();
  });

  async function recordIn(runId: string, status: 'pending_approval' | 'auto_executed') {
    const thread = await store.createThread({ actor, persona: 'default' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
      runId,
    });
    await store.recordToolCall({
      toolCallId: SHORT_ID,
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: { run: runId },
      status,
      runId,
      ...(status === 'pending_approval' ? { approver: `approver-of-${runId}` } : {}),
    });
  }

  it('keeps the calls apart: updates, approvals and inputs are scoped by run', async () => {
    await recordIn('run-a', 'pending_approval');
    await recordIn('run-b', 'pending_approval');

    await store.updateToolCall({ toolCallId: SHORT_ID, runId: 'run-a', status: 'rejected' });

    expect(await store.toolCallApproval?.(SHORT_ID, 'run-a')).toMatchObject({
      status: 'rejected',
      approver: 'approver-of-run-a',
    });
    expect(await store.toolCallApproval?.(SHORT_ID, 'run-b')).toMatchObject({
      status: 'pending_approval',
      approver: 'approver-of-run-b',
    });
    expect(await store.toolCallInput?.(SHORT_ID, 'run-a')).toEqual({ run: 'run-a' });
    expect(await store.toolCallInput?.(SHORT_ID, 'run-b')).toEqual({ run: 'run-b' });
    // Another run's id is not this run's call.
    expect(await store.toolCallApproval?.(SHORT_ID, 'run-c')).toBeNull();
  });

  it('keeps apart two steps of the same run that were handed the same id', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    for (const step of ['step-1', 'step-2']) {
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
        runId: 'run-a',
      });
      await store.recordToolCall({
        toolCallId: 'call_0',
        messageId: message.id,
        toolName: 'refund',
        toolType: 'action',
        input: { step },
        status: 'pending_approval',
        runId: 'run-a',
      });
      // Steps are sequential: a step settles its call before the next one asks for another.
      await store.updateToolCall({
        toolCallId: 'call_0',
        runId: 'run-a',
        status: 'executed',
        output: step,
      });
      await sleep(2);
    }

    expect(await store.toolCallOutcomes?.(['call_0'])).toEqual([
      { id: 'call_0', status: 'executed', output: 'step-2' },
    ]);
    expect(await store.toolCallInput?.('call_0', 'run-a')).toEqual({ step: 'step-2' });
  });

  it('keeps apart two calls recorded without a run under the same id', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    for (const turn of ['first', 'second']) {
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
      });
      await store.recordToolCall({
        toolCallId: SHORT_ID,
        messageId: message.id,
        toolName: 'refund',
        toolType: 'action',
        input: { turn },
        status: 'pending_approval',
      });
      await sleep(2);
    }

    expect(await store.toolCallInput?.(SHORT_ID)).toEqual({ turn: 'second' });
  });

  it('answers a lookup by id alone with the newest call', async () => {
    await recordIn('run-a', 'auto_executed');
    await sleep(2);
    await recordIn('run-b', 'pending_approval');

    expect(await store.getToolCallRunId?.(SHORT_ID)).toBe('run-b');
    expect(await store.toolCallApproval?.(SHORT_ID)).toMatchObject({ status: 'pending_approval' });
    expect(await store.toolCallOutcomes?.([SHORT_ID])).toEqual([
      { id: SHORT_ID, status: 'pending_approval' },
    ]);
  });
});

describe('an agent_tool_call table from before #183', () => {
  let db: Database;
  let messageId: string;

  /** The index names on `agent_tool_call`, from each dialect's catalog. */
  async function toolCallIndexes(): Promise<string[]> {
    const raw = db.connection();
    const sql = /mysql/i.test(raw.dialect.name)
      ? 'SHOW INDEX FROM `agent_tool_call`'
      : /postgres|pg/i.test(raw.dialect.name)
        ? `SELECT indexname AS name FROM pg_indexes WHERE tablename = 'agent_tool_call'`
        : `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_tool_call'`;
    return rowsOf(await raw.rawQuery(sql)).map((row) => String(row.name ?? row.Key_name));
  }

  beforeEach(async () => {
    db = await makeStoreDb();
    await createAgentTables(asStoreDb(db));
    const raw = db.connection();
    // As a deployed database has it: no `call_id`, and a row whose PK is the model's own id.
    if (/mysql/i.test(raw.dialect.name)) {
      await raw.rawQuery('DROP INDEX `agent_tool_call_call_idx` ON `agent_tool_call`');
      await raw.rawQuery('ALTER TABLE `agent_tool_call` DROP COLUMN `call_id`');
    } else {
      await raw.rawQuery('DROP INDEX "agent_tool_call_call_idx"');
      await raw.rawQuery('ALTER TABLE "agent_tool_call" DROP COLUMN "call_id"');
    }
    const now = Date.now();
    await raw.table('agent_thread').insert({
      id: 'thread-old',
      actor_ref: actor.id,
      title: 'old thread',
      persona: 'default',
      created_at: now,
      updated_at: now,
    });
    messageId = 'message-old';
    await raw.table('agent_message').insert({
      id: messageId,
      thread_id: 'thread-old',
      role: 'assistant',
      content: '',
      created_at: now,
    });
    await raw.table('agent_tool_call').insert({
      id: SHORT_ID,
      message_id: messageId,
      tool_name: 'refund',
      tool_type: 'action',
      input: JSON.stringify({ run: 'run-old' }),
      status: 'pending_approval',
      run_id: 'run-old',
      created_at: now,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.manager.closeAll();
  });

  async function recordNewRun(store: LucidAgentStore, runId: string) {
    const message = await store.appendMessage({
      threadId: 'thread-old',
      role: 'assistant',
      content: '',
      runId,
    });
    await store.recordToolCall({
      toolCallId: SHORT_ID,
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: { run: runId },
      status: 'pending_approval',
      runId,
    });
  }

  it('is repaired at boot (autoCreateTables on, the default), and its rows stay addressable', async () => {
    const store = new LucidAgentStore(asStoreDb(db));
    // What the agent provider calls once as the app starts.
    await store.ensureSchema();

    expect(await hasToolCallIdColumn(asStoreDb(db))).toBe(true);
    expect(await toolCallIndexes()).toContain('agent_tool_call_call_idx');

    // The old row is still found by the id the model gave it, alone or with its run.
    expect(await store.getToolCallRunId(SHORT_ID)).toBe('run-old');
    await store.updateToolCall({ toolCallId: SHORT_ID, runId: 'run-old', status: 'executed' });
    expect(await store.toolCallApproval(SHORT_ID, 'run-old')).toMatchObject({ status: 'executed' });

    // A new run handed the same id records next to it instead of failing on its primary key.
    await recordNewRun(store, 'run-new');
    expect(await store.toolCallInput(SHORT_ID, 'run-new')).toEqual({ run: 'run-new' });
    expect(await store.toolCallInput(SHORT_ID, 'run-old')).toEqual({ run: 'run-old' });
    expect(await store.getToolCallRunId(SHORT_ID)).toBe('run-new');
  });

  it('with autoCreateTables off, keeps working on the old layout and says so until the migration runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    await store.ensureSchema();

    // Nothing is altered behind the app's migrations, and the boot says what to do.
    expect(await hasToolCallIdColumn(asStoreDb(db))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('createAgentTables()');

    // Tool calls are still recorded and read — under the model's id, as before.
    const message = await store.appendMessage({
      threadId: 'thread-old',
      role: 'assistant',
      content: '',
      runId: 'run-b',
    });
    await store.recordToolCall({
      toolCallId: 'call_other',
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: { run: 'run-b' },
      status: 'auto_executed',
      runId: 'run-b',
    });
    await store.updateToolCall({ toolCallId: 'call_other', runId: 'run-b', status: 'executed' });
    expect(await store.toolCallOutcomes(['call_other', SHORT_ID])).toEqual(
      expect.arrayContaining([
        { id: 'call_other', status: 'executed' },
        { id: SHORT_ID, status: 'pending_approval' },
      ]),
    );
    expect(await store.toolCallInput(SHORT_ID, 'run-old')).toEqual({ run: 'run-old' });

    // The app's migration runs; on its next boot the store keys calls per message.
    expect(await createAgentTables(asStoreDb(db))).toContain('agent_tool_call.call_id');
    const restarted = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    await restarted.ensureSchema();
    await recordNewRun(restarted, 'run-new');
    expect(await restarted.toolCallInput(SHORT_ID, 'run-new')).toEqual({ run: 'run-new' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
