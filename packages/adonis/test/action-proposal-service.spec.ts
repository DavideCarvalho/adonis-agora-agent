import { describe, expect, it } from 'vitest';
import { ActionProposalService } from '../src/action-proposal-service.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

describe('scoped proposal decisions', () => {
  it('decides after origin completion and refuses another tenant or forged decision fields', async () => {
    const store = new InMemoryAgentStore({ clock: () => 1000 });
    const actor = { id: 'owner', tenantRef: 'tenant', roles: [] };
    const thread = await store.createThread({ actor });
    await store.createActionProposal({
      id: 'proposal',
      actorRef: actor.id,
      tenantRef: actor.tenantRef,
      threadId: thread.id,
      originRunId: 'ended',
      originMessageId: 'message',
      originToolCallId: 'call',
      toolName: 'refund',
      input: null,
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'key',
    });
    const service = new ActionProposalService(store);
    await expect(
      service.decide({ ...actor, tenantRef: 'other' }, thread.id, 'proposal', 'approved', {}),
    ).rejects.toThrow('Forbidden');
    await expect(
      service.decide(actor, thread.id, 'proposal', 'approved', { input: { forged: true } }),
    ).rejects.toThrow('Invalid');
    expect(
      (await service.decide(actor, thread.id, 'proposal', 'approved', { remember: true })).status,
    ).toBe('applied');
    expect((await service.decide(actor, thread.id, 'proposal', 'approved', {})).status).toBe(
      'unchanged',
    );
    expect((await service.list(actor, thread.id))[0]?.execution?.status).toBe('queued');
  });
  it('allows a current policy reviewer only in the same tenant', async () => {
    const store = new InMemoryAgentStore();
    const owner = { id: 'owner', roles: [], tenantRef: 'tenant' };
    const thread = await store.createThread({ actor: owner });
    await store.createActionProposal({
      id: 'p',
      actorRef: owner.id,
      tenantRef: owner.tenantRef,
      threadId: thread.id,
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'call',
      toolName: 'refund',
      input: null,
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'reviewer',
      expiresAt: null,
      idempotencyKey: 'key',
    });
    const service = new ActionProposalService(store);
    const reviewer = { id: 'reviewer', roles: ['reviewer'], tenantRef: 'tenant' };
    expect(
      (await service.decide(reviewer, thread.id, 'p', 'rejected', { reason: 'No' })).status,
    ).toBe('applied');
    expect((await service.list(reviewer, thread.id)).map((proposal) => proposal.id)).toEqual(['p']);
    await store.createActionProposal({
      id: 'text',
      actorRef: owner.id,
      tenantRef: owner.tenantRef,
      threadId: thread.id,
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'text-call',
      toolName: 'refund',
      input: null,
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'reviewer',
      expiresAt: null,
      idempotencyKey: 'text',
    });
    expect(await service.handleTextDecision(reviewer, thread.id, 'confirmar #text')).toMatchObject({
      proposalDecision: { status: 'applied' },
    });
    expect((await service.list(owner, thread.id)).map((proposal) => proposal.id).sort()).toEqual([
      'p',
      'text',
    ]);
  });
});

it('pages beyond a filtered full page and authorizes explicit text IDs beyond the first1000', async () => {
  const store = new InMemoryAgentStore({ clock: () => -1 });
  const owner = { id: 'owner', tenantRef: 'tenant' };
  const reviewer = { id: 'reviewer', tenantRef: 'tenant', roles: ['reviewer'] };
  const thread = await store.createThread({ actor: owner });
  for (let index = 0; index < 1001; index++)
    await store.createActionProposal({
      id: `p${String(index).padStart(4, '0')}`,
      actorRef: owner.id,
      tenantRef: owner.tenantRef,
      threadId: thread.id,
      originRunId: 'ended',
      originMessageId: 'm',
      originToolCallId: `c${index}`,
      toolName: 'act',
      input: null,
      confirmation: { title: 'Act?', verb: 'Act' },
      approver: index === 1000 ? 'reviewer' : 'requester',
      expiresAt: null,
      idempotencyKey: `k${index}`,
    });
  const service = new ActionProposalService(store);
  const first = await service.listPage(reviewer, thread.id);
  expect(first.items).toEqual([]);
  expect(first.next).toEqual({ createdAt: -1, id: 'p0999' });
  expect(
    (await service.listPage(reviewer, thread.id, first.next)).items.map((row) => row.id),
  ).toEqual(['p1000']);
  expect(await service.handleTextDecision(reviewer, thread.id, 'confirmar #p1000')).toMatchObject({
    proposalDecision: { status: 'applied' },
  });
});

describe('text decisions', () => {
  async function seeded(ids: string[]) {
    const store = new InMemoryAgentStore({ clock: () => 1000 });
    const actor = { id: 'owner', roles: [] };
    const thread = await store.createThread({ actor });
    for (const id of ids)
      await store.createActionProposal({
        id,
        actorRef: actor.id,
        tenantRef: null,
        threadId: thread.id,
        originRunId: 'run',
        originMessageId: 'message',
        originToolCallId: `call-${id}`,
        toolName: 'refund',
        input: null,
        confirmation: { title: 'Refund?', verb: 'Refund' },
        approver: 'requester',
        expiresAt: null,
        idempotencyKey: id,
      });
    return { store, actor, thread };
  }

  it('lets an unknown #ID fall through as an ordinary message', async () => {
    const { store, actor, thread } = await seeded(['known']);
    const service = new ActionProposalService(store);
    expect(await service.handleTextDecision(actor, thread.id, 'sim #abc')).toEqual({
      status: 'unmatched',
    });
    expect((await service.list(actor, thread.id))[0]?.decision).toBe('pending');
  });

  it('accepts English commands by default and answers in Portuguese', async () => {
    const { store, actor, thread } = await seeded(['p']);
    const service = new ActionProposalService(store);
    expect(await service.handleTextDecision(actor, thread.id, 'Yes!')).toMatchObject({
      proposalDecision: { status: 'applied' },
      text: 'Proposta aprovada e enfileirada para execução.',
    });
  });

  it('takes the vocabulary and the replies from the config hook', async () => {
    const { store, actor, thread } = await seeded(['a', 'b']);
    const service = new ActionProposalService(store, undefined, {
      vocabulary: { approve: ['ok'], reject: ['nope'] },
      replies: {
        rejected: 'Rejected; nothing ran.',
        ambiguous: (ids) => `Which one? ${ids.join(' ')}`,
      },
    });
    expect(await service.handleTextDecision(actor, thread.id, 'sim')).toEqual({
      status: 'unmatched',
    });
    expect(await service.handleTextDecision(actor, thread.id, 'ok')).toMatchObject({
      text: 'Which one? a b',
    });
    expect(await service.handleTextDecision(actor, thread.id, 'nope #b')).toMatchObject({
      proposalDecision: { status: 'applied' },
      text: 'Rejected; nothing ran.',
    });
  });
});
