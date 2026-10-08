import { describe, expect, it } from 'vitest';
import {
  type ChannelWebhookEvent,
  channels,
  InMemoryChannelStore,
  proposalButtonIds,
} from '../src/channels/index.js';
import type { ActionProposal } from '../src/spi/action-proposal-store.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx, texts } from './helpers/channels.js';

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const card = (proposalId: string, title = 'Refund order A-1?'): StreamFrame => ({
  t: 'approval',
  runId: 'run-1',
  id: `call-${proposalId}`,
  toolName: 'refund',
  input: {},
  target: { kind: 'proposal', proposalId },
  confirmation: { title, verb: 'Refund' },
});

/** A service whose proposals are listed and decided in memory. */
function proposalService(frames: StreamFrame[], proposals: { id: string; decision: string }[]) {
  const service = fakeService(frames, {
    listActionProposals: (async () => proposals) as never,
    decideActionProposal: (async (...args: unknown[]) => {
      service.decided.push(args);
      return { status: 'applied' };
    }) as never,
  });
  return service;
}

// ── processing ──────────────────────────────────────────────────────────────────

describe('processing in this process (no durable engine)', () => {
  it('handles the messages of one conversation in order, one at a time', async () => {
    const { adapter, outbox } = fakeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService((runId) =>
      (async function* () {
        if (runId === 'run-1') await gate;
        yield { t: 'text', v: `answer to ${runId}` } as StreamFrame;
      })(),
    );
    const handle = channels.handle(adapter, {
      service,
      durable: false,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('first', { id: 'a1' })).ctx);
    await handle(makeCtx(inbound('second', { id: 'a2' })).ctx);
    await handle(makeCtx(inbound('elsewhere', { id: 'b1', conversation: 'chat-2' })).ctx);
    await until(() => outbox.length === 1);
    expect(service.sends.map((send) => send.message)).toEqual(['first', 'elsewhere']);
    release();
    await handle.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-2', 'answer to run-2'],
      ['chat-1', 'answer to run-1'],
      ['chat-1', 'answer to run-3'],
    ]);
  });

  it('retries a failing phase, then reports it', async () => {
    const { adapter } = fakeAdapter();
    const errors: unknown[] = [];
    let calls = 0;
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      retry: { attempts: 2, backoffMs: 1 },
      actor: () => {
        calls += 1;
        throw new Error('directory down');
      },
      thread: () => 't',
      onError: (error) => errors.push(error),
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(calls).toBe(2);
    expect(errors).toEqual([new Error('directory down')]);
  });

  it('does not retry a refusal that retrying cannot change', async () => {
    const { adapter } = fakeAdapter();
    const errors: unknown[] = [];
    const quota = Object.assign(new Error('quota used up'), { name: 'QuotaBlockedError' });
    const service = fakeService([], {
      send: async () => {
        service.sends.push({});
        throw quota;
      },
    });
    const handle = channels.handle(adapter, {
      service,
      retry: { attempts: 3, backoffMs: 1 },
      actor: () => actor,
      thread: () => 't',
      onError: (error) => errors.push(error),
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(service.sends).toHaveLength(1);
    expect(errors).toEqual([quota]);
  });
});

// ── decisions scoped to the conversation ───────────────────────────────────────

describe('text decisions on a channel', () => {
  const delivered = `proposal-${'a'.repeat(40)}`;
  const elsewhere = `proposal-${'w'.repeat(40)}`;

  /** A conversation that was sent the card of `delivered`; `elsewhere` was proposed on the web. */
  async function conversation(
    pending: string[],
    options: { allowRemember?: boolean; card?: boolean } = {},
  ) {
    const { adapter, outbox } = fakeAdapter();
    const proposals = pending.map((id) => ({ id, decision: 'pending' }));
    const service = proposalService(
      [{ t: 'text', v: 'Prepared.' }, ...(options.card === false ? [] : [card(delivered)])],
      proposals,
    );
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      outcomeTimeoutMs: 0,
      ...(options.allowRemember !== undefined ? { allowRemember: options.allowRemember } : {}),
    });
    await handle(makeCtx(inbound('refund')).ctx);
    await handle.drain();
    outbox.length = 0;
    const say = async (text: string) => {
      await handle(makeCtx(inbound(text)).ctx);
      await handle.drain();
    };
    return { service, outbox, say };
  }

  it('decides the one card delivered to this conversation', async () => {
    const { service, outbox, say } = await conversation([delivered, elsewhere]);
    await say('yes');
    expect(service.decided).toEqual([[actor, 't', delivered, 'approved', {}, 'test']]);
    expect(texts(outbox)).toEqual(['approved!']);
    expect(service.sends).toHaveLength(1);
  });

  it('never decides a proposal whose card was not delivered here', async () => {
    const { service, outbox, say } = await conversation([elsewhere], { card: false });
    await say('yes');
    await say(`no #${elsewhere}`);
    expect(service.decided).toEqual([]);
    expect(texts(outbox)).toEqual([
      'There is nothing waiting for your confirmation here.',
      'There is nothing waiting for your confirmation here.',
    ]);
    // Neither became a turn (the agent's own text decisions would have decided it).
    expect(service.sends).toHaveLength(1);
  });

  it('decides by #ID only among this conversation’s cards', async () => {
    const { service, say } = await conversation([delivered, elsewhere]);
    await say(`no #${delivered}`);
    expect(service.decided).toEqual([[actor, 't', delivered, 'rejected', {}, 'test']]);
  });

  it('reads "yes" as a message when nothing is pending, and starts turns without text decisions', async () => {
    const { service, say } = await conversation([], { card: false });
    await say('yes');
    expect(service.sends.map((send) => send.message)).toEqual(['refund', 'yes']);
  });

  it('refuses "always in this conversation" where allowRemember is false', async () => {
    const strict = await conversation([delivered], { allowRemember: false });
    await strict.say('yes always in this conversation');
    expect(strict.service.decided).toEqual([]);
    expect(texts(strict.outbox)).toEqual([
      'Here every action needs its own confirmation. Reply without "always".',
    ]);
    const lenient = await conversation([delivered]);
    await lenient.say('yes always in this conversation');
    expect(lenient.service.decided).toEqual([
      [actor, 't', delivered, 'approved', { remember: true }, 'test'],
    ]);
  });
});

// ── hooks ─────────────────────────────────────────────────────────────────────

describe('channel hooks', () => {
  it('unknownSender answers a sender actor() does not know — text, raw text and a file', async () => {
    const { adapter, outbox } = fakeAdapter({ media: true });
    const service = fakeService([]);
    const handle = channels.handle(adapter, {
      service,
      actor: () => null,
      thread: () => 't',
      unknownSender: (message, context) => [
        `Hi **${message.from}**, link your number first.`,
        { text: 'https://app.example.com/link?a=*b*', raw: true },
        {
          media: { kind: 'image', url: 'https://cdn.example.com/qr.png', contentType: 'image/png' },
          caption: `Scan it on **${context.channel}**`,
        },
      ],
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(outbox.map((item) => item.message)).toEqual([
      { text: 'Hi *5511999990000*, link your number first.' },
      { text: 'https://app.example.com/link?a=*b*' },
      {
        text: 'Scan it on *test*',
        media: { kind: 'image', url: 'https://cdn.example.com/qr.png', contentType: 'image/png' },
      },
    ]);
    expect(service.sends).toEqual([]);
  });

  it('beforeTurn gates every message: continue, a reply, or a silent stop', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'turn' }]);
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      beforeTurn: (message) =>
        message.text === 'terms'
          ? { replies: ['Please accept the terms.', 'Reply *ACCEPT*.'] }
          : message.text === 'quiet'
            ? 'stop'
            : 'continue',
    });
    for (const text of ['terms', 'quiet', 'hello']) {
      await handle(makeCtx(inbound(text)).ctx);
      await handle.drain();
    }
    expect(texts(outbox)).toEqual(['Please accept the terms.', 'Reply *ACCEPT*.', 'turn']);
    expect(service.sends.map((send) => send.message)).toEqual(['hello']);
  });

  it('canDeliver is asked before every outgoing message, and drops what it refuses', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    let linked = true;
    const asked: string[] = [];
    const service = fakeService(async function* () {
      yield { t: 'text', v: 'Prepared.' };
      // The number is unlinked from the account while the turn runs.
      linked = false;
      yield card('proposal-1');
    });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      canDeliver: (delivery) => {
        asked.push(`${delivery.kind}:${delivery.actor?.id}:${delivery.message?.text}`);
        return linked;
      },
    });
    await handle(makeCtx(inbound('refund')).ctx);
    await handle.drain();
    expect(outbox).toEqual([]);
    expect(asked).toEqual(['reply:u1:refund', 'card:u1:refund']);
  });

  it('texts as a function speak each actor’s language', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([
      { t: 'error', code: 'run_failed', message: 'boom' } as StreamFrame,
    ]);
    const handle = channels.handle(adapter, {
      service,
      actor: (message) => (message.from === 'es' ? { id: 'es', roles: [] } : actor),
      thread: () => 't',
      texts: ({ actor: who }) => (who?.id === 'es' ? { failed: 'Lo siento, algo salió mal.' } : {}),
    });
    await handle(makeCtx(inbound('hola', { from: 'es', conversation: 'es' })).ctx);
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['es', 'Lo siento, algo salió mal.'],
      ['chat-1', 'Sorry, something went wrong. Please try again.'],
    ]);
  });

  it('onTurnStarted and onThreadCreated see the turn', async () => {
    const { adapter } = fakeAdapter();
    const started: unknown[] = [];
    const handle = channels.handle(adapter, {
      service: fakeService([{ t: 'text', v: 'ok' }]),
      actor: () => actor,
      thread: () => null,
      onTurnStarted: ({ runId, threadId, actor: who, message, queued }) => {
        started.push({ runId, threadId, actor: who.id, message: message.text, queued });
      },
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(started).toEqual([
      { runId: 'run-1', threadId: 'thread-new', actor: 'u1', message: 'hi', queued: false },
    ]);
  });

  it('onWebhook tells what each request came to, without the content', async () => {
    const { adapter } = fakeAdapter();
    adapter.parse = (body) => ((body as { skip?: boolean }).skip ? null : (body as never));
    adapter.ignored = () => ({ reason: 'own message', event: 'messages.upsert' });
    const events: Omit<ChannelWebhookEvent, 'messages'>[] = [];
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      actor: () => null,
      thread: () => 't',
      onWebhook: ({ messages, ...event }) => {
        events.push(event);
      },
    });
    const message = inbound('hi', { id: 'same' });
    await handle(makeCtx(message).ctx);
    await handle(makeCtx(message).ctx);
    await handle(makeCtx({ skip: true }).ctx);
    await handle(makeCtx(message, { headers: { 'x-ok': '0' } }).ctx);
    await handle(makeCtx(message, { method: 'GET' }).ctx);
    await handle.drain();
    expect(events).toEqual([
      { channel: 'test', status: 'accepted', accepted: 1, duplicates: 0 },
      { channel: 'test', status: 'duplicate', accepted: 0, duplicates: 1 },
      {
        channel: 'test',
        status: 'ignored',
        reason: 'own message',
        event: 'messages.upsert',
        accepted: 0,
        duplicates: 0,
      },
      { channel: 'test', status: 'unauthorized', accepted: 0, duplicates: 0 },
      { channel: 'test', status: 'method_not_allowed', accepted: 0, duplicates: 0 },
    ]);
  });

  it('renderComponent sends components as files before the text — replaced by id, none on failure', async () => {
    const chart = (id: string, points: number): StreamFrame => ({
      t: 'component',
      id,
      name: 'Chart',
      data: { points },
      fallbackText: `chart ${id}`,
    });
    const run = (frames: StreamFrame[]) => {
      const { adapter, outbox } = fakeAdapter({ media: true });
      const handle = channels.handle(adapter, {
        service: fakeService(frames),
        actor: () => actor,
        thread: () => 't',
        uiCapabilities: { components: [{ name: 'Chart', versions: [1] }] } as never,
        renderComponent: (component) =>
          component.name === 'Chart'
            ? {
                media: {
                  kind: 'image',
                  url: `https://img.example.com/${component.id}/${(component.data as { points: number }).points}.png`,
                },
              }
            : null,
        texts: { componentsOnly: () => 'Here is the chart.' },
      });
      return { handle, outbox };
    };
    const ok = run([
      chart('c1', 1),
      { t: 'component', id: 't1', name: 'Table', data: {}, fallbackText: 'a | b' },
      { t: 'text', v: 'Your weight is up.' },
      chart('c1', 2),
    ]);
    await ok.handle(makeCtx(inbound('chart')).ctx);
    await ok.handle.drain();
    expect(ok.outbox.map((item) => item.message)).toEqual([
      { text: '', media: { kind: 'image', url: 'https://img.example.com/c1/2.png' } },
      { text: 'a | b\n\nYour weight is up.' },
    ]);

    const only = run([chart('c1', 1)]);
    await only.handle(makeCtx(inbound('chart')).ctx);
    await only.handle.drain();
    expect(texts(only.outbox)).toEqual(['', 'Here is the chart.']);

    const failed = run([chart('c1', 1), { t: 'error', code: 'run_failed', message: 'x' }]);
    await failed.handle(makeCtx(inbound('chart')).ctx);
    await failed.handle.drain();
    expect(texts(failed.outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
  });

  it('a file reply on a channel without files sends its fallback text', async () => {
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      actor: () => null,
      thread: () => 't',
      unknownSender: () => ({
        media: { kind: 'document', url: 'https://x/terms.pdf' },
        caption: 'Terms',
        fallbackText: 'Terms: https://x/terms.pdf',
      }),
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['Terms: https://x/terms.pdf']);
  });

  it('prepareMedia reads a voice note as text, mediaLimits lets it through, transformInbound adds a note', async () => {
    const { adapter, outbox } = fakeAdapter();
    adapter.download = async (media) => ({
      data: Buffer.from('ogg'),
      contentType: media.contentType ?? 'application/octet-stream',
    });
    const staged: string[] = [];
    const service = fakeService([{ t: 'text', v: 'Noted.' }], {
      attachmentLimits: () => ({ maxBytes: 1000, allowedContentTypes: ['image/png'] }),
      stageAttachment: (async (_actor: unknown, file: { contentType: string }) => {
        staged.push(file.contentType);
        return { mediaId: `media-${staged.length}`, url: '', contentType: file.contentType };
      }) as never,
    });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      mediaLimits: (limits, media) =>
        media.kind === 'audio' && limits
          ? { ...limits, allowedContentTypes: [...limits.allowedContentTypes, 'audio/ogg'] }
          : limits,
      prepareMedia: (file, media) =>
        media.kind === 'audio' ? { text: `(voice) ${file.data.toString()}` } : undefined,
      transformInbound: (message) => ({
        ...message,
        text:
          message.attachments.length > 0
            ? `${message.text || 'What is in this image?'}\n\n[attachments: ${message.attachments.map((a) => a.mediaId).join(', ')}]`
            : message.text,
      }),
    });
    await handle(
      makeCtx(
        inbound('', {
          id: 'v1',
          media: [{ kind: 'audio', contentType: 'audio/ogg', ref: 'a' }],
        }),
      ).ctx,
    );
    await handle(
      makeCtx(
        inbound('', {
          id: 'i1',
          media: [{ kind: 'image', contentType: 'image/png', ref: 'i' }],
        }),
      ).ctx,
    );
    await handle.drain();
    expect(staged).toEqual(['image/png']);
    expect(service.sends.map((send) => send.message)).toEqual([
      '(voice) ogg',
      'What is in this image?\n\n[attachments: media-1]',
    ]);
    expect(service.sends[1].attachments).toEqual([{ mediaId: 'media-1' }]);
    expect(texts(outbox)).toEqual(['Noted.', 'Noted.']);
  });

  it('a transcribed voice note can decide a card like typed text', async () => {
    const { adapter } = fakeAdapter();
    adapter.download = async () => ({ data: Buffer.from('yes'), contentType: 'audio/ogg' });
    const service = proposalService(
      [card('proposal-1')],
      [{ id: 'proposal-1', decision: 'pending' }],
    );
    service.attachmentLimits = () => ({ maxBytes: 1000, allowedContentTypes: ['audio/ogg'] });
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      outcomeTimeoutMs: 0,
      prepareMedia: (file) => ({ text: file.data.toString() }),
    });
    await handle(makeCtx(inbound('refund')).ctx);
    await handle.drain();
    await handle(
      makeCtx(inbound('', { media: [{ kind: 'audio', contentType: 'audio/ogg', ref: 'a' }] })).ctx,
    );
    await handle.drain();
    expect(service.decided).toEqual([[actor, 't', 'proposal-1', 'approved', {}, 'test']]);
  });

  it('formatOutcome relays the outcome and a follow-up sent alone and raw — once, in order', async () => {
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      store: new InMemoryChannelStore(),
      actor: () => actor,
      thread: () => 't',
      formatOutcome: (proposal, { text }) => {
        const forward = (proposal.execution?.result as { forward?: string } | undefined)?.forward;
        return forward === undefined
          ? null
          : [`${text} Forward the message below:`, { text: forward, raw: true }];
      },
    });
    await handle.drain();
    const proposal = {
      id: 'p-share',
      toolName: 'share_with_doctor',
      decision: 'approved',
      actorRef: 'u1',
      execution: { status: 'succeeded', result: { forward: 'Open *this*: https://x/y' } },
      executionContext: { pageContext: { channel: { name: 'test', conversation: 'chat-9' } } },
    } as unknown as ActionProposal;
    await channels.onSettled(proposal);
    await channels.onSettled(proposal);
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-9', 'Done. Forward the message below:'],
      ['chat-9', 'Open *this*: https://x/y'],
    ]);
    // An outcome is checked by canDeliver too, as the proposal's actor.
    const { adapter: other, outbox: none } = fakeAdapter();
    channels.handle(other, {
      service: fakeService([]),
      store: new InMemoryChannelStore(),
      actor: () => actor,
      thread: () => 't',
      canDeliver: (delivery) => delivery.actorRef !== 'u1' || delivery.kind !== 'outcome',
    });
    await channels.onSettled({ ...proposal, id: 'p-2' } as ActionProposal);
    expect(none).toEqual([]);
  });

  it('a card carries texts.footer: as the provider footer, and at the end of the text fallback', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const handle = channels.handle(adapter, {
      service: fakeService([card('proposal-1')]),
      actor: () => actor,
      thread: () => 't',
      texts: { footer: 'Valid for **5 minutes**.' },
    });
    await handle(makeCtx(inbound('refund')).ctx);
    await handle.drain();
    const ids = proposalButtonIds('proposal-1');
    expect(outbox[0]?.message).toEqual({
      text: '*Refund order A-1?*',
      buttons: [
        { id: ids.approve, label: 'Confirm' },
        { id: ids.reject, label: 'Cancel' },
      ],
      fallbackText:
        '*Refund order A-1?*\n\nReply *yes* to confirm or *no* to cancel.\n\nValid for *5 minutes*.',
      instruction: 'Reply *yes* to confirm or *no* to cancel.',
      footer: 'Valid for *5 minutes*.',
    });
  });
});
