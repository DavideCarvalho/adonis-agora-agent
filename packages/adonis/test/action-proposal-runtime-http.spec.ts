import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionProposalWorker, AgentService, defineTool } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

let app: BootedApp | undefined;
afterEach(async () => {
  await app?.close();
});
const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
it('finishes the origin, accepts a second turn and text decision, then delivers one authorized fact', async () => {
  const store = new InMemoryAgentStore();
  let effects = 0;
  let models = 0;
  const refund = defineTool(
    {
      name: 'refund',
      kind: 'action',
      description: 'refund',
      input: z.object({ value: z.number().transform((n) => n + 1) }),
      roles: ['ADMIN'],
    },
    (input) => {
      effects++;
      return input;
    },
  );
  app = await bootAgentApp({
    model: new FakeModelProvider((_args, turn) => {
      models++;
      return turn === 0
        ? { text: '', toolCall: { name: 'refund', input: { value: 1 } } }
        : { text: 'Second turn.' };
    }),
    tools: [refund],
    store: 'test',
    stores: { test: async () => store },
    actionApprovalMode: 'independent',
    backgroundActorResolver: {
      resolve: async ({ actorRef }) => ({ id: actorRef, roles: ['ADMIN'] }),
    },
    actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
  });
  const post = (message: string, threadId?: string) =>
    fetch(`${app!.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, threadId }),
    });
  const first = await readSse(await post('refund'));
  const meta = first.find((frame) => frame.event === 'meta')!.data;
  const threadId = String(meta.threadId);
  const approval = first.find((frame) => frame.data.kind === 'approval-requested')!.data;
  expect(approval.target).toMatchObject({ kind: 'proposal' });
  expect(effects).toBe(0);
  await readSse(await post('A second message', threadId));
  const forged = await fetch(
    `${app.url}/agent/threads/${threadId}/action-proposals/${(approval.target as { proposalId: string }).proposalId}/approve`,
    { method: 'POST', headers, body: JSON.stringify({ input: null }) },
  );
  expect(forged.status).toBe(400);
  const decision = await post('confirmar', threadId);
  expect(decision.headers.get('content-type')).toContain('application/json');
  expect(await decision.json()).toMatchObject({ proposalDecision: { status: 'applied' } });
  await (await app.app.container.make(ActionProposalWorker)).runOnce();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await store.listActionProposals({ actorRef: 'u1', tenantRef: null, threadId }))[0]
        ?.outcomeDelivery?.status === 'admitted'
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(effects).toBe(1);
  expect(models).toBe(2);
  const facts = (await store.getThread(threadId))!.messages.filter(
    (message) => message.actionProposalOutcome,
  );
  expect(facts).toHaveLength(1);
  expect(facts[0]?.content).toContain('completed');
}, 15000);

it('AgentService.chat runs a decision-shaped message as a turn; only send decides by text', async () => {
  const store = new InMemoryAgentStore();
  const refund = defineTool(
    { name: 'refund', kind: 'action', description: 'refund', input: z.object({}) },
    () => 'done',
  );
  const seen: string[] = [];
  app = await bootAgentApp({
    model: new FakeModelProvider((args, turn) => {
      seen.push(String(args.messages.at(-1)?.content));
      return turn === 0 ? { text: '', toolCall: { name: 'refund', input: {} } } : { text: 'ok' };
    }),
    tools: [refund],
    store: 'test',
    stores: { test: async () => store },
    actionApprovalMode: 'independent',
    backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef, roles: [] }) },
    actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
  });
  const first = await readSse(
    await fetch(`${app.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'refund' }),
    }),
  );
  const threadId = String(first.find((frame) => frame.event === 'meta')!.data.threadId);
  const service = await app.app.container.make(AgentService);
  const started = await service.chat({ actor: { id: 'u1', roles: [] }, threadId, message: 'sim' });
  expect(started).toMatchObject({ threadId, runId: expect.any(String) });
  for (let attempt = 0; attempt < 100 && seen.length < 2; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen.at(-1)).toBe('sim');
  expect(
    (await store.listActionProposals({ actorRef: 'u1', tenantRef: null, threadId }))[0]?.decision,
  ).toBe('pending');
}, 15000);

it('pushes a settled proposal to actionProposalWorker.onSettled, and survives a throwing one', async () => {
  const store = new InMemoryAgentStore();
  const refund = defineTool(
    { name: 'refund', kind: 'action', description: 'refund', input: z.object({}) },
    () => 'refunded',
  );
  const settled: unknown[] = [];
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  app = await bootAgentApp({
    model: new FakeModelProvider((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'refund', input: {} } } : { text: 'ok' },
    ),
    tools: [refund],
    store: 'test',
    stores: { test: async () => store },
    actionApprovalMode: 'independent',
    backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef, roles: [] }) },
    actionProposalWorker: {
      pollIntervalMs: 10,
      leaseMs: 3000,
      onSettled: (proposal) => {
        settled.push(proposal);
        throw new Error('bridge down');
      },
    },
  });
  const post = (message: string, threadId?: string) =>
    fetch(`${app!.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, threadId }),
    });
  const first = await readSse(await post('refund'));
  const threadId = String(first.find((frame) => frame.event === 'meta')!.data.threadId);
  expect(await (await post('yes', threadId)).json()).toMatchObject({
    proposalDecision: { status: 'applied' },
  });
  const worker = await app.app.container.make(ActionProposalWorker);
  for (let attempt = 0; attempt < 100 && settled.length === 0; attempt++) await worker.runOnce();
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({ threadId, toolName: 'refund' });
  expect(logged).toHaveBeenCalledWith(
    '[@adonis-agora/agent] Action proposal worker failed',
    expect.objectContaining({ message: 'bridge down' }),
  );
  logged.mockRestore();
}, 15000);
