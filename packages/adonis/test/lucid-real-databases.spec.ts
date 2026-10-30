import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  AGENT_TABLES,
  createAgentTables,
  dropAgentTables,
  LucidAgentStore,
  LucidConfirmTokenStore,
  tokenUsageTableStatement,
} from '../src/index.js';
import { indexNames } from './helpers/index-names.js';
import { type BackendDb, describeEachBackend, openBackend } from './helpers/real-db.js';

/**
 * What a real Postgres or MySQL does differently from the in-memory SQLite every other Lucid spec
 * runs on: identifier quoting, `TEXT` caps, collations, foreign keys, concurrent DDL, affected-row
 * counts, and timestamps that tie. Each case runs on SQLite, Postgres and MySQL (`pnpm test:db`).
 */
const actor = { id: 'alice', tenantRef: 't1' };

describeEachBackend('the Lucid stores on a real database', (backend) => {
  let handle: BackendDb;
  let store: LucidAgentStore;

  beforeAll(async () => {
    handle = await openBackend(backend);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await handle.reset();
    store = new LucidAgentStore(handle.store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads messages back in the order they were appended, even within one millisecond', async () => {
    // Every row gets the same created_at — what a fast turn's assistant + tool messages get.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    const thread = await store.createThread({ actor, persona: 'default' });
    const contents = Array.from({ length: 8 }, (_, index) => `message ${index}`);
    for (const [index, content] of contents.entries()) {
      await store.appendMessage({
        threadId: thread.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content,
      });
    }

    const transcript = (await store.getThread(thread.id))?.messages ?? [];
    expect(transcript.map((message) => message.content)).toEqual(contents);
    const window = await store.loadThreadForTurn({ threadId: thread.id, messageLimit: 3 });
    expect(window?.messages.map((message) => message.content)).toEqual(contents.slice(-3));

    const fork = await store.forkThread(thread.id, transcript[5]?.id as string);
    const forked = (await store.getThread(fork.id))?.messages ?? [];
    expect(forked.map((message) => message.content)).toEqual(contents.slice(0, 6));

    await store.truncateFrom(thread.id, transcript[4]?.id as string);
    const truncated = (await store.getThread(thread.id))?.messages ?? [];
    expect(truncated.map((message) => message.content)).toEqual(contents.slice(0, 4));
  });

  it('forks mixed-shape messages and records genui calls in multi-row inserts', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    let last = '';
    for (let index = 0; index < 60; index++) {
      last = (
        await store.appendMessage({
          threadId: thread.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `m${index}`,
          ...(index % 4 === 1 ? { agentName: 'helper' } : {}),
          ...(index % 9 === 2 ? { sentAt: new Date(1_700_000_000_000 + index).toISOString() } : {}),
        })
      ).id;
    }
    const fork = await store.forkThread(thread.id, last);
    const strip = async (threadId: string) =>
      (await store.getThread(threadId))?.messages.map(({ id: _id, ...rest }) => rest);
    expect(await strip(fork.id)).toEqual(await strip(thread.id));

    const calls = Array.from({ length: 50 }, (_, index) => ({
      toolCallId: `call-${String(index).padStart(2, '0')}`,
      runId: 'run-1',
      threadId: thread.id,
      actorRef: actor.id,
      step: index,
      toolName: 'ui__show',
      channel: 'web',
      mode: 'sandbox' as const,
      modelId: 'm',
      attempt: 1,
      outcome: 'ok' as const,
      validity: 'first_try' as const,
      inputTokens: index,
      outputTokens: 1,
      payloadBytes: 20,
      ...(index % 3 === 0 ? { payload: `{"n":${index}}` } : {}),
    }));
    await store.recordGenuiCalls(calls);
    await store.recordGenuiCalls(calls.slice(0, 5));
    const rows = await handle.store
      .from(AGENT_TABLES.genuiCalls)
      .where('thread_id', thread.id)
      .orderBy('id', 'asc')
      .select('id', 'step', 'payload');
    expect(rows.map((row) => [row.id, Number(row.step), row.payload ?? null])).toEqual(
      calls.map((call) => [call.toolCallId, call.step, call.payload ?? null]),
    );
  });

  it('stores a message and a tool output far past 64 KB', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const big = 'x'.repeat(300_000);
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: big,
      reasoning: big,
      toolCalls: [{ id: 'big-call', name: 'dump', input: {} }],
    });
    await store.recordToolCall({
      toolCallId: 'big-call',
      messageId: message.id,
      toolName: 'dump',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });
    await store.updateToolCall({ toolCallId: 'big-call', status: 'executed', output: { big } });

    const [read] = (await store.getThread(thread.id))?.messages ?? [];
    expect(read?.content.length).toBe(big.length);
    expect(read?.reasoning?.length).toBe(big.length);
    const [outcome] = await store.toolCallOutcomes(['big-call']);
    expect((outcome?.output as { big?: string } | undefined)?.big?.length).toBe(big.length);
  });

  it('tells actors apart by case', async () => {
    await store.createThread({ actor, persona: 'default', title: 'mine' });
    await store.createThread({ actor: { id: 'ALICE' }, persona: 'default', title: 'theirs' });

    expect((await store.listThreads('alice')).map((thread) => thread.title)).toEqual(['mine']);
  });

  it('cascades a deleted thread to its messages and tool calls', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const message = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'x' });
    await store.recordToolCall({
      toolCallId: 'cascade-call',
      messageId: message.id,
      toolName: 't',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });

    await handle.db.from(AGENT_TABLES.threads).where('id', thread.id).delete();

    expect(await handle.db.from(AGENT_TABLES.messages).where('thread_id', thread.id)).toEqual([]);
    expect(await handle.db.from(AGENT_TABLES.toolCalls).where('id', 'cascade-call')).toEqual([]);
  });

  it('admits exactly one of two racing claims on a thread, and lets the holder re-claim', async () => {
    const thread = await store.createThread({ actor, persona: 'default' });
    const results = await Promise.all([
      store.claimActiveStream(thread.id, 'run-a'),
      store.claimActiveStream(thread.id, 'run-b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const holder = results[0] ? 'run-a' : 'run-b';
    expect(await store.claimActiveStream(thread.id, holder)).toBe(true);
  });

  it('spends a confirm token once, however many replicas race for it', async () => {
    const tokens = [
      new LucidConfirmTokenStore(handle.store),
      new LucidConfirmTokenStore(handle.store),
    ];
    const claim = {
      hash: 'h'.repeat(64),
      actorRef: 'alice',
      tool: 'purge',
      expiresAt: Date.now() + 60_000,
    };
    const results = await Promise.all([...tokens, ...tokens].map((each) => each.claim(claim)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('adds every later column back to tables that hold rows, and keeps the rows', async () => {
    const aged = await openBackend(backend);
    try {
      const agedStore = new LucidAgentStore(aged.store);
      const thread = await agedStore.createThread({ actor, persona: 'default', title: 'Old chat' });
      await agedStore.appendMessage({ threadId: thread.id, role: 'user', content: 'old row' });
      const later: Record<string, string[]> = {
        [AGENT_TABLES.threads]: ['model', 'queue_pause', 'default_agent'],
        [AGENT_TABLES.messages]: ['reasoning', 'reasoning_ms', 'ui', 'feedback', 'agent_name'],
        [AGENT_TABLES.toolCalls]: ['approver', 'expires_at', 'remember', 'decided_via'],
        [AGENT_TABLES.runs]: ['parent_run_id', 'timings'],
        [AGENT_TABLES.tokenUsage]: ['cost_source', 'feature', 'counts_towards_quota'],
      };
      for (const [table, columns] of Object.entries(later)) {
        for (const column of columns) {
          await aged.db
            .connection()
            .schema.alterTable(table, (builder) => builder.dropColumn(column));
        }
      }

      const repairs = await createAgentTables(aged.store);

      for (const [table, columns] of Object.entries(later)) {
        for (const column of columns) expect(repairs).toContain(`${table}.${column}`);
      }
      await agedStore.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'new row',
        reasoning: 'r',
      });
      await agedStore.updateThread(thread.id, { defaultAgent: 'researcher' });
      const detail = await agedStore.getThread(thread.id);
      expect(detail?.messages.map((each) => each.content)).toEqual(['old row', 'new row']);
      expect(await agedStore.defaultAgentForThread(thread.id)).toBe('researcher');
      // Current now: a second pass repairs nothing.
      expect(await createAgentTables(aged.store)).toEqual([]);
    } finally {
      await aged.close();
    }
  });

  it('makes an old ledger’s thread_id nullable, keeping its rows, indexes and cascade', async () => {
    const aged = await openBackend(backend);
    try {
      const agedStore = new LucidAgentStore(aged.store);
      const thread = await agedStore.createThread({ actor, persona: 'default' });
      const other = await agedStore.createThread({ actor, persona: 'default' });
      const usage = { inputTokens: 3, outputTokens: 2 };
      await agedStore.recordUsage({
        threadId: thread.id,
        actorRef: actor.id,
        modelId: 'm',
        purpose: 'chat',
        usage,
      });
      await agedStore.recordUsage({
        threadId: other.id,
        actorRef: actor.id,
        modelId: 'm',
        purpose: 'chat',
        usage,
      });
      // The ledger as it was provisioned before usage could be recorded without a thread.
      const t = AGENT_TABLES.tokenUsage;
      if (backend === 'postgres') {
        await aged.store.rawQuery(`ALTER TABLE "${t}" ALTER COLUMN "thread_id" SET NOT NULL`);
      } else if (backend === 'mysql') {
        await aged.store.rawQuery(
          `ALTER TABLE \`${t}\` MODIFY \`thread_id\` VARCHAR(255) NOT NULL`,
        );
      } else {
        await aged.store.rawQuery(`ALTER TABLE "${t}" RENAME TO "${t}_new"`);
        await aged.store.rawQuery(
          tokenUsageTableStatement(t).replace(
            '"thread_id" VARCHAR(255) NULL',
            '"thread_id" VARCHAR(255) NOT NULL',
          ),
        );
        await aged.store.rawQuery(`INSERT INTO "${t}" SELECT * FROM "${t}_new"`);
        await aged.store.rawQuery(`DROP TABLE "${t}_new"`);
      }
      await expect(
        agedStore.recordUsage({ actorRef: actor.id, modelId: 'm', purpose: 'external', usage }),
      ).rejects.toThrow();

      const repairs = await createAgentTables(aged.store);

      expect(repairs).toContain(`${t}.thread_id`);
      await agedStore.recordUsage({
        actorRef: actor.id,
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        usage: { inputTokens: 0, outputTokens: 0 },
        audioSeconds: 30,
      });
      expect(await aged.db.from(t).count('* as n').first()).toMatchObject({ n: expect.anything() });
      expect((await aged.db.from(t).select('id')).length).toBe(3);
      expect(await indexNames(aged.store, t)).toEqual(
        expect.arrayContaining([
          `${t}_actor_created_idx`,
          `${t}_run_idx`,
          `${t}_feature_created_idx`,
        ]),
      );
      // The foreign key survived: a deleted thread still takes its rows with it.
      await aged.db.from(AGENT_TABLES.threads).where('id', thread.id).delete();
      expect(await aged.db.from(t).where('thread_id', thread.id)).toEqual([]);
      expect((await aged.db.from(t).select('id')).length).toBe(2);
      // Current now: a second pass repairs nothing.
      expect(await createAgentTables(aged.store)).toEqual([]);
    } finally {
      await aged.close();
    }
  });

  it('provisions an empty database from several replicas at once', async () => {
    const empty = await openBackend(backend, { tables: false });
    try {
      // Eight at once, three rounds: the race (a deadlock victim on MySQL) shows up only sometimes.
      const replicas = [empty.db, ...Array.from({ length: 7 }, () => empty.replica())];
      for (let round = 0; round < 3; round += 1) {
        if (round > 0) await dropAgentTables(empty.store);
        await Promise.all(replicas.map((replica) => createAgentTables(replica as never)));
      }
      const thread = await new LucidAgentStore(empty.store).createThread({
        actor,
        persona: 'default',
      });
      expect(thread.id).toBeTruthy();
    } finally {
      await empty.close();
    }
  });

  it('drops and recreates the tables, as the migration’s down() and up() do', async () => {
    const scratch = await openBackend(backend);
    try {
      await dropAgentTables(scratch.store);
      await createAgentTables(scratch.store);
      const thread = await new LucidAgentStore(scratch.store).createThread({
        actor,
        persona: 'default',
      });
      expect((await new LucidAgentStore(scratch.store).getThread(thread.id))?.id).toBe(thread.id);
    } finally {
      await scratch.close();
    }
  });
});

describeEachBackend('a MySQL connection without FOUND_ROWS', (backend) => {
  it.runIf(backend === 'mysql')('still lets the holder of a thread re-claim it', async () => {
    // mysql2 counts MATCHED rows by default (FOUND_ROWS); without the flag an update that writes the
    // value already there reports 0 — which must not read as losing the thread.
    const changedRows = await openBackend(backend, { mysqlFlags: ['-FOUND_ROWS'] });
    try {
      const store = new LucidAgentStore(changedRows.store);
      const thread = await store.createThread({ actor, persona: 'default' });
      expect(await store.claimActiveStream(thread.id, 'run-a')).toBe(true);
      expect(await store.claimActiveStream(thread.id, 'run-a')).toBe(true);
      expect(await store.claimActiveStream(thread.id, 'run-b')).toBe(false);
    } finally {
      await changedRows.close();
    }
  });
});
