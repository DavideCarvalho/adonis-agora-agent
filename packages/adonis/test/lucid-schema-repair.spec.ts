import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentTables, LucidAgentStore, LucidGovernanceQueries } from '../src/index.js';
import { asStoreDb, makeMemoryDb } from './helpers/make-db.js';

/**
 * `CREATE TABLE IF NOT EXISTS` cannot reach a column added to a table a deployment already has, so
 * `createAgentTables` also ALTERs the missing ones in. The `run_id` columns are covered end to end by
 * `migration-stub-runs.spec.ts`'s legacy scenario, whose database has no `agent_run` at all — which
 * is why it says nothing about a column added to `agent_run` itself.
 */

let db: Database;

beforeEach(() => {
  db = makeMemoryDb();
});

afterEach(async () => {
  await db?.manager.closeAll();
});

/** `agent_run` as a database provisioned before parent tracking still has it. */
async function runTableWithoutParent(): Promise<void> {
  const raw = db.connection('sqlite');
  await raw.rawQuery(
    `CREATE TABLE "agent_thread" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "actor_ref" VARCHAR(255) NOT NULL,
     "tenant_ref" VARCHAR(255) NULL, "title" TEXT NOT NULL, "persona" VARCHAR(255) NOT NULL DEFAULT 'default',
     "transient" INTEGER NOT NULL DEFAULT 0, "pinned_at" BIGINT NULL, "summary" TEXT NULL,
     "summary_message_count" INTEGER NOT NULL DEFAULT 0, "active_stream_id" VARCHAR(255) NULL,
     "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL, "deleted_at" BIGINT NULL)`,
  );
  await raw.rawQuery(
    `CREATE TABLE "agent_run" ("id" VARCHAR(255) PRIMARY KEY NOT NULL, "thread_id" VARCHAR(255) NOT NULL,
     "agent_name" VARCHAR(255) NULL, "actor_ref" VARCHAR(255) NOT NULL, "tenant_ref" VARCHAR(255) NULL,
     "status" VARCHAR(255) NOT NULL, "started_at" BIGINT NOT NULL, "finished_at" BIGINT NULL,
     "step_count" INTEGER NOT NULL DEFAULT 0, "input_tokens" INTEGER NOT NULL DEFAULT 0,
     "output_tokens" INTEGER NOT NULL DEFAULT 0, "cost_usd" DOUBLE PRECISION NULL, "error" TEXT NULL,
     "durable" INTEGER NOT NULL DEFAULT 0)`,
  );
}

async function hasParentColumn(): Promise<boolean> {
  return db.connection('sqlite').schema.hasColumn('agent_run', 'parent_run_id');
}

describe('createAgentTables repairs a run table that predates parent tracking', () => {
  it('ALTERs the column in and reports the repair', async () => {
    await runTableWithoutParent();
    expect(await hasParentColumn()).toBe(false);

    const repairs = await createAgentTables(asStoreDb(db));

    expect(repairs).toContain('agent_run.parent_run_id');
    expect(await hasParentColumn()).toBe(true);
  });

  it('ALTERs in the run metrics columns (ttft_ms, error_code, model_id) and the store fills them', async () => {
    await runTableWithoutParent();
    const raw = db.connection('sqlite');
    for (const column of ['ttft_ms', 'error_code', 'model_id']) {
      expect(await raw.schema.hasColumn('agent_run', column)).toBe(false);
    }

    const repairs = await createAgentTables(asStoreDb(db));

    expect(repairs).toEqual(
      expect.arrayContaining(['agent_run.ttft_ms', 'agent_run.error_code', 'agent_run.model_id']),
    );
    for (const column of ['ttft_ms', 'error_code', 'model_id']) {
      expect(await raw.schema.hasColumn('agent_run', column)).toBe(true);
    }

    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordRunStart({ runId: 'run-1', threadId: thread.id, actor });
    await store.recordRunEnd({ runId: 'run-1', status: 'completed', ttftMs: 420, modelId: 'm-1' });
    await store.recordRunStart({ runId: 'run-2', threadId: thread.id, actor });
    await store.recordRunEnd({
      runId: 'run-2',
      status: 'failed',
      error: 'boom',
      errorCode: 'model_no_output',
    });

    const queries = new LucidGovernanceQueries(asStoreDb(db));
    expect((await queries.runDetail('run-1'))?.run).toMatchObject({ ttftMs: 420, modelId: 'm-1' });
    expect((await queries.runDetail('run-2'))?.run).toMatchObject({
      errorCode: 'model_no_output',
    });
  });

  it('leaves the repaired schema writable by the store and readable by the read-model', async () => {
    await runTableWithoutParent();
    await createAgentTables(asStoreDb(db));

    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    await store.recordRunStart({ runId: 'run-child', threadId: thread.id, actor });
    await store.recordRunStart({
      runId: 'run-grandchild',
      threadId: thread.id,
      actor,
      parentRunId: 'run-child',
    });

    const queries = new LucidGovernanceQueries(asStoreDb(db));
    expect((await queries.runDetail('run-grandchild'))?.run.parentRunId).toBe('run-child');
  });

  it('adds the persona column to a queue table that predates it, and the store round-trips it', async () => {
    const raw = db.connection('sqlite');
    await runTableWithoutParent();
    await raw.rawQuery(
      `CREATE TABLE "agent_queued_message" ("id" VARCHAR(255) PRIMARY KEY NOT NULL,
       "thread_id" VARCHAR(255) NOT NULL, "actor" TEXT NOT NULL, "content" TEXT NOT NULL,
       "attachments" TEXT NULL, "agent_name" VARCHAR(255) NULL, "model" VARCHAR(255) NULL,
       "page_context" TEXT NULL, "interrupt" INTEGER NOT NULL DEFAULT 0, "position" INTEGER NOT NULL,
       "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL)`,
    );
    expect(await raw.schema.hasColumn('agent_queued_message', 'persona')).toBe(false);

    const repairs = await createAgentTables(asStoreDb(db));
    expect(repairs).toContain('agent_queued_message.persona');

    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor });
    const queued = await store.enqueueMessage({
      threadId: thread.id,
      actor,
      content: 'later',
      persona: 'sql',
    });
    expect((await store.getQueuedMessage(queued.id))?.persona).toBe('sql');
  });

  it('adds host_context to a queue table that predates it, and the store round-trips it', async () => {
    const raw = db.connection('sqlite');
    await runTableWithoutParent();
    await raw.rawQuery(
      `CREATE TABLE "agent_queued_message" ("id" VARCHAR(255) PRIMARY KEY NOT NULL,
       "thread_id" VARCHAR(255) NOT NULL, "actor" TEXT NOT NULL, "content" TEXT NOT NULL,
       "attachments" TEXT NULL, "agent_name" VARCHAR(255) NULL, "persona" VARCHAR(255) NULL,
       "model" VARCHAR(255) NULL, "page_context" TEXT NULL, "ui_capabilities" TEXT NULL,
       "interrupt" INTEGER NOT NULL DEFAULT 0, "position" INTEGER NOT NULL,
       "created_at" BIGINT NOT NULL, "updated_at" BIGINT NOT NULL)`,
    );
    expect(await raw.schema.hasColumn('agent_queued_message', 'host_context')).toBe(false);

    const repairs = await createAgentTables(asStoreDb(db));
    expect(repairs).toContain('agent_queued_message.host_context');

    const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor });
    const hostContext = { source: 'slack', delivery: { channel: 'C1', ts: '1.2' } };
    const queued = await store.enqueueMessage({
      threadId: thread.id,
      actor,
      content: 'later',
      hostContext,
    });
    expect((await store.getQueuedMessage(queued.id))?.hostContext).toEqual(hostContext);
    const plain = await store.enqueueMessage({ threadId: thread.id, actor, content: 'plain' });
    expect((await store.getQueuedMessage(plain.id))?.hostContext).toBeUndefined();
  });

  it('reports no repair for a database it just created', async () => {
    const repairs = await createAgentTables(asStoreDb(db));

    expect(repairs).toEqual([]);
    expect(await hasParentColumn()).toBe(true);
  });
});

describe('the governance rollups on a schema that predates the ledger columns', () => {
  it('read every row as an agent turn instead of failing (autoCreateTables: false)', async () => {
    await createAgentTables(asStoreDb(db));
    const raw = db.connection('sqlite');
    // The app owns the schema and has not run the migration that adds the ledger columns.
    await raw.rawQuery('DROP INDEX IF EXISTS "agent_token_usage_feature_created_idx"');
    for (const column of [
      'feature',
      'provider',
      'tenant_ref',
      'audio_seconds',
      'characters',
      'requests',
      'metadata',
    ]) {
      await raw.schema.alterTable('agent_token_usage', (table) => table.dropColumn(column));
    }
    const store = new LucidAgentStore(asStoreDb(db));
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    await raw.table('agent_token_usage').insert({
      id: 'u-1',
      thread_id: thread.id,
      actor_ref: 'u1',
      model_id: 'm',
      purpose: 'chat',
      input_tokens: 3,
      output_tokens: 2,
      created_at: Date.now(),
    });
    const gov = new LucidGovernanceQueries(asStoreDb(db), undefined, { autoCreateTables: false });
    const today = new Date().toISOString().slice(0, 10);
    const range = { fromDay: today, toDay: today };
    expect(await gov.spendByFeature(range)).toMatchObject([
      { feature: 'agent', source: 'agent', requests: 1, inputTokens: 3 },
    ]);
    expect((await gov.spendByModel(range))[0]?.requests).toBe(1);
  });
});
