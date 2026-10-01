import type {
  ActionProposalDecisionCommand,
  ActionProposalScope,
  ActionProposalStore,
  CreateActionProposal,
  ListActionProposals,
  SettleActionProposal,
} from '../../src/spi/action-proposal-store.js';

export interface ActionProposalContractSubject {
  store: ActionProposalStore;
  setNow(now: number): void;
}
export interface ActionProposalContractCase {
  name: string;
  run(subject: ActionProposalContractSubject): Promise<void>;
}
const scope: ActionProposalScope = { tenantRef: null, actorRef: 'owner', threadId: 'thread' };
function input(id = 'proposal'): CreateActionProposal {
  return {
    ...scope,
    id,
    originRunId: 'run',
    originMessageId: 'message',
    originToolCallId: 'call',
    toolName: 'refund',
    input: { order: { id: 'order', amount: 5 } },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: 2000,
    idempotencyKey: `key:${id}`,
  };
}
const approve = {
  decision: 'approved',
  actorRef: 'reviewer',
  via: 'http',
  reason: 'checked',
  remember: true,
} as const;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const ACTION_PROPOSAL_STORE_CONTRACT: readonly ActionProposalContractCase[] = [
  {
    name: 'creates independent snapshots and replays canonical immutable creation',
    async run({ store, setNow }) {
      setNow(1000);
      const data = input();
      const made = await store.createActionProposal(data);
      check(
        made.status === 'created' &&
          made.proposal?.execution === null &&
          made.proposal.decision === 'pending',
        'pending without work',
      );
      data.confirmation.title = 'mutated';
      check(
        (await store.getActionProposal(scope, data.id))?.confirmation.title === 'Refund?',
        'creation snapshot isolation',
      );
      const replay = input();
      replay.input = { order: { amount: 5, id: 'order' } };
      check((await store.createActionProposal(replay)).status === 'unchanged', 'canonical replay');
      check(
        (await store.createActionProposal({ ...input(), toolName: 'forged' })).status ===
          'conflict',
        'changed replay rejected',
      );
      const other = { ...input(), actorRef: 'attacker' };
      const conflict = await store.createActionProposal(other);
      check(
        conflict.status === 'conflict' && conflict.proposal === undefined,
        'cross-owner replay disclosure',
      );
      const read = await store.getActionProposal(scope, data.id);
      check(read, 'read exists');
      read.confirmation.title = 'changed read';
      check(
        (await store.getActionProposal(scope, data.id))?.confirmation.title === 'Refund?',
        'read snapshot isolation',
      );
    },
  },
  {
    name: 'scopes every read and mutation including explicit null tenant',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      for (const wrong of [
        { ...scope, actorRef: 'other' },
        { ...scope, threadId: 'other' },
        { ...scope, tenantRef: 'tenant' },
      ]) {
        check((await store.getActionProposal(wrong, 'proposal')) === null, 'scoped get');
        check((await store.listActionProposals(wrong)).length === 0, 'scoped list');
        check(
          (await store.decideActionProposal(wrong, 'proposal', approve)).status === 'not_found',
          'scoped decision',
        );
        check(
          (await store.claimActionProposal(wrong, 'proposal', { workerId: 'w', leaseMs: 20 }))
            .status === 'not_found',
          'scoped claim',
        );
        check(
          (
            await store.extendActionProposalLease(wrong, 'proposal', {
              token: 'x',
              generation: 1,
              leaseMs: 20,
            })
          ).status === 'not_found',
          'scoped renew',
        );
        check(
          (
            await store.settleActionProposal(wrong, 'proposal', {
              token: 'x',
              generation: 1,
              status: 'failed',
              error: 'x',
            })
          ).status === 'not_found',
          'scoped settle',
        );
      }
    },
  },
  {
    name: 'decisions are first wins and approval atomically creates exactly one queued work item',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      check(
        (await store.claimActionProposal(scope, 'proposal', { workerId: 'w', leaseMs: 100 }))
          .status === 'conflict',
        'cannot claim pending',
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.decideActionProposal(scope, 'proposal', {
            ...approve,
            decision: i % 2 ? 'rejected' : 'approved',
          }),
        ),
      );
      check(results.filter((r) => r.status === 'applied').length === 1, 'one decision winner');
      const row = await store.getActionProposal(scope, 'proposal');
      check(row?.decisionAudit?.at === 1000, 'trusted decision time');
      check(
        row.decision === 'approved' ? row.execution?.status === 'queued' : row.execution === null,
        'atomic approval work',
      );
      const before = JSON.stringify(row);
      setNow(1500);
      check(
        (
          await store.decideActionProposal(scope, 'proposal', {
            ...approve,
            decision: row.decision as 'approved' | 'rejected',
            actorRef: 'later',
          })
        ).status === 'unchanged',
        'same decision replay',
      );
      check(
        JSON.stringify(await store.getActionProposal(scope, 'proposal')) === before,
        'terminal audit immutable',
      );
      check(
        (await store.createActionProposal(input())).status === 'unchanged',
        'creation replay after decision',
      );
    },
  },
  {
    name: 'expires at the exact boundary and cannot expire early or enqueue expired work',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      check(
        (await store.decideActionProposal(scope, 'proposal', { ...approve, decision: 'expired' }))
          .status === 'conflict',
        'early expiry conflicts',
      );
      setNow(2000);
      check(
        (await store.decideActionProposal(scope, 'proposal', approve)).status === 'expired',
        'boundary expiry wins',
      );
      const row = await store.getActionProposal(scope, 'proposal');
      check(
        row?.decision === 'expired' && row.execution === null && row.decisionAudit?.at === 2000,
        'expired durable without work',
      );
      check(
        (await store.decideActionProposal(scope, 'proposal', approve)).status === 'expired',
        'expired replay',
      );
    },
  },
  {
    name: 'concurrent claims and expired lease recovery fence stale settlement preserving the key',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      await store.decideActionProposal(scope, 'proposal', approve);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.claimActionProposal(scope, 'proposal', { workerId: `w${i}`, leaseMs: 100 }),
        ),
      );
      check(claims.filter((r) => r.status === 'applied').length === 1, 'one lease winner');
      const lease = (await store.getActionProposal(scope, 'proposal'))?.execution?.lease;
      check(lease, 'lease exists');
      setNow(1100);
      check(
        (
          await store.settleActionProposal(scope, 'proposal', {
            ...lease,
            status: 'succeeded',
            result: 1,
          })
        ).status === 'expired',
        'boundary expired lease cannot settle',
      );
      check(
        (await store.extendActionProposalLease(scope, 'proposal', { ...lease, leaseMs: 100 }))
          .status === 'expired',
        'expired lease cannot renew',
      );
      const recovered = await store.claimActionProposal(scope, 'proposal', {
        workerId: 'recovery',
        leaseMs: 100,
      });
      const newLease = recovered.proposal?.execution?.lease;
      check(
        recovered.status === 'applied' &&
          newLease &&
          newLease.generation === lease.generation + 1 &&
          newLease.token !== lease.token,
        'new fence on recovery',
      );
      check(recovered.proposal?.idempotencyKey === 'key:proposal', 'stable execution key');
      check(
        (
          await store.settleActionProposal(scope, 'proposal', {
            ...lease,
            status: 'succeeded',
            result: 2,
          })
        ).status === 'conflict',
        'stale settlement rejected',
      );
      check(
        (await store.extendActionProposalLease(scope, 'proposal', { ...lease, leaseMs: 100 }))
          .status === 'conflict',
        'stale renew rejected',
      );
      check(
        (await store.extendActionProposalLease(scope, 'proposal', { ...newLease, leaseMs: 200 }))
          .status === 'applied',
        'valid renewal',
      );
      setNow(1250);
      check(
        (
          await store.settleActionProposal(scope, 'proposal', {
            ...newLease,
            status: 'succeeded',
            result: { ok: true },
          })
        ).status === 'applied',
        'valid settlement after renewal',
      );
      check(
        (await store.claimActionProposal(scope, 'proposal', { workerId: 'late', leaseMs: 100 }))
          .status === 'conflict',
        'settled work cannot claim',
      );
      check(
        (
          await store.settleActionProposal(scope, 'proposal', {
            ...newLease,
            status: 'failed',
            error: 'late',
          })
        ).status === 'conflict',
        'settlement terminal',
      );
    },
  },
  {
    name: 'lists bounded filtered proposals and stores failed execution',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input('b'));
      await store.createActionProposal(input('a'));
      check(
        (await store.listActionProposals(scope, { limit: 1 }))[0]?.id === 'a',
        'deterministic bounded list',
      );
      await store.decideActionProposal(scope, 'a', approve);
      check(
        (await store.listActionProposals(scope, { decision: 'pending' })).length === 1,
        'decision filter',
      );
      const claimed = await store.claimActionProposal(scope, 'a', { workerId: 'w', leaseMs: 100 });
      const lease = claimed.proposal?.execution?.lease;
      check(lease, 'claimed');
      const result = await store.settleActionProposal(scope, 'a', {
        ...lease,
        status: 'failed',
        error: 'tool failed',
      });
      check(
        result.proposal?.execution?.status === 'failed' &&
          result.proposal.execution.error === 'tool failed',
        'failed result persisted',
      );
    },
  },
  {
    name: 'preserves exact logical identifiers and scope whitespace and case',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      await store.createActionProposal(input('proposal '));
      check(
        (await store.listActionProposals(scope)).length === 2,
        'logical ids differ with trailing whitespace',
      );
      for (const wrong of [
        { ...scope, actorRef: 'owner ' },
        { ...scope, actorRef: 'Owner' },
        { ...scope, threadId: 'thread ' },
        { ...scope, tenantRef: '' },
      ]) {
        check(
          (await store.getActionProposal(wrong, 'proposal')) === null,
          'scope preserves exact identity',
        );
        check(
          (await store.decideActionProposal(wrong, 'proposal', approve)).status === 'not_found',
          'exact identity mutation isolation',
        );
      }
      const tenantScope = { ...scope, tenantRef: 'tenant' };
      await store.createActionProposal({ ...input('tenant-proposal'), ...tenantScope });
      check(
        (await store.getActionProposal(
          { ...tenantScope, tenantRef: 'tenant ' },
          'tenant-proposal',
        )) === null,
        'tenant whitespace isolation',
      );
      check(
        (await store.listActionProposals({ ...tenantScope, tenantRef: 'Tenant' })).length === 0,
        'tenant case isolation',
      );
    },
  },
  {
    name: 'rejects lossy non-JSON creation snapshots',
    async run({ store, setNow }) {
      setNow(1000);
      for (const bad of [{ amount: Number.NaN }, { amount: undefined }, { action: () => true }]) {
        let rejected = false;
        try {
          await store.createActionProposal({ ...input(), input: bad });
        } catch {
          rejected = true;
        }
        check(rejected, 'non-JSON payload rejected before persistence');
      }
      check(
        (await store.getActionProposal(scope, 'proposal')) === null,
        'invalid creation leaves no row',
      );
    },
  },
  {
    name: 'rejects malformed creation and invalid trusted clock without persistence',
    async run({ store, setNow }) {
      setNow(1000);
      for (const patch of [
        { actorRef: '' },
        { tenantRef: undefined },
        { expiresAt: Number.NaN },
        { expiresAt: Number.POSITIVE_INFINITY },
        { decision: 'approved' },
      ]) {
        let rejected = false;
        try {
          await store.createActionProposal({
            ...input(),
            ...patch,
          } as unknown as CreateActionProposal);
        } catch {
          rejected = true;
        }
        check(rejected, 'malformed creation rejected');
      }
      check(
        (await store.getActionProposal(scope, 'proposal')) === null,
        'malformed creation has no row',
      );
      setNow(Number.NaN);
      let rejected = false;
      try {
        await store.createActionProposal(input());
      } catch {
        rejected = true;
      }
      check(rejected, 'invalid clock rejected');
      setNow(1000);
      check(
        (await store.getActionProposal(scope, 'proposal')) === null,
        'invalid clock has no row',
      );
    },
  },
  {
    name: 'rejects unsupported decisions settlement statuses and fractional leases',
    async run({ store, setNow }) {
      setNow(1000);
      await store.createActionProposal(input());
      let rejected = false;
      try {
        await store.decideActionProposal(scope, 'proposal', {
          ...approve,
          decision: 'superseded',
        } as unknown as ActionProposalDecisionCommand);
      } catch {
        rejected = true;
      }
      check(rejected, 'unsupported decision rejected');
      check(
        (await store.getActionProposal(scope, 'proposal'))?.decision === 'pending',
        'invalid decision has no effect',
      );
      await store.decideActionProposal(scope, 'proposal', approve);
      rejected = false;
      try {
        await store.claimActionProposal(scope, 'proposal', { workerId: 'w', leaseMs: 0.5 });
      } catch {
        rejected = true;
      }
      check(rejected, 'fractional lease rejected');
      const claimed = await store.claimActionProposal(scope, 'proposal', {
        workerId: 'w',
        leaseMs: 100,
      });
      const lease = claimed.proposal?.execution?.lease;
      check(lease, 'lease claimed');
      rejected = false;
      try {
        await store.settleActionProposal(scope, 'proposal', {
          ...lease,
          status: 'bogus',
        } as unknown as SettleActionProposal);
      } catch {
        rejected = true;
      }
      check(rejected, 'unsupported settlement rejected');
      check(
        (await store.getActionProposal(scope, 'proposal'))?.execution?.status === 'executing',
        'invalid settlement has no effect',
      );
    },
  },
  {
    name: 'orders tied timestamps by exact UTF-16 logical IDs before applying limit',
    async run({ store, setNow }) {
      setNow(1000);
      const expected = ['z', 'ä', 'Ω', '😀', '\uE000'];
      for (const id of [...expected].reverse()) await store.createActionProposal(input(id));
      const ids = (await store.listActionProposals(scope, { limit: 4 })).map((row) => row.id);
      check(
        JSON.stringify(ids) === JSON.stringify(expected.slice(0, 4)),
        'Unicode order and pagination match JS lexical contract',
      );
    },
  },
  {
    name: 'rejects oversized identities including invalid creation replay',
    async run({ store, setNow }) {
      setNow(1000);
      for (const patch of [
        { id: 'x'.repeat(256) },
        { actorRef: 'x'.repeat(256) },
        { threadId: 'x'.repeat(256) },
        { tenantRef: 'x'.repeat(256) },
      ]) {
        let rejected = false;
        try {
          await store.createActionProposal({ ...input(), ...patch });
        } catch {
          rejected = true;
        }
        check(rejected, 'identity cap enforced');
      }
      await store.createActionProposal(input());
      let rejected = false;
      try {
        await store.createActionProposal({ ...input(), actorRef: '' });
      } catch {
        rejected = true;
      }
      check(rejected, 'malformed replay rejected before scope lookup');
    },
  },
  {
    name: 'round trips escaped JSON Unicode and NUL without identity collisions',
    async run({ store, setNow }) {
      setNow(1000);
      const ids = ['\uD800', '\uFFFD', '\u0000', 'paired:😀'] as const;
      const strangeScope = {
        tenantRef: '\u0000\uD800',
        actorRef: 'actor\u0000',
        threadId: 'thread\uDFFF',
      };
      const value = { text: '😀', '\uDFFF': '\u0000\uD800' };
      for (const id of ids) {
        const data = {
          ...input(id),
          ...strangeScope,
          input: value,
          confirmation: { title: '\u0000\uD800', verb: 'OK' },
        };
        check(
          (await store.createActionProposal(data)).status === 'created',
          'exact Unicode identity created',
        );
        const row = await store.getActionProposal(strangeScope, id);
        check(
          row?.id === id && JSON.stringify(row.input) === JSON.stringify(value),
          'Unicode snapshot roundtrip',
        );
      }
      check(
        (await store.listActionProposals(strangeScope)).length === ids.length,
        'Unicode IDs remain distinct',
      );
      await store.decideActionProposal(strangeScope, ids[0], approve);
      const claim = await store.claimActionProposal(strangeScope, ids[0], {
        workerId: 'w',
        leaseMs: 100,
      });
      const lease = claim.proposal?.execution?.lease;
      check(lease, 'Unicode proposal claimed');
      const settled = await store.settleActionProposal(strangeScope, ids[0], {
        ...lease,
        status: 'succeeded',
        result: value,
      });
      check(
        JSON.stringify(settled.proposal?.execution?.result) === JSON.stringify(value),
        'Unicode settlement snapshot roundtrip',
      );
    },
  },
  {
    name: 'rejects malformed list bounds and decision filters consistently',
    async run({ store }) {
      for (const query of [
        ...[0, -1, 0.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, null, '1', true].map(
          (limit) => ({ limit }),
        ),
        ...['', 'invalid', null].map((decision) => ({ decision })),
      ]) {
        let rejected = false;
        try {
          await store.listActionProposals(scope, query as unknown as ListActionProposals);
        } catch {
          rejected = true;
        }
        check(rejected, 'malformed list query rejected');
      }
    },
  },
  {
    name: 'snapshots raw preparation and approved normalized input with immutable execution context',
    async run({ store, setNow }) {
      setNow(1000);
      const prepared = () => ({
        ...input('prepared'),
        preparationInput: { amount: '7', label: 'refund' },
        input: { amount: 7, label: 'refund!' },
        confirmation: { title: 'Refund 7?', verb: 'Refund' },
        executionContext: {
          agentName: 'billing',
          pageContext: { kind: 'order', selection: { id: 7 } },
          persona: 'careful',
          requestId: 'request',
        },
      });
      const data = prepared();
      check(
        (await store.createActionProposal(data)).status === 'created',
        'prepared proposal created',
      );
      data.preparationInput.amount = '99';
      data.input.amount = 99;
      data.confirmation.title = 'forged';
      data.executionContext.pageContext.selection.id = 99;
      const row = await store.getActionProposal(scope, 'prepared');
      check(row, 'prepared proposal exists');
      check(
        JSON.stringify(row.preparationInput) === JSON.stringify(prepared().preparationInput),
        'raw snapshot preserved',
      );
      check(
        JSON.stringify(row.input) === JSON.stringify(prepared().input),
        'normalized transform preserved without reparse',
      );
      check(row.confirmation.title === 'Refund 7?', 'checked card snapshot preserved');
      check(
        JSON.stringify(row.executionContext) === JSON.stringify(prepared().executionContext),
        'context snapshot preserved',
      );
      check(
        (await store.createActionProposal(prepared())).status === 'unchanged',
        'prepared replay unchanged',
      );
      for (const patch of [
        { agentName: 'other' },
        { persona: 'other' },
        { requestId: 'other' },
        { pageContext: { kind: 'other' } },
      ]) {
        const replay = prepared();
        check(
          (
            await store.createActionProposal({
              ...replay,
              executionContext: { ...replay.executionContext, ...patch },
            })
          ).status === 'conflict',
          'changed execution context conflicts',
        );
      }
      check(
        (
          await store.createActionProposal({
            ...prepared(),
            preparationInput: { amount: '8', label: 'refund' },
          })
        ).status === 'conflict',
        'changed raw preparation conflicts',
      );
      const rawRead = row.preparationInput as { amount: string };
      rawRead.amount = 'changed';
      if (row.executionContext?.pageContext) row.executionContext.pageContext.kind = 'changed';
      const fresh = await store.getActionProposal(scope, 'prepared');
      check(
        JSON.stringify(fresh?.preparationInput) === JSON.stringify(prepared().preparationInput),
        'returned raw snapshot isolated',
      );
      check(
        fresh?.executionContext?.pageContext?.kind === 'order',
        'returned context snapshot isolated',
      );
      const legacy = await store.createActionProposal(input('legacy'));
      check(
        legacy.proposal &&
          !Object.hasOwn(legacy.proposal, 'preparationInput') &&
          !Object.hasOwn(legacy.proposal, 'executionContext'),
        'legacy optional fields stay absent',
      );
      check(
        (await store.createActionProposal({ ...input('raw-null'), preparationInput: null }))
          .status === 'created',
        'raw null accepted',
      );
      const nullRow = await store.getActionProposal(scope, 'raw-null');
      check(
        nullRow && Object.hasOwn(nullRow, 'preparationInput') && nullRow.preparationInput === null,
        'raw null remains present',
      );
    },
  },
  {
    name: 'rejects invalid execution context descriptors and explicit undefined raw snapshots',
    async run({ store, setNow }) {
      setNow(1000);
      for (const executionContext of [
        undefined,
        null,
        [],
        {},
        { requestId: '' },
        { requestId: 7 },
        { requestId: 'r', actor: { id: 'forged' } },
        { requestId: 'r', tenantRef: 'forged' },
        { requestId: 'r', roles: ['ADMIN'] },
        { requestId: 'r', host: {} },
        { requestId: 'r', agentName: '' },
        { requestId: 'r', persona: '' },
        { requestId: 'r', agentName: undefined },
        { requestId: 'r', persona: 7 },
        { requestId: 'r', pageContext: null },
        { requestId: 'r', pageContext: [] },
        { requestId: 'r', pageContext: { kind: 7 } },
        { requestId: 'r', pageContext: { kind: 'order', handler: () => true } },
      ]) {
        let rejected = false;
        try {
          await store.createActionProposal({
            ...input('invalid-context'),
            executionContext,
          } as unknown as CreateActionProposal);
        } catch {
          rejected = true;
        }
        check(rejected, 'invalid context rejected');
      }
      let rejected = false;
      try {
        await store.createActionProposal({
          ...input('undefined-raw'),
          preparationInput: undefined,
        });
      } catch {
        rejected = true;
      }
      check(rejected, 'explicit undefined raw input rejected');
      check(
        (await store.getActionProposal(scope, 'invalid-context')) === null,
        'invalid context did not persist',
      );
      check(
        (await store.getActionProposal(scope, 'undefined-raw')) === null,
        'undefined raw did not persist',
      );
    },
  },
];
