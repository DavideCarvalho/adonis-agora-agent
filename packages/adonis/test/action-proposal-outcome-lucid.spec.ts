import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LucidAgentStore, type LucidDatabaseLike } from '../src/stores/lucid.js';
import { AGENT_TABLES } from '../src/stores/lucid-schema.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';
import { type Backend, openBackend } from './helpers/real-db.js';

let db: Database;
let store: LucidAgentStore;
let now: number;
let threadId: string;
const actor = { id: 'owner', roles: [], tenantRef: 'tenant' };
beforeEach(async () => {
  db = await makeStoreDb();
  now = 1000;
  store = new LucidAgentStore(asStoreDb(db), { clock: () => now, autoCreateTables: false });
  threadId = (await store.createThread({ actor })).id;
});
afterEach(async () => {
  await db?.manager.closeAll();
});
async function terminal() {
  const input = {
    id: 'proposal',
    actorRef: actor.id,
    tenantRef: actor.tenantRef,
    threadId,
    originRunId: 'run',
    originMessageId: 'message',
    originToolCallId: 'call',
    toolName: 'refund',
    input: null,
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'key',
  };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, input.id, {
    decision: 'rejected',
    actorRef: actor.id,
    via: 'web',
    reason: 'No',
  });
  return input;
}
describe('Lucid atomic outcome admission', () => {
  it('paginates exactly across timestamp ties and literal UTF16 identity ordering', async () => {
    const original = await terminal();
    for (const id of ['x', 'x\u0000', 'x ']) await store.createActionProposal({ ...original, id });
    const first = await store.listActionProposals(original, { decision: 'pending', limit: 2 });
    expect(first.map((proposal) => proposal.id)).toEqual(['x', 'x\u0000']);
    const last = first.at(-1)!;
    expect(
      (
        await store.listActionProposals(original, {
          decision: 'pending',
          limit: 2,
          after: { createdAt: last.createdAt, id: last.id },
        })
      ).map((proposal) => proposal.id),
    ).toEqual(['x ']);
  });
  it('derives remembered grants atomically from successful or failed terminal proposals, never queued work', async () => {
    const original = await terminal();
    for (const status of ['succeeded', 'failed'] as const) {
      const input = { ...original, id: status, toolName: status };
      await store.createActionProposal(input);
      await store.decideActionProposal(input, input.id, {
        decision: 'approved',
        actorRef: actor.id,
        via: 'web',
        remember: true,
      });
      expect(await store.rememberedApprovals(threadId)).not.toContain(status);
      const claimed = await store.claimActionProposal(input, input.id, {
        workerId: 'worker',
        leaseMs: 100,
      });
      const lease = claimed.proposal!.execution!.lease!;
      await store.settleActionProposal(input, input.id, {
        token: lease.token,
        generation: lease.generation,
        ...(status === 'succeeded' ? { status } : { status, error: 'Failure' }),
      });
      expect(await store.rememberedApprovals(threadId)).toContain(status);
    }
    expect(await store.rememberedApprovals(`${threadId} `)).toEqual([]);
  });
  it('keeps decision, outcome claim and admission inside the caller transaction', async () => {
    const original = await terminal();
    const input = { ...original, id: 'ambient' };
    await store.createActionProposal(input);
    await store.claimNextActionProposalOutcome({ workerId: 'other', leaseMs: 100 });
    await expect(
      db.transaction(async (tx) => {
        const transactional = new LucidAgentStore(tx as unknown as LucidDatabaseLike, {
          clock: () => now,
          autoCreateTables: false,
        });
        await transactional.decideActionProposal(input, input.id, {
          decision: 'rejected',
          actorRef: actor.id,
          via: 'web',
        });
        const claim = await transactional.claimNextActionProposalOutcome({
          workerId: 'worker',
          leaseMs: 100,
        });
        expect(claim?.outcome.proposalId).toBe('ambient');
        expect((await transactional.admitActionProposalOutcome(claim!.lease)).status).toBe(
          'applied',
        );
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect((await store.getActionProposal(input, input.id))?.decision).toBe('pending');
    expect((await store.getThread(threadId))?.messages).toHaveLength(0);
  });
  it('admits once across independent pools while preserving queued user admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agora-outcomes-'));
    const handle = await openBackend((process.env.AGENT_TEST_BACKEND ?? 'sqlite') as Backend, {
      sqliteFile: join(directory, 'shared.sqlite'),
    });
    try {
      const first = new LucidAgentStore(handle.store, {
        clock: () => 1000,
        autoCreateTables: false,
      });
      const second = new LucidAgentStore(asStoreDb(handle.replica()), {
        clock: () => 1000,
        autoCreateTables: false,
      });
      const thread = await first.createThread({ actor });
      const input = {
        id: 'race',
        actorRef: actor.id,
        tenantRef: actor.tenantRef,
        threadId: thread.id,
        originRunId: 'run',
        originMessageId: 'message',
        originToolCallId: 'call',
        toolName: 'refund',
        input: null,
        confirmation: { title: 'Refund?', verb: 'Refund' },
        approver: 'requester',
        expiresAt: null,
        idempotencyKey: 'race',
      };
      await first.createActionProposal(input);
      await first.decideActionProposal(input, input.id, {
        decision: 'rejected',
        actorRef: actor.id,
        via: 'web',
      });
      const claims = await Promise.all(
        [first, second].map((owner, i) =>
          owner.claimNextActionProposalOutcome({ workerId: String(i), leaseMs: 100 }),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const lease = claims.find(Boolean)!.lease;
      const results = await Promise.all(
        [first, second].map((owner) => owner.admitActionProposalOutcome(lease)),
      );
      expect(results.map((result) => result.status).sort()).toEqual(['applied', 'unchanged']);
      expect(new Set(results.map((result) => result.messageId)).size).toBe(1);
      expect((await first.getThread(thread.id))?.messages).toHaveLength(1);
      expect(await first.claimActiveStream(thread.id, 'user-run')).toBe(true);
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('atomically replaces pending siblings only on a new creation and keeps approved work', async () => {
    const original = await terminal();
    const pending = { ...original, id: 'old', replacementKey: 'target' };
    await store.createActionProposal(pending);
    await store.createActionProposal({ ...pending, id: 'approved' });
    await store.decideActionProposal(pending, 'approved', {
      decision: 'approved',
      actorRef: actor.id,
      via: 'web',
    });
    const next = { ...pending, id: 'new' };
    expect((await store.createReplacingActionProposal(next)).status).toBe('created');
    expect((await store.getActionProposal(pending, 'old'))?.decision).toBe('superseded');
    expect((await store.getActionProposal(pending, 'approved'))?.decision).toBe('approved');
    await store.createActionProposal({ ...pending, id: 'later' });
    expect((await store.createReplacingActionProposal(next)).status).toBe('unchanged');
    expect((await store.getActionProposal(pending, 'later'))?.decision).toBe('pending');
  });
  it('admits one assistant fact, preserves matched receipts, and deduplicates delivery', async () => {
    const input = await terminal();
    const claimed = await store.claimNextActionProposalOutcome({
      workerId: 'worker',
      leaseMs: 100,
    });
    expect(claimed).not.toBeNull();
    const first = await store.admitActionProposalOutcome(claimed!.lease);
    expect(first.status).toBe('applied');
    expect(await store.admitActionProposalOutcome(claimed!.lease)).toEqual({
      status: 'unchanged',
      messageId: first.messageId,
    });
    const messages = (await store.getThread(threadId))!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      actionProposalOutcome: { proposalId: input.id },
    });
    expect(messages[0]?.toolResults).toBeUndefined();
    expect(messages[0]?.content).toContain('not executed');
  });
  it('returns busy while a user owns admission and rejects stale delivery fences', async () => {
    await terminal();
    await store.claimActiveStream(threadId, 'user-run');
    const first = await store.claimNextActionProposalOutcome({ workerId: 'first', leaseMs: 100 });
    expect((await store.admitActionProposalOutcome(first!.lease)).status).toBe('busy');
    await store.releaseActiveStream(threadId, 'user-run');
    now = 1100;
    const second = await store.claimNextActionProposalOutcome({ workerId: 'second', leaseMs: 100 });
    expect((await store.admitActionProposalOutcome(first!.lease)).status).toBe('conflict');
    expect((await store.admitActionProposalOutcome(second!.lease)).status).toBe('applied');
  });
  it('discards deleted threads without recreating history', async () => {
    await terminal();
    await store.softDeleteThread(threadId);
    const claimed = await store.claimNextActionProposalOutcome({
      workerId: 'worker',
      leaseMs: 100,
    });
    expect((await store.admitActionProposalOutcome(claimed!.lease)).status).toBe('discarded');
    expect(await db.from(AGENT_TABLES.messages).select('*')).toHaveLength(0);
  });
  it('rolls back an inserted fact when the delivery CAS fails', async () => {
    await terminal();
    const claimed = await store.claimNextActionProposalOutcome({
      workerId: 'worker',
      leaseMs: 100,
    });
    const backend = process.env.AGENT_TEST_BACKEND;
    if (backend === 'postgres') {
      await db.rawQuery(
        "CREATE FUNCTION fail_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'admission failure'; END $$",
      );
      await db.rawQuery(
        'CREATE TRIGGER fail_outcome BEFORE UPDATE ON agent_action_proposal FOR EACH ROW EXECUTE FUNCTION fail_outcome()',
      );
    } else if (backend === 'mysql') {
      await db.rawQuery(
        "CREATE TRIGGER fail_outcome BEFORE UPDATE ON agent_action_proposal FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admission failure'",
      );
    } else {
      await db.rawQuery(
        "CREATE TRIGGER fail_outcome BEFORE UPDATE ON agent_action_proposal BEGIN SELECT RAISE(ABORT, 'admission failure'); END",
      );
    }
    await expect(store.admitActionProposalOutcome(claimed!.lease)).rejects.toThrow(
      'admission failure',
    );
    expect(await db.from(AGENT_TABLES.messages).select('*')).toHaveLength(0);
    expect(
      (
        await store.getActionProposal(
          { tenantRef: actor.tenantRef, actorRef: actor.id, threadId },
          'proposal',
        )
      )?.outcomeDelivery?.status,
    ).toBe('pending');
  });
});
