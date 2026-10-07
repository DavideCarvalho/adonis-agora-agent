import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelTurnService,
  channels,
  type InboundMessage,
  type OutboundMessage,
  proposalButtonIds,
  telegram,
} from '../src/channels/index.js';
import {
  ActionProposalWorker,
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  defineTool,
  ptBrActionProposalText,
} from '../src/index.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

// ── fakes ──────────────────────────────────────────────────────────────────────

function makeCtx(body: unknown, opts: { headers?: Record<string, string>; method?: string } = {}) {
  const headers = { 'x-ok': '1', ...opts.headers };
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const ctx = {
    request: {
      method: () => opts.method ?? 'POST',
      url: () => '/webhooks/test',
      header: (name: string) => headers[name.toLowerCase() as keyof typeof headers],
      body: () => body,
      raw: () => JSON.stringify(body),
    },
    params: {},
    response: {
      status(code: number) {
        sent.status = code;
        return this;
      },
      header() {
        return this;
      },
      send(value: unknown) {
        sent.body = value;
      },
    },
    containerResolver: {
      make: async () => {
        throw new Error('no container in this test');
      },
    },
  };
  return { ctx: ctx as never, sent };
}

function fakeAdapter(capabilities: Partial<ChannelCapabilities> = {}) {
  const outbox: { conversation: string; message: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    name: 'test',
    capabilities: { markdown: 'whatsapp', maxLength: 4096, ...capabilities },
    verify: (request) => request.header('x-ok') === '1',
    parse: (body) => body as InboundMessage,
    send: async (conversation, message) => {
      outbox.push({ conversation, message });
    },
  };
  return { adapter, outbox };
}

const inbound = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `m-${Math.random()}`,
  from: '5511999990000',
  conversation: 'chat-1',
  text,
  raw: {},
  ...extra,
});

interface FakeService extends ChannelTurnService {
  sends: any[];
  decided: any[];
  skipped: any[];
  subscribed: string[];
}

function fakeService(
  frames: StreamFrame[] | ((runId: string) => AsyncIterable<StreamFrame>),
  overrides: Partial<ChannelTurnService> = {},
): FakeService {
  const service: FakeService = {
    sends: [],
    decided: [],
    skipped: [],
    subscribed: [],
    send: async (params) => {
      service.sends.push(params);
      return { runId: 'run-1', threadId: params.threadId ?? 'thread-new' };
    },
    subscribe: (runId) => {
      service.subscribed.push(runId);
      if (typeof frames === 'function') return frames(runId);
      return (async function* () {
        yield* frames;
      })();
    },
    skip: async (args) => {
      service.skipped.push(args);
    },
    cancel: async () => {},
    actionProposalReply: (result, decision) =>
      result.status === 'applied' ? `${decision}!` : `could not: ${result.status}`,
    ...overrides,
  } as FakeService;
  return service;
}

const texts = (outbox: { message: OutboundMessage }[]) => outbox.map((item) => item.message.text);

const actor = { id: 'u1', roles: [] };

// ── the route ──────────────────────────────────────────────────────────────────

describe('channels.handle', () => {
  it('refuses an unverified request and acknowledges a verified one before the turn ends', async () => {
    const { adapter, outbox } = fakeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService(async function* () {
      yield { t: 'text', v: 'Hello ' };
      await gate;
      yield { t: 'text', v: '**there**' };
    });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 'thread-1',
    });

    const refused = makeCtx(inbound('hi'), { headers: { 'x-ok': '0' } });
    await handle(refused.ctx);
    expect(refused.sent.status).toBe(401);

    const accepted = makeCtx(inbound('hi'));
    await handle(accepted.ctx);
    expect(accepted.sent).toEqual({ status: 200, body: { ok: true } });
    expect(outbox).toEqual([]);
    release();
    await handle.drain();
    expect(outbox).toEqual([{ conversation: 'chat-1', message: { text: 'Hello *there*' } }]);
    expect(service.sends[0]).toMatchObject({
      actor,
      threadId: 'thread-1',
      message: 'hi',
      uiCapabilities: { components: [] },
      pageContext: { kind: 'test' },
      hostContext: { channel: 'test', conversation: 'chat-1' },
    });
  });

  it('answers a duplicate delivery once', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'once' }]);
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    const message = inbound('hi', { id: 'same' });
    await handle(makeCtx(message).ctx);
    await handle(makeCtx(message).ctx);
    await handle.drain();
    expect(service.sends).toHaveLength(1);
    expect(texts(outbox)).toEqual(['once']);
  });

  it('splits a long reply at the channel limit, keeping component fallback text in order', async () => {
    const { adapter, outbox } = fakeAdapter({ maxLength: 40 });
    const service = fakeService([
      { t: 'text', v: 'First paragraph of the answer.' },
      { t: 'component', name: 'OrderSummary', data: {}, fallbackText: '*Order A-1* — paid' },
      { t: 'text', v: 'And a closing sentence here.' },
    ]);
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual([
      'First paragraph of the answer.',
      '*Order A-1* — paid',
      'And a closing sentence here.',
    ]);
  });

  it('creates a thread for a new conversation and reports it', async () => {
    const { adapter } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'hi' }]);
    const created: string[] = [];
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => null,
      onThreadCreated: (threadId) => {
        created.push(threadId);
      },
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(service.sends[0].threadId).toBeUndefined();
    expect(created).toEqual(['thread-new']);
  });

  it('does not answer an unknown sender — or says so when told to', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([]);
    const silent = channels.handle(adapter, { service, actor: () => null, thread: () => 't' });
    await silent(makeCtx(inbound('hi')).ctx);
    await silent.drain();
    expect(outbox).toEqual([]);
    const polite = channels.handle(adapter, {
      service,
      actor: () => null,
      thread: () => 't',
      texts: { unknownSender: 'Link your account first.' },
    });
    await polite(makeCtx(inbound('hi')).ctx);
    await polite.drain();
    expect(texts(outbox)).toEqual(['Link your account first.']);
    expect(service.sends).toEqual([]);
  });

  it('relays a text decision reply without starting a turn', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([], {
      send: async () => ({
        threadId: 't',
        proposalDecision: { status: 'applied' },
        text: 'Proposal approved and queued to run.',
      }),
    });
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('yes')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['Proposal approved and queued to run.']);
    expect(service.subscribed).toEqual([]);
  });

  it('follows a queued message under its own id', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'later' }], {
      send: async () => ({
        threadId: 't',
        queued: true,
        messageId: 'queued-1',
        position: 0,
        queue: { items: [] } as never,
      }),
    });
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('second')).ctx);
    await handle.drain();
    expect(service.subscribed).toEqual(['queued-1']);
    expect(texts(outbox)).toEqual(['later']);
  });

  const proposalFrames: StreamFrame[] = [
    { t: 'text', v: 'I prepared the refund.' },
    {
      t: 'approval',
      runId: 'run-1',
      id: 'call-1',
      toolName: 'refund',
      input: {},
      target: { kind: 'proposal', proposalId: `proposal-${'a'.repeat(64)}` },
      confirmation: { title: 'Refund order A-1?', verb: 'Refund', detail: 'Amount: 10.00' },
    },
  ];

  it('puts a pending proposal to the person with buttons where the channel has them', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService(proposalFrames);
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('refund A-1')).ctx);
    await handle.drain();
    const ids = proposalButtonIds(`proposal-${'a'.repeat(64)}`);
    expect(outbox.map((item) => item.message)).toEqual([
      { text: 'I prepared the refund.' },
      {
        text: '*Refund order A-1?*\nAmount: 10.00',
        buttons: [
          { id: ids.approve, label: 'Confirm' },
          { id: ids.reject, label: 'Cancel' },
        ],
        fallbackText:
          '*Refund order A-1?*\nAmount: 10.00\n\nReply *yes* to confirm or *no* to cancel.',
      },
    ]);
    // Telegram's callback_data holds 64 bytes.
    expect(Buffer.byteLength(ids.approve)).toBeLessThanOrEqual(64);
  });

  it('without buttons, tells the person what to reply — in the configured vocabulary', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService(proposalFrames, {
      actionProposalVocabulary: () => ({
        ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
        ...ptBrActionProposalText.vocabulary,
      }),
    });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      texts: {
        instruction: ({ approve, reject }) => `Responda *${approve}* ou *${reject}*.`,
      },
    });
    await handle(makeCtx(inbound('reembolso')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual([
      'I prepared the refund.',
      '*Refund order A-1?*\nAmount: 10.00\n\nResponda *sim* ou *não*.',
    ]);
  });

  it('names each proposal by #ID when the turn left several', async () => {
    const { adapter, outbox } = fakeAdapter();
    const second = {
      ...proposalFrames[1],
      id: 'call-2',
      target: { kind: 'proposal', proposalId: 'p2' },
    };
    const service = fakeService([...proposalFrames, second as StreamFrame]);
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('two refunds')).ctx);
    await handle.drain();
    expect(texts(outbox)[2]).toContain('Reply *yes #p2* to confirm or *no #p2* to cancel.');
  });

  it('maps a button press to the decision of its proposal, then relays the outcome', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const proposalId = `proposal-${'b'.repeat(64)}`;
    let polls = 0;
    const service = fakeService([], {
      listActionProposals: (async () => {
        polls += 1;
        return [
          { id: 'proposal-other', decision: 'pending' },
          {
            id: proposalId,
            decision: service.decided.length > 0 ? 'approved' : 'pending',
            execution: polls > 2 ? { status: 'succeeded' } : { status: 'queued' },
            ...(polls > 2 ? { outcome: { text: 'Refunded **10.00**.' } } : {}),
          },
        ];
      }) as never,
      decideActionProposal: (async (...args: unknown[]) => {
        service.decided.push(args);
        return { status: 'applied' };
      }) as never,
    });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 'thread-1',
      outcomeTimeoutMs: 5_000,
    });
    const ids = proposalButtonIds(proposalId);
    await handle(makeCtx(inbound('Confirm', { buttonId: ids.approve })).ctx);
    await handle.drain();
    expect(service.decided).toEqual([[actor, 'thread-1', proposalId, 'approved', {}, 'test']]);
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['approved!', 'Refunded *10.00*.']);
  }, 10_000);

  it('answers a press on a proposal it cannot find, and reads a foreign button as text', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService([{ t: 'text', v: 'ok' }], {
      listActionProposals: (async () => []) as never,
      decideActionProposal: (async () => ({ status: 'applied' })) as never,
    });
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('Cancel', { buttonId: proposalButtonIds('gone').reject })).ctx);
    await handle(makeCtx(inbound('Menu', { buttonId: 'menu:1' })).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['could not: not_found', 'ok']);
    expect(service.sends.map((send) => send.message)).toEqual(['Menu']);
  });

  it('blocking mode: sends what it has and says the approval is in the app', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService(async function* () {
      yield { t: 'text', v: 'Refunding.' };
      yield { t: 'approval', runId: 'run-1', id: 'call-1', toolName: 'refund', input: {} };
      // the stream stays open until someone decides
      await new Promise(() => {});
    });
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('refund')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual([
      'Refunding.',
      'This action needs an approval that can only be given in the app.',
    ]);
  });

  it('skips a question form, and says when the turn failed', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([
      { t: 'elicitation', runId: 'run-1', id: 'ask-1', request: { questions: [] } as never },
      { t: 'error', code: 'run_failed', message: 'boom' },
    ]);
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(service.skipped).toEqual([
      { runId: 'run-1', toolCallId: 'ask-1', answeredByRef: 'u1', answeredVia: 'test' },
    ]);
    expect(texts(outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
  });

  it('gives up on a turn after timeoutMs and cancels it', async () => {
    const { adapter, outbox } = fakeAdapter();
    const cancelled: string[] = [];
    const service = fakeService(
      async function* () {
        yield { t: 'text', v: 'Partial' };
        await new Promise(() => {});
      },
      {
        cancel: async (runId: string) => {
          cancelled.push(runId);
        },
      },
    );
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      timeoutMs: 50,
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(cancelled).toEqual(['run-1']);
    expect(texts(outbox)).toEqual(['Partial']);
  });

  it('reports a failing message to onError', async () => {
    const { adapter } = fakeAdapter();
    const errors: unknown[] = [];
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      actor: () => {
        throw new Error('directory down');
      },
      thread: () => 't',
      onError: (error) => errors.push(error),
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(errors).toEqual([new Error('directory down')]);
  });
});

// ── against the real agent ──────────────────────────────────────────────────────

describe('channels.handle over a booted app (independent approvals, Telegram)', () => {
  let app: BootedApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs a turn, offers the proposal as buttons, and executes it on the press', async () => {
    const store = new InMemoryAgentStore();
    let refunds = 0;
    const refund = defineTool(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        input: z.object({ order: z.string() }),
      },
      ({ order }) => {
        refunds += 1;
        return { refunded: order };
      },
    );
    const outbox: { method: string; body: any }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      outbox.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof globalThis.fetch;
    const adapter = telegram({ botToken: '1:x', secretToken: 'tg', fetch });
    const threads = new Map<string, string>();
    let handle!: ReturnType<typeof channels.handle>;

    app = await bootAgentApp(
      {
        model: new FakeModelProvider((args, turn) =>
          turn === 0
            ? {
                text: 'I prepared the **refund**.',
                toolCall: { name: 'refund', input: { order: 'A-1' } },
              }
            : { text: String(args.messages.at(-1)?.content).includes('refund') ? 'Done.' : 'ok' },
        ),
        tools: [refund],
        store: 'test',
        stores: { test: async () => store },
        actionApprovalMode: 'independent',
        backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef, roles: [] }) },
        actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
      },
      {
        routes: (router) => {
          handle = channels.handle(adapter, {
            actor: (message) => ({ id: `tg:${message.from}`, roles: [] }),
            thread: (_actor, message) => threads.get(message.conversation),
            onThreadCreated: (threadId, _actor, message) => {
              threads.set(message.conversation, threadId);
            },
            outcomeTimeoutMs: 5_000,
          });
          router.post('/webhooks/telegram', handle);
        },
      },
    );

    const post = (update: unknown, secret = 'tg') =>
      globalThis.fetch(`${app!.url}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(update),
      });
    const chat = { id: 42, type: 'private' };

    expect((await post({ update_id: 1 }, 'wrong')).status).toBe(401);

    const first = await post({
      update_id: 10,
      message: { message_id: 1, chat, from: { id: 42 }, text: 'refund A-1' },
    });
    expect(first.status).toBe(200);
    await handle.drain();
    expect(refunds).toBe(0);
    expect(outbox.map((item) => item.body.text)).toEqual([
      'I prepared the *refund*\\.',
      expect.stringContaining('refund'),
    ]);
    const keyboard = outbox[1]!.body.reply_markup.inline_keyboard[0];
    expect(keyboard.map((button: { text: string }) => button.text)).toEqual(['Confirm', 'Cancel']);

    // Telegram retries the same update: nothing runs twice.
    await post({
      update_id: 10,
      message: { message_id: 1, chat, from: { id: 42 }, text: 'refund A-1' },
    });
    await handle.drain();
    expect(outbox).toHaveLength(2);

    outbox.length = 0;
    await post({
      update_id: 11,
      callback_query: {
        id: 'cq',
        from: { id: 42 },
        data: keyboard[0].callback_data,
        message: { message_id: 2, chat, reply_markup: { inline_keyboard: [keyboard] } },
      },
    });
    // The app's proposal worker (started on `ready`, which this harness does not reach).
    const worker = await app.app.container.make(ActionProposalWorker);
    for (let attempt = 0; attempt < 200 && refunds === 0; attempt++) {
      await worker.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handle.drain();
    expect(refunds).toBe(1);
    expect(outbox.map((item) => item.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
      'sendMessage',
      'sendMessage',
    ]);
    expect(outbox[2]!.body.text).toBe('Proposal approved and queued to run\\.');
    // the outcome the proposal settled with, relayed once it ran
    expect(outbox[3]!.body.text).toBe('Done\\.');
    const proposals = await store.listActionProposals({
      actorRef: 'tg:42',
      tenantRef: null,
      threadId: threads.get('42')!,
    });
    expect(proposals[0]).toMatchObject({
      decision: 'approved',
      decisionAudit: expect.objectContaining({ via: 'telegram' }),
    });
  }, 20_000);
});
