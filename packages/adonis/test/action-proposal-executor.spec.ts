import { expect, it } from 'vitest';
import { z } from 'zod';
import { ActionProposalExecutor } from '../src/action-proposal-executor.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/index.js';
import { InMemoryActionProposalStore } from '../src/testing/in-memory-action-proposal-store.js';

it('runs as fresh requester with raw transformation once and collects late UI under the stable key', async () => {
  const store = new InMemoryActionProposalStore({ clock: () => 1000 });
  const input = {
    id: 'p',
    tenantRef: null,
    actorRef: 'a',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: { value: 2 },
    preparationInput: { value: 1 },
    executionContext: { requestId: 'req' },
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'stable',
  };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, 'p', {
    decision: 'approved',
    actorRef: 'reviewer',
    via: 'button',
  });
  const claim = await store.claimActionProposal(input, 'p', { workerId: 'w', leaseMs: 100 });
  const registry = new ToolRegistry();
  let transforms = 0;
  registry.register(
    {
      name: 'send',
      kind: 'action',
      description: 'send',
      inputSchema: z.object({
        value: z.number().transform((value) => {
          transforms++;
          return value + 1;
        }),
      }),
    },
    {
      execute: async (data, ctx) => {
        expect(ctx.actor.id).toBe('a');
        expect(ctx.idempotencyKey).toBe('stable');
        await ctx.emitUi('note', { text: 'Sent' });
        return data;
      },
    },
  );
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'a', roles: ['ADMIN'] }) },
    resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
  });
  const result = await executor.execute(claim.proposal!);
  expect(result).toMatchObject({
    status: 'succeeded',
    result: { value: 2 },
    ui: [{ component: 'note', props: { text: 'Sent' } }],
  });
  expect(transforms).toBe(1);
});

it('fails fresh requester scope mismatch before resolving handlers', async () => {
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'reviewer' }) },
    resolveExecution: async () => {
      throw new Error('must not resolve');
    },
  });
  const store = new InMemoryActionProposalStore();
  const create = await store.createActionProposal({
    id: 'p',
    tenantRef: null,
    actorRef: 'a',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: null,
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'key',
  });
  expect(await executor.execute(create.proposal!)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('requester'),
  });
});
