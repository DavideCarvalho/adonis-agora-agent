import type {
  ActionProposal,
  ActionProposalStore,
  ActionProposalWorkerStore,
  CreateActionProposal,
} from '../../src/index.js';

export interface ActionProposalWorkerContractSubject {
  store: ActionProposalStore & ActionProposalWorkerStore;
  setNow(now: number): void;
}
export interface ActionProposalWorkerContractCase {
  name: string;
  run(subject: ActionProposalWorkerContractSubject): Promise<void>;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(run: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await run();
  } catch {
    rejected = true;
  }
  check(rejected, 'Invalid worker command must reject');
}
function input(id: string, actorRef = 'owner'): CreateActionProposal {
  return {
    id,
    actorRef,
    threadId: 'thread',
    tenantRef: null,
    originRunId: 'run',
    originMessageId: 'message',
    originToolCallId: id,
    toolName: 'refund',
    input: { amount: 5 },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: 2000,
    idempotencyKey: `key:${id}`,
  };
}
const approve = { decision: 'approved', actorRef: 'reviewer', via: 'web' } as const;
function lease(row: ActionProposal | null) {
  check(
    row?.execution?.status === 'executing' && row.execution.lease,
    'Expected claimed execution',
  );
  return row.execution.lease;
}
export const ACTION_PROPOSAL_WORKER_STORE_CONTRACT: readonly ActionProposalWorkerContractCase[] = [
  {
    name: 'discovers queued work across complete scopes with one fence per worker',
    async run({ store, setNow }) {
      setNow(1000);
      const a = input('a');
      const b = { ...input('b', 'another'), tenantRef: 'other-tenant' };
      for (const row of [a, b]) {
        await store.createActionProposal(row);
        await store.decideActionProposal(row, row.id, approve);
      }
      const claims = await Promise.all(
        ['one', 'two', 'three'].map((workerId) =>
          store.claimNextActionProposal({ workerId, leaseMs: 100 }),
        ),
      );
      check(
        claims
          .filter(Boolean)
          .map((row) => row?.id)
          .sort()
          .join(',') === 'a,b',
        'Exactly two unique claims',
      );
      for (const row of claims.filter((row): row is ActionProposal => row !== null)) {
        check(lease(row).generation === 1, 'First generation');
        check(row.actorRef === (row.id === 'a' ? 'owner' : 'another'), 'Authoritative requester');
        check(row.tenantRef === (row.id === 'a' ? null : 'other-tenant'), 'Authoritative tenant');
      }
      check((await store.getActionProposal(a, 'b')) === null, 'Scoped public reads stay isolated');
    },
  },
  {
    name: 'recovers expired execution with stable idempotency and a new fence',
    async run({ store, setNow }) {
      setNow(1000);
      const row = input('recovery');
      await store.createActionProposal(row);
      await store.decideActionProposal(row, row.id, approve);
      const first = await store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 });
      const old = lease(first);
      check(
        (await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 })) === null,
        'Live lease excludes peers',
      );
      setNow(1100);
      const second = await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 });
      const fresh = lease(second);
      check(fresh.generation === 2 && fresh.token !== old.token, 'Recovery advances the fence');
      check(
        first?.idempotencyKey === second?.idempotencyKey,
        'Recovery preserves effect deduplication',
      );
      check(
        (await store.settleActionProposal(row, row.id, { ...old, status: 'succeeded' })).status ===
          'conflict',
        'Stale worker cannot settle',
      );
    },
  },
  {
    name: 'expires only due pending work in bounded trusted-clock batches',
    async run({ store, setNow }) {
      setNow(1000);
      for (const id of ['a', 'b', 'c']) await store.createActionProposal(input(id));
      await store.decideActionProposal(input('c'), 'c', approve);
      check((await store.expireActionProposals({ limit: 1 })) === 0, 'Early expiry does nothing');
      setNow(2000);
      check((await store.expireActionProposals({ limit: 1 })) === 1, 'Bounded batch');
      const a = await store.getActionProposal(input('a'), 'a');
      check(
        a?.decision === 'expired' &&
          a.decisionAudit?.at === 2000 &&
          a.decisionAudit.via === 'expiry' &&
          a.decisionAudit.actorRef === 'system',
        'Server expiry audit',
      );
      check(
        (await store.getActionProposal(input('b'), 'b'))?.decision === 'pending',
        'Other pending row retained',
      );
      check((await store.expireActionProposals({ limit: 100 })) === 1, 'Remaining due pending row');
      check(
        (await store.getActionProposal(input('c'), 'c'))?.decision === 'approved',
        'Approved card expiry never cancels work',
      );
      check(
        (await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 }))?.id === 'c',
        'Old approved work remains recoverable',
      );
      check((await store.expireActionProposals({ limit: 100 })) === 0, 'No duplicate expiry');
    },
  },
  {
    name: 'keeps discovery metadata synchronized with renewal and settlement',
    async run({ store, setNow }) {
      setNow(1000);
      const row = input('renewal');
      await store.createActionProposal(row);
      await store.decideActionProposal(row, row.id, approve);
      const claimed = await store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 });
      const first = lease(claimed);
      setNow(1099);
      check(
        (await store.extendActionProposalLease(row, row.id, { ...first, leaseMs: 200 })).status ===
          'applied',
        'Renewal applied',
      );
      setNow(1100);
      check(
        (await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 })) === null,
        'Old lease expiry must not rediscover renewed work',
      );
      setNow(1299);
      const recovered = await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 });
      const second = lease(recovered);
      check(
        (
          await store.settleActionProposal(row, row.id, {
            ...second,
            status: 'succeeded',
            result: { done: true },
          })
        ).status === 'applied',
        'Settlement applied',
      );
      check(
        (await store.claimNextActionProposal({ workerId: 'three', leaseMs: 100 })) === null,
        'Terminal work never rediscovered',
      );
    },
  },
  {
    name: 'does not discover pending, rejected, failed or already completed proposals',
    async run({ store, setNow }) {
      setNow(1000);
      for (const id of ['pending', 'rejected', 'failed'])
        await store.createActionProposal(input(id));
      await store.decideActionProposal(input('rejected'), 'rejected', {
        ...approve,
        decision: 'rejected',
      });
      await store.decideActionProposal(input('failed'), 'failed', approve);
      const claimed = await store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 });
      check(claimed?.id === 'failed', 'Only approved queued work');
      await store.settleActionProposal(input('failed'), 'failed', {
        ...lease(claimed),
        status: 'failed',
        error: 'Revoked permission',
      });
      check(
        (await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 })) === null,
        'Failure has no automatic retry',
      );
    },
  },
  {
    name: 'preserves exact Unicode identities and logical ordering during discovery',
    async run({ store, setNow }) {
      setNow(1000);
      const ids = ['z ', 'z', '\ud800', '\ufffd'];
      for (const id of ids) {
        const row = input(id);
        await store.createActionProposal(row);
        await store.decideActionProposal(row, id, approve);
      }
      const seen: string[] = [];
      for (const _ of ids) {
        const claimed = await store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 });
        check(claimed !== null, 'Every distinct ID discovered');
        seen.push(claimed.id);
      }
      check(JSON.stringify(seen) === JSON.stringify([...ids].sort()), 'Same logical UTF16 order');
    },
  },
  {
    name: 'validates worker and expiry commands even with no stored proposals',
    async run({ store, setNow }) {
      setNow(1000);
      for (const leaseMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
        await rejects(() => store.claimNextActionProposal({ workerId: 'worker', leaseMs }));
      await rejects(() => store.claimNextActionProposal({ workerId: '', leaseMs: 100 }));
      for (const limit of [0, -1, 1.5, 1001])
        await rejects(() => store.expireActionProposals({ limit }));
      setNow(Number.NaN);
      await rejects(() => store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 }));
      await rejects(() => store.expireActionProposals({ limit: 1 }));
    },
  },
];
