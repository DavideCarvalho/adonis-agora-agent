import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeMemoryDb, makeStoreDb } from './helpers/make-db.js';

/**
 * A provider only promises a tool call id is unique within one response. Some (short `call_<digits>`
 * ids behind OpenRouter) hand another run the same one, and `agent_tool_call` used that id as its
 * primary key: the second run's insert failed on the first run's row and the thread was left with a
 * call answered by nothing (issue #183).
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

describe('a tool call table from before call ids were scoped to their run', () => {
  let db: Database;

  beforeEach(async () => {
    // SQLite: the DDL that rolls the table back to its old shape is written for it.
    db = makeMemoryDb();
    await createAgentTables(asStoreDb(db));
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  it('gets the column back, keeps its rows addressable, and takes the same id from a new run', async () => {
    const raw = db.connection();
    // As a deployed database has it: no `call_id`, and a row whose PK is the model's own id.
    await raw.rawQuery('DROP INDEX "agent_tool_call_call_idx"');
    await raw.rawQuery('ALTER TABLE "agent_tool_call" DROP COLUMN "call_id"');
    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    const thread = await store.createThread({ actor, persona: 'default' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
    });
    await raw.table('agent_tool_call').insert({
      id: SHORT_ID,
      message_id: message.id,
      tool_name: 'refund',
      tool_type: 'action',
      input: JSON.stringify({ run: 'run-old' }),
      status: 'pending_approval',
      run_id: 'run-old',
      created_at: Date.now(),
    });

    expect(await createAgentTables(asStoreDb(db))).toContain('agent_tool_call.call_id');

    // The old row is still found by the id the model gave it, alone or with its run.
    expect(await store.getToolCallRunId(SHORT_ID)).toBe('run-old');
    await store.updateToolCall({ toolCallId: SHORT_ID, runId: 'run-old', status: 'executed' });
    expect(await store.toolCallApproval(SHORT_ID, 'run-old')).toMatchObject({ status: 'executed' });

    // A new run handed the same id records next to it instead of failing on its primary key.
    await store.recordToolCall({
      toolCallId: SHORT_ID,
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: { run: 'run-new' },
      status: 'pending_approval',
      runId: 'run-new',
    });
    expect(await store.toolCallInput(SHORT_ID, 'run-new')).toEqual({ run: 'run-new' });
    expect(await store.toolCallInput(SHORT_ID, 'run-old')).toEqual({ run: 'run-old' });
    expect(await store.getToolCallRunId(SHORT_ID)).toBe('run-new');
  });
});
