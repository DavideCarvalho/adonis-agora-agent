import { expect, it } from 'vitest';
import { z } from 'zod';
import { ActionProposalExecutor } from '../src/action-proposal-executor.js';
import { ActionProposalWorker } from '../src/action-proposal-worker.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

it('executes approved work once and admits a fact without starting a model run', async () => {
  const store = new InMemoryAgentStore({ clock: () => 1000 });
  await store.createThread({ id: 't', actor: { id: 'a' } });
  const input = {
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
  };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, 'p', {
    decision: 'approved',
    actorRef: 'a',
    via: 'button',
  });
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register(
    { name: 'send', kind: 'action', description: 'send', inputSchema: z.null() },
    {
      execute: async () => {
        effects++;
        return 'sent';
      },
    },
  );
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'a' }) },
    resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
  });
  const worker = new ActionProposalWorker({ store, executor, workerId: 'w' });
  await worker.runOnce();
  await worker.runOnce();
  expect(effects).toBe(1);
  expect((await store.getThread('t'))!.messages).toHaveLength(1);
  expect((await store.getActionProposal(input, 'p'))!.outcomeDelivery!.status).toBe('admitted');
  await worker.stop();
});
it('validates lease and polling configuration before scheduling', () => {
  const store = new InMemoryAgentStore();
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => null },
    resolveExecution: async () => {
      throw new Error('unused');
    },
  });
  expect(
    () =>
      new ActionProposalWorker({ store, executor, workerId: 'w', leaseMs: 30, pollIntervalMs: 10 }),
  ).toThrow();
});
