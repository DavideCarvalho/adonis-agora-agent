import { describe, expect, it } from 'vitest';
import type { CreateActionProposal } from '../src/spi/action-proposal-store.js';
import { InMemoryActionProposalStore } from '../src/testing/in-memory-action-proposal-store.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

function proposal(id: string, actorRef = 'requester'): CreateActionProposal {
  return {
    id,
    tenantRef: null,
    actorRef,
    threadId: 'thread',
    originRunId: 'run',
    originMessageId: 'message',
    originToolCallId: id,
    toolName: 'change',
    input: {},
    confirmation: { title: 'Change', verb: 'Apply' },
    approver: 'requester',
    expiresAt: 2000,
    idempotencyKey: `run:${id}`,
  };
}
const approve = { decision: 'approved' as const, actorRef: 'requester', via: 'web' };

describe.each([InMemoryActionProposalStore, InMemoryAgentStore])(
  'privileged action proposal discovery: %s',
  (Store) => {
    it('discovers queued work across scopes without giving two workers the same lease', async () => {
      const store = new Store({ clock: () => 1000 });
      const a = proposal('a');
      const b = proposal('b', 'another-requester');
      for (const input of [a, b]) {
        await store.createActionProposal(input);
        await store.decideActionProposal(input, input.id, approve);
      }
      const claims = await Promise.all(
        ['one', 'two', 'three'].map((workerId) =>
          store.claimNextActionProposal({ workerId, leaseMs: 100 }),
        ),
      );
      expect(claims.filter(Boolean).map((row) => row?.id)).toEqual(['a', 'b']);
      expect(claims[0]?.execution?.lease?.workerId).toBe('one');
      expect(claims[1]?.execution?.lease?.workerId).toBe('two');
      expect(await store.getActionProposal(a, 'b')).toBeNull();
    });

    it('recovers an expired lease with the original idempotency key and a new fence', async () => {
      let now = 1000;
      const store = new Store({ clock: () => now });
      const input = proposal('a');
      await store.createActionProposal(input);
      await store.decideActionProposal(input, 'a', approve);
      const first = await store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 });
      expect(await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 })).toBeNull();
      now = 1100;
      const second = await store.claimNextActionProposal({ workerId: 'two', leaseMs: 100 });
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(second?.execution?.generation).toBe(2);
      expect(second?.execution?.lease?.token).not.toBe(first?.execution?.lease?.token);
      const lease = first?.execution?.lease;
      expect(lease).toBeTruthy();
      if (!lease) throw new Error('Expected execution lease');
      expect(
        (await store.settleActionProposal(input, 'a', { ...lease, status: 'succeeded' })).status,
      ).toBe('conflict');
    });

    it('expires only due pending proposals using a bounded server-clock batch', async () => {
      let now = 1000;
      const store = new Store({ clock: () => now });
      for (const id of ['a', 'b', 'c']) await store.createActionProposal(proposal(id));
      await store.decideActionProposal(proposal('c'), 'c', approve);
      expect(await store.expireActionProposals({ limit: 1 })).toBe(0);
      now = 2000;
      expect(await store.expireActionProposals({ limit: 1 })).toBe(1);
      expect((await store.getActionProposal(proposal('a'), 'a'))?.decision).toBe('expired');
      expect((await store.getActionProposal(proposal('b'), 'b'))?.decision).toBe('pending');
      expect(await store.expireActionProposals({ limit: 100 })).toBe(1);
      expect((await store.getActionProposal(proposal('c'), 'c'))?.decision).toBe('approved');
      expect((await store.getActionProposal(proposal('a'), 'a'))?.decisionAudit).toEqual({
        actorRef: 'system',
        via: 'expiry',
        at: 2000,
      });
      expect(await store.expireActionProposals({ limit: 100 })).toBe(0);
    });

    it('validates discovery commands even when no proposals exist', async () => {
      const store = new Store({ clock: () => 1000 });
      for (const leaseMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        await expect(
          store.claimNextActionProposal({ workerId: 'worker', leaseMs }),
        ).rejects.toThrow();
      }
      await expect(store.claimNextActionProposal({ workerId: '', leaseMs: 100 })).rejects.toThrow();
      for (const limit of [0, -1, 1.5, 1001])
        await expect(store.expireActionProposals({ limit })).rejects.toThrow();
    });
  },
);
