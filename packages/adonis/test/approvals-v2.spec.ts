import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  AgentSseEncoder,
  type AgentStreamEvent,
  type ApprovalPolicy,
  approvalRules,
  DefaultToolAuthorizer,
  defineTool,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript, InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

/** Calls `refund` on its first step and answers on the next — per turn of the thread. */
const refundOnce: FakeScript = (args) => {
  const last = args.messages.at(-1);
  return last?.role === 'user' && last.content.length > 0
    ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
    : { text: 'Done.' };
};

function build(approvalPolicy?: ApprovalPolicy) {
  const store = new InMemoryAgentStore();
  const sink = new InProcessTokenStreamSink();
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'refund',
      kind: 'action',
      description: 'refund an order',
      inputSchema: z.object({ id: z.number() }),
      roles: ['ADMIN'],
    },
    { execute: async () => ({ refunded: true }) },
  );
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(refundOnce),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
  });
  const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
  return { service, store };
}

/** Run one turn, answering each approval frame with `decide`, and return the agent-protocol events. */
async function turn(
  g: ReturnType<typeof build>,
  message: string,
  decide?: (frame: Extract<StreamFrame, { t: 'approval' }>, runId: string) => Promise<void>,
  threadId?: string,
) {
  const started = await g.service.chat({
    actor,
    message,
    ...(threadId !== undefined ? { threadId } : {}),
  });
  const encoder = new AgentSseEncoder();
  const events: AgentStreamEvent[] = [];
  for await (const frame of g.service.subscribe(started.runId)) {
    const sse = encoder.encode(frame);
    for (const chunk of sse.split('\n\n')) {
      const data = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined && !chunk.startsWith('event:')) {
        events.push(JSON.parse(data.slice(6)) as AgentStreamEvent);
      }
    }
    if (frame.t === 'approval' && decide !== undefined) {
      // The frame is written just before the run parks on the decision; a person is never faster.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await decide(frame, started.runId);
    }
  }
  return { ...started, events };
}

const approvalFrames = (events: AgentStreamEvent[]) =>
  events.filter(
    (event) => event.kind.startsWith('approval') || event.kind.startsWith('tool-output'),
  );

describe('approvals v2 in the loop', () => {
  it('records who decided and through what, and remembers the tool for the thread', async () => {
    const g = build();
    const first = await turn(g, 'refund 7', (frame, runId) =>
      g.service.approve(runId, frame.id, { executedByRef: 'u1', remember: true, via: 'web' }),
    );
    expect(approvalFrames(first.events)).toEqual([
      expect.objectContaining({
        kind: 'approval-requested',
        id: 'call-0-refund',
        approver: 'requester',
      }),
      {
        kind: 'approval-settled',
        id: 'call-0-refund',
        status: 'approved',
        decidedBy: 'u1',
        decidedVia: 'web',
        remember: true,
      },
      { kind: 'tool-output', id: 'call-0-refund', output: { refunded: true } },
    ]);

    // Same tool, same thread: nobody is asked again.
    const second = await turn(g, 'and refund 7 again', undefined, first.threadId);
    const settled = approvalFrames(second.events);
    expect(settled.some((event) => event.kind === 'approval-requested')).toBe(false);
    expect(settled[0]).toEqual({
      kind: 'approval-settled',
      id: expect.any(String),
      status: 'approved',
      approver: 'requester',
      decidedBy: 'u1',
      decidedVia: 'remembered',
      remember: true,
    });

    const thread = await g.store.getThread(first.threadId);
    const approvals = thread?.messages.flatMap((message) => message.approvals ?? []);
    expect(approvals?.map((approval) => approval.decidedVia)).toEqual(['web', 'remembered']);
  });

  it('expires a request nobody answers, and tells the model nobody approved it', async () => {
    const g = build(approvalRules({ ttlMs: 30 }));
    const { events, threadId } = await turn(g, 'refund 7');
    const requested = events.find((event) => event.kind === 'approval-requested');
    expect(requested).toMatchObject({ approver: 'requester', expiresAt: expect.any(String) });
    expect(approvalFrames(events).slice(1)).toEqual([
      { kind: 'approval-settled', id: 'call-0-refund', status: 'expired' },
      { kind: 'tool-output-denied', id: 'call-0-refund', reason: 'approval expired' },
    ]);
    const thread = await g.store.getThread(threadId);
    expect(thread?.messages.flatMap((message) => message.approvals ?? [])).toEqual([
      expect.objectContaining({
        toolCallId: 'call-0-refund',
        status: 'expired',
        approver: 'requester',
      }),
    ]);
    expect(await g.store.toolCallApproval('call-0-refund')).toMatchObject({ status: 'expired' });
  });

  it('runs an action the policy does not gate without asking anyone', async () => {
    const g = build(approvalRules({ tools: { refund: { required: false } } }));
    const { events } = await turn(g, 'refund 7');
    expect(approvalFrames(events)).toEqual([
      { kind: 'tool-output', id: 'call-0-refund', output: { refunded: true } },
    ]);
  });

  it('streams a rejection with who declined it and why', async () => {
    const g = build();
    const { events } = await turn(g, 'refund 7', (frame, runId) =>
      g.service.reject(runId, frame.id, 'wrong order', { executedByRef: 'u1', via: 'slack' }),
    );
    expect(approvalFrames(events).slice(1)).toEqual([
      {
        kind: 'approval-settled',
        id: 'call-0-refund',
        status: 'rejected',
        decidedBy: 'u1',
        decidedVia: 'slack',
        reason: 'wrong order',
      },
      { kind: 'tool-output-denied', id: 'call-0-refund', reason: 'wrong order' },
    ]);
  });
});

describe('approvals v2 over HTTP', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });

  const refund = defineTool(
    {
      name: 'refund',
      kind: 'action',
      description: 'refund an order',
      input: z.object({ id: z.number() }),
      roles: ['ADMIN', 'USER'],
    },
    () => ({ refunded: true }),
  );
  const headers = (id: string, roles: string) => ({
    'content-type': 'application/json',
    'x-actor-id': id,
    'x-actor-roles': roles,
  });

  it('enforces a role approver: 403 for the requester, 200 for a holder of the role', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(refundOnce),
      streamProtocol: 'agent',
      tools: [refund],
      approvalPolicy: { tools: { refund: { approver: 'FINANCE' } } },
    });
    const url = booted.url;
    const statuses: number[] = [];
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers('u1', 'USER'),
      body: JSON.stringify({ message: 'refund 7' }),
    });
    await readSse(response, async (frame) => {
      if (frame.data.kind !== 'approval-requested') return;
      expect(frame.data.approver).toBe('FINANCE');
      for (const [id, roles] of [
        ['u1', 'USER'],
        ['boss', 'FINANCE'],
      ] as const) {
        const decided = await fetch(`${url}/agent/tool-call/approve`, {
          method: 'POST',
          headers: headers(id, roles),
          body: JSON.stringify({ toolCallId: frame.data.id, via: 'console' }),
        });
        statuses.push(decided.status);
      }
    });
    expect(statuses).toEqual([403, 200]);
  });

  it('answers 410 on a lapsed request and 400 on a malformed decision', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(refundOnce),
      streamProtocol: 'agent',
      tools: [refund],
      approvalPolicy: { ttlMs: 20 },
    });
    const url = booted.url;
    let callId = '';
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers('u1', 'USER'),
      body: JSON.stringify({ message: 'refund 7' }),
    });
    await readSse(response, async (frame) => {
      if (frame.data.kind === 'approval-requested') callId = String(frame.data.id);
    });
    const malformed = await fetch(`${url}/agent/tool-call/approve`, {
      method: 'POST',
      headers: headers('u1', 'USER'),
      body: JSON.stringify({ toolCallId: callId, remember: 'yes' }),
    });
    expect(malformed.status).toBe(400);
    const late = await fetch(`${url}/agent/tool-call/approve`, {
      method: 'POST',
      headers: headers('u1', 'USER'),
      body: JSON.stringify({ toolCallId: callId }),
    });
    expect(late.status).toBe(410);
  });
});
