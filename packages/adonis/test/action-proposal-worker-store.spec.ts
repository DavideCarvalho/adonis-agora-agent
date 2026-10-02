import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LucidAgentStore } from '../src/stores/lucid.js';
import {
  AGENT_TABLES,
  createAgentTables,
  createTableStatements,
  forDialect,
} from '../src/stores/lucid-schema.js';
import { ACTION_PROPOSAL_WORKER_STORE_CONTRACT } from './helpers/action-proposal-worker-store-contract.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';
import { type Backend, openBackend } from './helpers/real-db.js';

let db: Database;
let store: LucidAgentStore;
let now: number;
const scope = { tenantRef: null, actorRef: 'actor', threadId: 'thread' };
const input = {
  ...scope,
  id: 'work',
  originRunId: 'run',
  originMessageId: 'message',
  originToolCallId: 'call',
  toolName: 'tool',
  input: { raw: null },
  confirmation: { title: 'Execute?', verb: 'Execute' },
  approver: 'requester' as const,
  expiresAt: null,
  idempotencyKey: 'stable',
};
beforeEach(async () => {
  db = await makeStoreDb();
  now = 1000;
  store = new LucidAgentStore(asStoreDb(db), { clock: () => now, autoCreateTables: false });
});
afterEach(async () => {
  await db?.manager.closeAll();
});
describe('Lucid worker discovery', () => {
  it('discovers durable approved work and recovers only at lease expiry', async () => {
    await store.createActionProposal(input);
    expect(await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 })).toBeNull();
    await store.decideActionProposal(scope, input.id, {
      decision: 'approved',
      actorRef: 'actor',
      via: 'web',
    });
    const first = await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 });
    expect(first?.execution?.lease?.generation).toBe(1);
    expect(await store.claimNextActionProposal({ workerId: 'peer', leaseMs: 100 })).toBeNull();
    now = 1100;
    const recovered = await store.claimNextActionProposal({ workerId: 'peer', leaseMs: 100 });
    expect(recovered?.execution?.lease?.generation).toBe(2);
    expect(recovered?.idempotencyKey).toBe('stable');
  });
  it('expires only bounded pending work using the trusted clock', async () => {
    for (const id of ['a', 'b', 'c'])
      await store.createActionProposal({ ...input, id, expiresAt: 1100 });
    expect(await store.expireActionProposals({ limit: 2 })).toBe(0);
    now = 1100;
    expect(await store.expireActionProposals({ limit: 2 })).toBe(2);
    expect(await store.expireActionProposals({ limit: 2 })).toBe(1);
    expect((await store.getActionProposal(scope, 'a'))?.decisionAudit).toMatchObject({
      actorRef: 'system',
      via: 'expiry',
      at: 1100,
    });
  });
});

describe('Lucid worker discovery contract', () => {
  for (const test of ACTION_PROPOSAL_WORKER_STORE_CONTRACT) {
    it(test.name, async () =>
      test.run({
        store,
        setNow: (value) => {
          now = value;
        },
      }),
    );
  }
  it('claims once across independent pools and returns its own fence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agora-worker-'));
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
      await first.createActionProposal(input);
      await first.decideActionProposal(scope, input.id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'web',
      });
      const claims = await Promise.all(
        [first, second].map((owner, index) =>
          owner.claimNextActionProposal({ workerId: `worker-${index}`, leaseMs: 100 }),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)?.execution?.lease?.generation).toBe(1);
      await first.createActionProposal({ ...input, id: 'due', expiresAt: 1000 });
      const expirations = await Promise.all(
        [first, second].map((owner) => owner.expireActionProposals({ limit: 1 })),
      );
      expect(expirations.reduce((total, count) => total + count, 0)).toBe(1);
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('additively provisions old rows and explicitly backfills bounded batches without changing snapshots', async () => {
    await store.createActionProposal(input);
    await store.decideActionProposal(scope, input.id, {
      decision: 'approved',
      actorRef: 'actor',
      via: 'web',
    });
    const saved = await db.from(AGENT_TABLES.actionProposals).first();
    const mysql = process.env.AGENT_TEST_BACKEND === 'mysql';
    await db.rawQuery(forDialect(`DROP TABLE "${AGENT_TABLES.actionProposals}"`, mysql));
    const oldDdl = createTableStatements()[0]!
      .split('\n')
      .filter(
        (line) =>
          !/execution_status|lease_expires_at|proposal_expires_at|discovery_index_version|replacement_group_key|outcome_key|delivery_status/.test(
            line,
          ),
      )
      .join('\n');
    await db.rawQuery(forDialect(oldDdl, mysql));
    for (const field of [
      'replacement_group_key',
      'outcome_key',
      'delivery_status',
      'delivery_lease_expires_at',
      'execution_status',
      'lease_expires_at',
      'proposal_expires_at',
      'discovery_index_version',
    ])
      delete saved[field];
    await db.table(AGENT_TABLES.actionProposals).insert(saved);
    const repairs = await createAgentTables(asStoreDb(db));
    expect(
      repairs.filter((repair) => repair.startsWith(AGENT_TABLES.actionProposals)),
    ).toHaveLength(8);
    expect(await createAgentTables(asStoreDb(db))).toEqual([]);
    expect(await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 })).toBeNull();
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(1);
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(0);
    const indexed = await db.from(AGENT_TABLES.actionProposals).first();
    expect(indexed.payload).toBe(saved.payload);
    expect(Number(indexed.updated_at)).toBe(Number(saved.updated_at));
    expect(Number(indexed.version)).toBe(Number(saved.version) + 1);
    expect(indexed.execution_status).toBe('queued');
    expect(await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 })).toMatchObject(
      { id: input.id },
    );
  });
  it('backfill loses a version race without replacing a newly claimed lease', async () => {
    await store.createActionProposal(input);
    await store.decideActionProposal(scope, input.id, {
      decision: 'approved',
      actorRef: 'actor',
      via: 'web',
    });
    await db
      .from(AGENT_TABLES.actionProposals)
      .update({ discovery_index_version: 0, execution_status: null });
    const originalFrom = db.from.bind(db);
    let raced = false;
    db.from = ((table: string) => {
      const query = originalFrom(table);
      const originalUpdate = query.update.bind(query);
      query.update = ((values: Record<string, unknown>) => {
        if (
          table === AGENT_TABLES.actionProposals &&
          values.discovery_index_version === 1 &&
          !('payload' in values) &&
          !raced
        ) {
          raced = true;
          return Promise.resolve().then(async () => {
            const claimed = await store.claimActionProposal(scope, input.id, {
              workerId: 'peer',
              leaseMs: 100,
            });
            expect(claimed.status).toBe('applied');
            return originalUpdate(values);
          });
        }
        return originalUpdate(values);
      }) as typeof query.update;
      return query;
    }) as typeof db.from;
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(0);
    expect(raced).toBe(true);
    const row = await store.getActionProposal(scope, input.id);
    expect(row?.execution?.lease?.workerId).toBe('peer');
    const indexed = await originalFrom(AGENT_TABLES.actionProposals).first();
    expect(indexed.execution_status).toBe('executing');
    expect(Number(indexed.lease_expires_at)).toBe(1100);
  });
  it('uses bounded indexed candidate reads and validates backfill even when empty', async () => {
    await expect(store.backfillActionProposalDiscoveryIndex({ limit: 0 })).rejects.toThrow();
    const original = db.rawQuery.bind(db);
    const statements: string[] = [];
    db.rawQuery = ((sql: string, bindings?: unknown[]) => {
      statements.push(sql);
      return original(sql, bindings as never);
    }) as typeof db.rawQuery;
    await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 });
    await store.expireActionProposals({ limit: 7 });
    expect(statements.some((sql) => /execution_status/.test(sql) && /LIMIT 32/.test(sql))).toBe(
      true,
    );
    expect(statements.some((sql) => /proposal_expires_at/.test(sql) && /LIMIT \?/.test(sql))).toBe(
      true,
    );
  });
});
