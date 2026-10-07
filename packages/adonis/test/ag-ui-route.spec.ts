import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent, Interrupt, RunAgentInput } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgUiEvent,
  agUiAdapter,
  decodeInterruptId,
  encodeInterruptId,
} from '../src/ag-ui/index.js';
import { type AgentConfig, AgentService, attachmentStores, defineTool } from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { assertConforms, assertInputSchema } from './helpers/ag-ui.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

/**
 * `POST /agent/ag-ui` over real HTTP, read by the protocol's own first-party client (`HttpAgent`
 * from `@ag-ui/client`): what it accepts, how it assembles the messages, and the interrupt → resume
 * round-trip it drives.
 */

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

function bootApp(script: FakeScript, extra: Partial<AgentConfig> = {}): Promise<BootedApp> {
  return bootAgentApp({
    model: new FakeModelProvider(script),
    adapters: [agUiAdapter({ quietMs: 80 })],
    ...extra,
  });
}

const refund = defineTool(
  {
    name: 'refund',
    kind: 'action',
    description: 'refund an order',
    input: z.object({ id: z.number() }),
    roles: ['ADMIN'],
  },
  () => ({ refunded: true }),
);

function agent(url: string, actor = 'u1', threadId: string = crypto.randomUUID()): HttpAgent {
  return new HttpAgent({ url: `${url}/agent/ag-ui`, headers: { 'x-actor-id': actor }, threadId });
}

/** Run the agent once, keeping every event the client accepted. */
async function run(
  client: HttpAgent,
  text: string | null,
  parameters: Parameters<HttpAgent['runAgent']>[0] = {},
): Promise<{ events: AgUiEvent[]; interrupts: Interrupt[] }> {
  if (text !== null) client.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
  const events: BaseEvent[] = [];
  await client.runAgent(parameters, { onEvent: ({ event }) => void events.push(event) });
  const finished = events.find((event) => event.type === 'RUN_FINISHED') as
    | { outcome?: { type: string; interrupts?: Interrupt[] } }
    | undefined;
  return {
    events: events as unknown as AgUiEvent[],
    interrupts: finished?.outcome?.interrupts ?? [],
  };
}

function post(url: string, body: unknown, actor = 'u1'): Promise<Response> {
  return fetch(`${url}/agent/ag-ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-id': actor },
    body: JSON.stringify(body),
  });
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    protocolVersion: '1.0',
    messages: [{ id: 'm1', role: 'user', content: 'hi' }],
    ...overrides,
  } as RunAgentInput;
}

describe('POST /agent/ag-ui', () => {
  it('mounts where the adapter says', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: 'hi' })),
      adapters: [agUiAdapter({ path: 'copilot' })],
    });
    expect((await post(booted.url, input())).status).toBe(404);
    const response = await fetch(`${booted.url}/agent/copilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(200);
    await readSse(response);
  });

  it('is not mounted unless the config asks for it', async () => {
    booted = await bootAgentApp({ model: new FakeModelProvider(() => ({ text: 'hi' })) });
    expect((await post(booted.url, input())).status).toBe(404);
  });

  it('answers a run the first-party client accepts and assembles', async () => {
    booted = await bootApp(() => ({ text: 'Hello there' }));
    const client = agent(booted.url);
    const { events } = await run(client, 'hi');
    await assertConforms(events);
    expect(events[0]).toMatchObject({
      type: 'RUN_STARTED',
      threadId: client.threadId,
      protocolVersion: '1.0',
    });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', threadId: client.threadId });
    expect(events.at(-1)).not.toHaveProperty('outcome');
    expect(client.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there'],
    ]);
  });

  it('continues the thread the consumer named, and keeps it to its owner', async () => {
    const seen: number[] = [];
    booted = await bootApp((args) => {
      seen.push(args.messages.length);
      return { text: 'ok' };
    });
    const client = agent(booted.url);
    await run(client, 'first');
    await run(client, 'second');
    // the second turn ran on the stored history of the SAME thread
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
    const service = await booted.app.container.make(AgentService);
    expect(await service.threadOwner(client.threadId)).toBe('u1');
    expect((await service.listThreads('u1')).map((thread) => thread.id)).toEqual([client.threadId]);

    const intruder = await post(booted.url, input({ threadId: client.threadId }), 'u2');
    expect([403, 404]).toContain(intruder.status);
  });

  it('ends on an approval with the interrupt outcome, and a resume approves it', async () => {
    booted = await bootApp(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
          : { text: 'Done.' },
      { tools: [refund] },
    );
    const client = agent(booted.url);
    const first = await run(client, 'refund 7');
    await assertConforms(first.events);
    expect(first.interrupts).toHaveLength(1);
    const interrupt = first.interrupts[0] as Interrupt;
    expect(interrupt).toMatchObject({ reason: 'tool_approval', toolCallId: 'call-0-refund' });
    expect(first.events.some((event) => event.type === 'TOOL_CALL_RESULT')).toBe(false);

    const second = await run(client, null, {
      resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
    });
    await assertConforms(second.events);
    expect(second.interrupts).toEqual([]);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'call-0-refund',
        content: '{"refunded":true}',
      }),
    );
    expect(client.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Done.' });
    // usage follows the run boundary: the resumed run reports only its own model call
    const usage = (second.events.at(-1) as { usage?: { inputTokens?: number }[] }).usage;
    expect(usage).toHaveLength(1);
  });

  it('a resume that declines feeds the refusal back to the model', async () => {
    const outputs: unknown[] = [];
    booted = await bootApp(
      (args, turn) => {
        if (turn === 0) return { text: '', toolCall: { name: 'refund', input: { id: 7 } } };
        outputs.push(args.messages.at(-1)?.toolResults?.[0]);
        return { text: 'Understood.' };
      },
      { tools: [refund] },
    );
    const client = agent(booted.url);
    const first = await run(client, 'refund 7');
    const id = (first.interrupts[0] as Interrupt).id;
    const second = await run(client, null, {
      resume: [
        {
          interruptId: id,
          status: 'resolved',
          payload: { approved: false, reason: 'wrong order' },
        },
      ],
    });
    await assertConforms(second.events);
    const result = second.events.find((event) => event.type === 'TOOL_CALL_RESULT');
    expect(result).toMatchObject({ metadata: { 'agora.outcome': 'denied' } });
    expect(JSON.stringify(outputs[0])).toContain('wrong order');
    expect(client.messages.at(-1)).toMatchObject({ content: 'Understood.' });
  });

  it('only the owner of the interrupted run may resume it, and only while it waits', async () => {
    booted = await bootApp(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
          : { text: 'Done.' },
      { tools: [refund] },
    );
    const client = agent(booted.url);
    const first = await run(client, 'refund 7');
    const id = (first.interrupts[0] as Interrupt).id;
    const resume = [{ interruptId: id, status: 'resolved' as const, payload: true }];

    const intruder = await post(booted.url, input({ threadId: client.threadId, resume }), 'u2');
    expect([403, 404]).toContain(intruder.status);

    const malformed = await post(
      booted.url,
      input({
        threadId: client.threadId,
        resume: [{ interruptId: id, status: 'resolved', payload: { nope: 1 } }],
      }),
    );
    expect(malformed.status).toBe(400);

    const ok = await post(booted.url, input({ threadId: client.threadId, resume }));
    expect(ok.status).toBe(200);
    await readSse(ok);
    // answered already: nothing is waiting for a second answer
    const again = await post(booted.url, input({ threadId: client.threadId, resume }));
    expect(again.status).toBe(409);
  });

  it('a resume entry for an interrupt it never raised is skipped with a warning', async () => {
    booted = await bootApp(() => ({ text: 'Hello' }));
    const response = await post(
      booted.url,
      input({ resume: [{ interruptId: 'int-1', status: 'resolved', payload: true }] }),
    );
    expect(response.status).toBe(200);
    const events = (await readSse(response)).map((frame) => frame.data) as unknown as AgUiEvent[];
    await assertConforms(events);
    expect(events).toContainEqual({
      type: 'CUSTOM',
      name: 'agora.warning',
      value: { message: 'The resume entry int-1 answers an interrupt this agent did not raise.' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
  });

  it('stages an inline image as an attachment and says what it could not use', async () => {
    const attachments: unknown[] = [];
    booted = await bootApp(
      (args) => {
        attachments.push(args.messages.at(-1)?.attachments);
        return { text: 'A cat.' };
      },
      { attachments: attachmentStores.memory() },
    );
    const body = input({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: {
                type: 'data',
                value: Buffer.from('png-bytes').toString('base64'),
                mimeType: 'image/png',
              },
              metadata: { filename: 'cat.png' },
            },
            { type: 'document', source: { type: 'url', value: 'https://example.com/a.pdf' } },
          ],
        },
      ],
    });
    assertInputSchema(body);
    const response = await post(booted.url, body);
    expect(response.status).toBe(200);
    const events = (await readSse(response)).map((frame) => frame.data) as unknown as AgUiEvent[];
    await assertConforms(events);
    expect(attachments[0]).toMatchObject([{ contentType: 'image/png', name: 'cat.png' }]);
    const warnings = events.filter(
      (event) => event.type === 'CUSTOM' && event.name === 'agora.warning',
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('url source');
  });

  it('refuses malformed input before any run starts', async () => {
    booted = await bootApp(() => ({ text: 'hi' }));
    expect((await post(booted.url, { runId: 'r', messages: [] })).status).toBe(400);
    expect((await post(booted.url, input({ messages: [] }))).status).toBe(400);
    expect(
      (await post(booted.url, input({ resume: [{ interruptId: 'x', status: 'later' } as never] })))
        .status,
    ).toBe(400);
    const noActor = await fetch(`${booted.url}/agent/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    expect(noActor.status).toBe(401);
  });

  it('reports a failed run in-stream, as RUN_ERROR', async () => {
    booted = await bootApp(() => {
      throw new Error('provider exploded');
    });
    const response = await post(booted.url, input());
    expect(response.status).toBe(200);
    const events = (await readSse(response)).map((frame) => frame.data) as unknown as AgUiEvent[];
    await assertConforms(events);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
  });

  it('mints interrupt ids that address the parked run', async () => {
    booted = await bootApp(() => ({ text: '', toolCall: { name: 'refund', input: { id: 1 } } }), {
      tools: [refund],
    });
    const { interrupts, events } = await run(agent(booted.url), 'go');
    const custom = events.find(
      (event) => event.type === 'CUSTOM' && event.name === 'agora.run',
    ) as { value: { runId: string } };
    expect(decodeInterruptId(interrupts[0]?.id)).toMatchObject({
      kind: 'approval',
      parked: custom.value.runId,
      stream: custom.value.runId,
      toolCallId: 'call-0-refund',
    });
  });
});

it('acknowledges an independent text decision over AG-UI without starting a model run', async () => {
  const store = new InMemoryAgentStore();
  const actor = { id: 'u1', roles: ['ADMIN'] };
  const thread = await store.createThread({ id: 'proposal-thread', actor });
  await store.createActionProposal({
    id: 'proposal-control',
    threadId: thread.id,
    actorRef: actor.id,
    tenantRef: null,
    originRunId: 'completed-origin',
    originMessageId: 'origin-message',
    originToolCallId: 'origin-call',
    toolName: 'refund',
    input: { id: 11 },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'control',
  });
  let modelCalls = 0;
  booted = await bootApp(
    () => {
      modelCalls++;
      return { text: 'Unexpected model run' };
    },
    {
      store: 'test',
      stores: { test: async () => store },
      actionApprovalMode: 'independent',
      backgroundActorResolver: { resolve: async () => actor },
      tools: [refund],
    },
  );
  const client = agent(booted.url, actor.id, thread.id);
  const result = await run(client, 'confirmar #proposal-control');
  expect(modelCalls).toBe(0);
  expect(result.events.map((event) => event.type)).toContain('RUN_FINISHED');
  const decisions = result.events.filter(
    (event) => event.type === 'CUSTOM' && event.name.endsWith('.action-proposal-decision'),
  );
  // The `agora.*` name, then the deprecated pre-rename one for older clients.
  expect(decisions.map((event) => (event as { name: string }).name)).toEqual([
    'agora.action-proposal-decision',
    'aviary.action-proposal-decision',
  ]);
  expect(
    (
      await store.getActionProposal(
        { threadId: thread.id, actorRef: actor.id, tenantRef: null },
        'proposal-control',
      )
    )?.decisionAudit?.via,
  ).toBe('text');
  assertConforms(result.events);
});

it('resumes a proposal interrupt through the proposal service, not by signalling the run', async () => {
  const store = new InMemoryAgentStore();
  const actor = { id: 'u1', roles: ['ADMIN'] };
  const thread = await store.createThread({ id: 'proposal-resume-thread', actor });
  await store.createActionProposal({
    id: 'proposal-resume',
    threadId: thread.id,
    actorRef: actor.id,
    tenantRef: null,
    originRunId: 'finished-origin',
    originMessageId: 'origin-message',
    originToolCallId: 'origin-call',
    toolName: 'refund',
    input: { id: 11 },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'resume',
  });
  let modelCalls = 0;
  booted = await bootApp(
    () => {
      modelCalls++;
      return { text: 'Unexpected model run' };
    },
    {
      store: 'test',
      stores: { test: async () => store },
      actionApprovalMode: 'independent',
      backgroundActorResolver: { resolve: async () => actor },
      tools: [refund],
    },
  );
  const interruptId = encodeInterruptId({
    kind: 'proposal',
    parked: 'finished-origin',
    stream: 'finished-origin',
    toolCallId: 'origin-call',
    position: 4,
    proposalId: 'proposal-resume',
    threadId: thread.id,
  });
  const response = await post(
    booted.url,
    input({
      threadId: thread.id,
      resume: [{ interruptId, status: 'resolved', payload: { approved: false, reason: 'no' } }],
    }),
  );
  expect(response.status).toBe(200);
  const events = (await readSse(response)).map((frame) => frame.data as unknown as AgUiEvent);
  expect(modelCalls).toBe(0);
  expect(
    events.find(
      (event) => event.type === 'CUSTOM' && event.name === 'agora.action-proposal-decision',
    ),
  ).toMatchObject({ value: { proposalDecision: { status: 'applied' } } });
  const decided = await store.getActionProposal(
    { threadId: thread.id, actorRef: actor.id, tenantRef: null },
    'proposal-resume',
  );
  expect(decided?.decision).toBe('rejected');
  expect(decided?.decisionAudit?.via).toBe('ag-ui');
  assertConforms(events);

  // Somebody else's proposal is refused the way the native route refuses it.
  const intruder = await post(
    booted.url,
    input({ threadId: thread.id, resume: [{ interruptId, status: 'resolved', payload: true }] }),
    'u2',
  );
  expect(intruder.status).toBe(403);
});
