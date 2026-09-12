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

  it('reports no repair for a database it just created', async () => {
    const repairs = await createAgentTables(asStoreDb(db));

    expect(repairs).toEqual([]);
    expect(await hasParentColumn()).toBe(true);
  });
});
