import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateActionProposal } from '../src/spi/action-proposal-store.js';
import type { LucidDatabaseLike } from '../src/stores/lucid.js';
import { LucidAgentStore } from '../src/stores/lucid.js';
import { AGENT_TABLES, createAgentTables } from '../src/stores/lucid-schema.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { ACTION_PROPOSAL_STORE_CONTRACT } from './helpers/action-proposal-store-contract.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';
import { type Backend, openBackend } from './helpers/real-db.js';

let db: Database;
let store: LucidAgentStore;
const scope = { tenantRef: 'tenant', actorRef: 'actor', threadId: 'thread' };
const proposal: CreateActionProposal = {
  ...scope,
  id: 'proposal',
  originRunId: 'run',
  originMessageId: 'message',
  originToolCallId: 'call',
  toolName: 'refund',
  input: { order: 7 },
  confirmation: { title: 'Refund order 7?', verb: 'Refund' },
  approver: 'requester',
  expiresAt: null,
  idempotencyKey: 'proposal:refund:7',
};
beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidAgentStore(asStoreDb(db));
});
afterEach(async () => {
  await db?.manager.closeAll();
});

describe('Lucid independent proposals', () => {
  it('adds proposals to an older schema and preserves history on repeated provisioning', async () => {
    const thread = await store.createThread({ actor: { id: 'owner', roles: [] } });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'preserved' });
    await db.rawQuery(
      `DROP TABLE "${AGENT_TABLES.actionProposals}"`.replaceAll(
        '"',
        process.env.AGENT_TEST_BACKEND === 'mysql' ? '`' : '"',
      ),
    );
    await createAgentTables(asStoreDb(db));
    await store.createActionProposal(proposal);
    await createAgentTables(asStoreDb(db));
    expect((await store.getThread(thread.id))?.messages[0]?.content).toBe('preserved');
    expect((await store.getActionProposal(scope, proposal.id))?.input).toEqual(proposal.input);
  });
  it('admits only one creator, decision and worker across separate database pools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agora-proposal-'));
    const backend = (process.env.AGENT_TEST_BACKEND ?? 'sqlite') as Backend;
    const handle = await openBackend(backend, { sqliteFile: join(directory, 'shared.sqlite') });
    try {
      const options = { clock: () => 1000, autoCreateTables: false };
      const first = new LucidAgentStore(handle.store, options);
      const second = new LucidAgentStore(asStoreDb(handle.replica()), options);
      const created = await Promise.all([
        first.createActionProposal(proposal),
        second.createActionProposal(proposal),
      ]);
      expect(created.map((r) => r.status).sort()).toEqual(['created', 'unchanged']);
      const decided = await Promise.all(
        [first, second].map((s) =>
          s.decideActionProposal(scope, proposal.id, {
            decision: 'approved',
            actorRef: 'actor',
            via: 'console',
          }),
        ),
      );
      expect(decided.map((r) => r.status).sort()).toEqual(['applied', 'unchanged']);
      const claims = await Promise.all(
        [first, second].map((s, index) =>
          s.claimActionProposal(scope, proposal.id, { workerId: `worker${index}`, leaseMs: 100 }),
        ),
      );
      expect(claims.map((r) => r.status).sort()).toEqual(['applied', 'conflict']);
      expect((await second.getActionProposal(scope, proposal.id))?.idempotencyKey).toBe(
        proposal.idempotencyKey,
      );
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('replays creation inside a transaction without aborting it on duplicate identity', async () => {
    await db.transaction(async (transaction) => {
      const inside = new LucidAgentStore(transaction as unknown as LucidDatabaseLike, {
        autoCreateTables: false,
      });
      expect((await inside.createActionProposal(proposal)).status).toBe('created');
      expect((await inside.createActionProposal(proposal)).status).toBe('unchanged');
      expect((await inside.createActionProposal({ ...proposal, id: 'other' })).status).toBe(
        'created',
      );
    });
    expect((await store.listActionProposals(scope)).length).toBe(2);
  });
  it('failed approval writes leave both the decision pending and execution absent', async () => {
    await store.createActionProposal(proposal);
    const backend = process.env.AGENT_TEST_BACKEND;
    if (backend === 'postgres') {
      await db.rawQuery(
        "CREATE FUNCTION fail_proposal_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected proposal failure'; END $$",
      );
      await db.rawQuery(
        'CREATE TRIGGER fail_proposal_update BEFORE UPDATE ON agent_action_proposal FOR EACH ROW EXECUTE FUNCTION fail_proposal_update()',
      );
    } else if (backend === 'mysql') {
      await db.rawQuery(
        "CREATE TRIGGER fail_proposal_update BEFORE UPDATE ON agent_action_proposal FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected proposal failure'",
      );
    } else {
      await db.rawQuery(
        "CREATE TRIGGER fail_proposal_update BEFORE UPDATE ON agent_action_proposal BEGIN SELECT RAISE(ABORT, 'injected proposal failure'); END",
      );
    }
    await expect(
      store.decideActionProposal(scope, proposal.id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'web',
      }),
    ).rejects.toThrow('injected proposal failure');
    const unchanged = await store.getActionProposal(scope, proposal.id);
    expect(unchanged?.decision).toBe('pending');
    expect(unchanged?.execution).toBeNull();
    expect(unchanged?.decisionAudit).toBeNull();
  });
  it('persists approval and queued work as one decision and fences concurrent workers', async () => {
    expect((await store.createActionProposal(proposal)).status).toBe('created');
    const decisions = await Promise.all([
      store.decideActionProposal(scope, proposal.id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'web',
      }),
      store.decideActionProposal(scope, proposal.id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'text',
      }),
    ]);
    expect(decisions.map((d) => d.status).sort()).toEqual(['applied', 'unchanged']);
    expect((await store.getActionProposal(scope, proposal.id))?.execution?.status).toBe('queued');
    const claims = await Promise.all([
      store.claimActionProposal(scope, proposal.id, { workerId: 'one', leaseMs: 60_000 }),
      store.claimActionProposal(scope, proposal.id, { workerId: 'two', leaseMs: 60_000 }),
    ]);
    expect(claims.map((c) => c.status).sort()).toEqual(['applied', 'conflict']);
  });
});

describe.each(['memory', 'lucid'] as const)('ActionProposalStore contract: %s', (adapter) => {
  for (const contract of ACTION_PROPOSAL_STORE_CONTRACT) {
    it(contract.name, async () => {
      let now = 1000;
      const options = { clock: () => now };
      const tested =
        adapter === 'memory'
          ? new InMemoryAgentStore(options)
          : new LucidAgentStore(asStoreDb(db), options);
      await contract.run({
        store: tested,
        setNow: (value) => {
          now = value;
        },
      });
    });
  }
});
