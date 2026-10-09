import { A2uiMessageSchema } from '@a2ui/web_core/v0_9';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_LEGACY_BASIC_CATALOG_ID,
  a2uiAdapter,
} from '../src/a2ui/index.js';
import { agUiAdapter, encodeInterruptId } from '../src/ag-ui/index.js';
import { Card, KpiCards } from '../src/genui/builtins.js';
import { defineCatalog, genui } from '../src/genui/index.js';
import { type AgentConfig, defineTool } from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { assertConforms } from './helpers/ag-ui.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

/**
 * `POST /agent/a2ui` over real HTTP: a JSON Lines stream of A2UI v0.9 messages (checked against the
 * official schema of `@a2ui/web_core`), actions in, approvals decided by an A2UI button. And the
 * AG-UI route with `a2ui: true`, read by AG-UI's own client.
 */

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

const catalog = defineCatalog([Card, KpiCards]);
const tree = {
  type: 'Card',
  props: { title: 'Sales' },
  children: [{ type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k' }] } }],
};

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

/** The last user message, as the model sees it. */
function lastUser(args: Parameters<FakeScript>[0]): string {
  const user = [...args.messages].reverse().find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
}

function boot(script: FakeScript, extra: Partial<AgentConfig> = {}): Promise<BootedApp> {
  return bootAgentApp({
    model: new FakeModelProvider(script),
    genui: genui({ catalog }),
    adapters: [a2uiAdapter({ quietMs: 80 }), agUiAdapter({ quietMs: 80, a2ui: true })],
    ...extra,
  });
}

async function a2ui(url: string, body: unknown, actor = 'u1') {
  const response = await fetch(`${url}/agent/a2ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-id': actor },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const messages =
    response.status === 200
      ? raw
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, Record<string, unknown>>)
      : [];
  for (const message of messages) {
    const result = A2uiMessageSchema.safeParse(message);
    if (!result.success) throw new Error(`invalid A2UI message: ${JSON.stringify(message)}`);
  }
  return { response, messages, raw };
}

describe('a2uiAdapter()', () => {
  it('streams a turn as A2UI JSON Lines: the UI as a surface, the text as a bound one', async () => {
    booted = await boot((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'ui__render', input: tree } }
        : { text: 'There you go.' },
    );
    const { response, messages } = await a2ui(booted.url, { message: 'dashboard please' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/jsonl');
    expect(response.headers.get('x-agent-thread-id')).toBeTruthy();
    const ui = messages.filter(
      (message) =>
        (message.createSurface ?? message.updateComponents)?.surfaceId === 'call-0-ui__render:ui:0',
    );
    expect(ui.map((message) => Object.keys(message)[1])).toEqual([
      'createSurface',
      'updateComponents',
    ]);
    const components = ui[1]?.updateComponents?.components as { id: string; component: string }[];
    expect(components[0]).toMatchObject({ id: 'root', component: 'Card' });
    expect(JSON.stringify(components)).toContain('Revenue');
    const text = messages.filter((message) => message.updateDataModel !== undefined).at(-1);
    expect(text?.updateDataModel).toMatchObject({ path: '/text', value: 'There you go.' });
  });

  it('takes an A2UI action as the next turn, on the same thread', async () => {
    booted = await boot((args) => ({ text: `heard: ${lastUser(args)}` }));
    const first = await a2ui(booted.url, { message: 'hi' });
    const threadId = first.response.headers.get('x-agent-thread-id') as string;
    const { messages } = await a2ui(booted.url, {
      threadId,
      action: {
        version: 'v0.9',
        action: {
          name: 'refund',
          surfaceId: 's1',
          sourceComponentId: 'root.0',
          timestamp: new Date().toISOString(),
          context: { orderId: '7' },
        },
      },
    });
    const said = String(messages.filter((m) => m.updateDataModel).at(-1)?.updateDataModel?.value);
    expect(said).toContain('UI action "refund"');
    expect(said).toContain('"orderId": "7"');

    const bad = await a2ui(booted.url, {
      action: { action: { name: 'x', context: { blob: 'y'.repeat(9000) } } },
    });
    expect(bad.response.status).toBe(400);
    const intruder = await a2ui(booted.url, { threadId, message: 'mine now' }, 'u2');
    expect([403, 404]).toContain(intruder.response.status);
  });

  it('ends on an approval with Approve / Reject buttons, and the Approve action continues the run', async () => {
    booted = await boot(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
          : { text: 'Refunded.' },
      { tools: [refund] },
    );
    const first = await a2ui(booted.url, { message: 'refund 7' });
    const buttons = first.messages
      .flatMap(
        (message) => (message.updateComponents?.components as Record<string, unknown>[]) ?? [],
      )
      .filter((component) => component.component === 'Button');
    expect(buttons).toHaveLength(2);
    const approve = buttons[0]?.action as {
      event: { name: string; context: { interruptId: string } };
    };
    expect(approve.event.name).toBe('agora.approve');

    const second = await a2ui(booted.url, {
      action: {
        version: 'v0.9',
        action: {
          name: 'agora.approve',
          surfaceId: 'x',
          sourceComponentId: 'approve',
          timestamp: new Date().toISOString(),
          context: approve.event.context,
        },
      },
    });
    expect(second.response.status).toBe(200);
    const said = second.messages.filter((m) => m.updateDataModel).at(-1)?.updateDataModel?.value;
    expect(said).toBe('Refunded.');
    // Someone else's approval is not theirs to decide.
    const again = await a2ui(
      booted.url,
      { action: { name: 'agora.approve', context: approve.event.context } },
      'u2',
    );
    expect(again.response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a2uiAdapter(): the client's catalogs, its data model, a reopened thread", () => {
  const createdWith = (messages: Record<string, Record<string, unknown>>[]) =>
    messages.flatMap((message) =>
      message.createSurface !== undefined ? [message.createSurface.catalogId] : [],
    );

  it('creates surfaces under the basic catalog id the client advertises', async () => {
    booted = await boot((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'ui__render', input: tree } }
        : { text: 'There you go.' },
    );
    const plain = await a2ui(booted.url, { message: 'dashboard' });
    expect(new Set(createdWith(plain.messages))).toEqual(new Set([A2UI_BASIC_CATALOG_ID]));
    const legacy = await a2ui(booted.url, {
      message: 'dashboard',
      metadata: {
        a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [A2UI_LEGACY_BASIC_CATALOG_ID] } },
      },
    });
    expect(new Set(createdWith(legacy.messages))).toEqual(new Set([A2UI_LEGACY_BASIC_CATALOG_ID]));
  });

  it('hands a2uiClientDataModel to the prompt builder', async () => {
    const seen: unknown[] = [];
    booted = await boot(() => ({ text: 'ok' }), {
      defaultAgent: {
        systemPrompt: (ctx) => {
          seen.push(ctx.pageContext?.a2uiDataModel);
          return 'You help.';
        },
      },
    });
    const { response } = await a2ui(booted.url, {
      message: 'what did I type?',
      a2uiClientDataModel: { version: 'v0.9', surfaces: { s1: { name: 'Ada' } } },
    });
    expect(response.status).toBe(200);
    expect(seen).toContainEqual({ s1: { name: 'Ada' } });
    const bad = await a2ui(booted.url, { message: 'x', a2uiClientDataModel: { surfaces: 3 } });
    expect(bad.response.status).toBe(400);
  });

  it('answers a stored thread as A2UI for a reload, owner-scoped', async () => {
    booted = await boot((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'ui__render', input: tree } }
        : { text: 'There you go.' },
    );
    const first = await a2ui(booted.url, { message: 'dashboard' });
    const threadId = first.response.headers.get('x-agent-thread-id') as string;
    const get = (actor: string) =>
      fetch(`${booted?.url}/agent/a2ui/threads/${threadId}`, { headers: { 'x-actor-id': actor } });
    const response = await get('u1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      threadId: string;
      entries: { role: string; text?: string; messages?: Record<string, unknown>[] }[];
    };
    expect(body.threadId).toBe(threadId);
    expect(body.entries[0]).toMatchObject({ role: 'user', text: 'dashboard' });
    const surfaces = body.entries.flatMap((entry) => entry.messages ?? []);
    for (const message of surfaces) expect(A2uiMessageSchema.safeParse(message).success).toBe(true);
    expect(JSON.stringify(surfaces)).toContain('Revenue');
    expect(JSON.stringify(surfaces)).toContain('There you go.');
    expect([403, 404]).toContain((await get('u2')).status);
    const unknown = await fetch(`${booted.url}/agent/a2ui/threads/nope`, {
      headers: { 'x-actor-id': 'u1' },
    });
    expect(await unknown.json()).toEqual({ threadId: 'nope', entries: [] });
  });
});

describe('a2uiAdapter() and independent proposals', () => {
  it('decides a proposal through the proposal service and answers with its reply', async () => {
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ id: 'a2ui-proposal-thread', actor });
    await store.createActionProposal({
      id: 'proposal-a2ui',
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
      idempotencyKey: 'a2ui',
    });
    let modelCalls = 0;
    booted = await boot(
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
      proposalId: 'proposal-a2ui',
      threadId: thread.id,
    });
    const intruder = await a2ui(
      booted.url,
      { action: { name: 'agora.reject', context: { interruptId } } },
      'u2',
    );
    expect(intruder.response.status).toBeGreaterThanOrEqual(400);
    const { response, messages } = await a2ui(booted.url, {
      action: { name: 'agora.reject', context: { interruptId } },
    });
    expect(response.status).toBe(200);
    expect(modelCalls).toBe(0);
    expect(messages.some((message) => message.updateDataModel !== undefined)).toBe(true);
    const decided = await store.getActionProposal(
      { threadId: thread.id, actorRef: actor.id, tenantRef: null },
      'proposal-a2ui',
    );
    expect(decided?.decision).toBe('rejected');
    expect(decided?.decisionAudit?.via).toBe('a2ui');
  });
});

describe('agUiAdapter({ a2ui: true })', () => {
  async function run(client: HttpAgent, parameters: Parameters<HttpAgent['runAgent']>[0] = {}) {
    const events: BaseEvent[] = [];
    await client.runAgent(parameters, { onEvent: ({ event }) => void events.push(event) });
    return events;
  }

  it('sends each ui frame as an a2ui-surface activity too, and conforms', async () => {
    booted = await boot((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'ui__render', input: tree } } : { text: 'Done.' },
    );
    const client = new HttpAgent({
      url: `${booted.url}/agent/ag-ui`,
      headers: { 'x-actor-id': 'u1' },
    });
    client.addMessage({ id: 'm1', role: 'user', content: 'dashboard' });
    const events = await run(client);
    await assertConforms(events as never);
    const activity = events.find((event) => event.type === 'ACTIVITY_SNAPSHOT') as unknown as {
      activityType: string;
      content: { a2ui_operations: unknown[] };
    };
    expect(activity.activityType).toBe('a2ui-surface');
    for (const message of activity.content.a2ui_operations) {
      expect(A2uiMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("uses the AG-UI binding's basic catalog id, unless the client advertises another", async () => {
    booted = await boot((_args, turn) =>
      turn % 2 === 0
        ? { text: '', toolCall: { name: 'ui__render', input: tree } }
        : { text: 'Done.' },
    );
    const client = new HttpAgent({
      url: `${booted.url}/agent/ag-ui`,
      headers: { 'x-actor-id': 'u1' },
    });
    const catalogOf = (events: BaseEvent[]) => {
      const activity = events.find((event) => event.type === 'ACTIVITY_SNAPSHOT') as unknown as {
        content: { a2ui_operations: { createSurface?: { catalogId: string } }[] };
      };
      return activity.content.a2ui_operations[0]?.createSurface?.catalogId;
    };
    client.addMessage({ id: 'm1', role: 'user', content: 'dashboard' });
    expect(catalogOf(await run(client))).toBe(A2UI_LEGACY_BASIC_CATALOG_ID);
    client.addMessage({ id: 'm2', role: 'user', content: 'again' });
    const advertised = await run(client, {
      forwardedProps: {
        a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [A2UI_BASIC_CATALOG_ID] } },
      },
    });
    expect(catalogOf(advertised)).toBe(A2UI_BASIC_CATALOG_ID);
  });

  it('starts a turn from forwardedProps.a2uiAction, without a new user message', async () => {
    booted = await boot((args) => ({ text: `heard: ${lastUser(args)}` }));
    const client = new HttpAgent({
      url: `${booted.url}/agent/ag-ui`,
      headers: { 'x-actor-id': 'u1' },
    });
    client.addMessage({ id: 'm1', role: 'user', content: 'hello' });
    await run(client);
    const events = await run(client, {
      forwardedProps: {
        a2uiAction: { userAction: { name: 'split', surfaceId: 's', context: { people: 3 } } },
      },
    });
    const said = events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => (event as unknown as { delta: string }).delta)
      .join('');
    expect(said).toContain('UI action "split"');
    expect(said).toContain('"people": 3');
  });
});
