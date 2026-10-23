import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentRefusedError } from '../src/agent-service.js';
import {
  type ChannelHandleOptions,
  type ChannelInbound,
  type ChannelMediaFile,
  type ChannelStepServer,
  type ChannelTurnEnded,
  type ChannelTurnStarted,
  type ChannelWorkflowEngine,
  channels,
  type InboundMedia,
  type InboundMessage,
  InMemoryChannelStore,
} from '../src/channels/index.js';
import type { ElicitationRequest } from '../src/elicitation.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import {
  actor,
  type FakeService,
  fakeAdapter,
  fakeService,
  inbound,
  makeCtx,
  texts,
} from './helpers/channels.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}

const limits = { maxBytes: 1000, allowedContentTypes: ['image/jpeg', 'application/pdf'] };

const pdf = (name: string): InboundMedia => ({
  kind: 'document',
  contentType: 'application/pdf',
  filename: name,
  ref: { size: 10 },
});

/** A service that stages what it is given, and answers every turn with `reply`. */
function mediaService(frames: StreamFrame[] | ((runId: string) => AsyncIterable<StreamFrame>)) {
  const staged: string[] = [];
  const service = fakeService(frames, {
    attachmentLimits: () => limits,
    stageAttachment: async (_who, file) => {
      if (!limits.allowedContentTypes.includes(file.contentType))
        throw new AttachmentRefusedError(415, 'no');
      staged.push(file.filename ?? '');
      return {
        mediaId: `media-${staged.length}`,
        url: 'https://x',
        contentType: file.contentType,
        name: file.filename,
      };
    },
  });
  return { service, staged };
}

function setup(
  service: FakeService,
  { noCoalesce = false, ...options }: Partial<ChannelHandleOptions> & { noCoalesce?: boolean } = {},
  adapterCapabilities = {},
) {
  const { adapter, outbox } = fakeAdapter(adapterCapabilities);
  adapter.download = async (media): Promise<ChannelMediaFile> => ({
    data: Buffer.alloc(10),
    contentType: media.contentType ?? 'application/pdf',
    ...(media.filename !== undefined ? { filename: media.filename } : {}),
  });
  const ended: ChannelTurnEnded[] = [];
  const started: ChannelTurnStarted[] = [];
  const store = new InMemoryChannelStore();
  const handle = channels.handle(adapter, {
    service,
    store,
    durable: false,
    actor: () => actor,
    thread: () => 't',
    ...(noCoalesce ? {} : { coalesce: { quietMs: 80 } }),
    onTurnEnded: (turn) => {
      ended.push(turn);
    },
    onTurnStarted: (turn) => {
      started.push(turn);
    },
    ...options,
  });
  const say = async (text: string, extra: Partial<InboundMessage> = {}) => {
    const { ctx, sent } = makeCtx(inbound(text, extra));
    await handle(ctx);
    return sent;
  };
  return { handle, outbox, ended, started, store, say, adapter };
}

describe('coalesce (inline)', () => {
  it('a burst of three files is ONE turn with every file, captions in order', async () => {
    const { service, staged } = mediaService([{ t: 'text', v: 'Got your 3 exams.' }]);
    const { handle, outbox, ended, started, say } = setup(service);
    await say('', { id: 'f-1', media: [pdf('a.pdf')] });
    await say('the second one', { id: 'f-2', media: [pdf('b.pdf')] });
    await say('', { id: 'f-3', media: [pdf('c.pdf')] });
    await handle.drain();
    expect(service.sends).toHaveLength(1);
    expect(service.sends[0]).toMatchObject({
      message: 'the second one',
      attachments: [{ mediaId: 'media-1' }, { mediaId: 'media-2' }, { mediaId: 'media-3' }],
      hostContext: { messageId: 'f-1', messageIds: ['f-1', 'f-2', 'f-3'] },
    });
    expect(staged).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(texts(outbox)).toEqual(['Got your 3 exams.']);
    // One turn told, with what it grouped.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      outcome: 'replied',
      message: expect.objectContaining({ id: 'f-1' }),
      attachments: 3,
    });
    expect(ended[0]?.coalesced?.map((message) => message.id)).toEqual(['f-1', 'f-2', 'f-3']);
    expect(ended[0]?.queueWaitMs).toBeGreaterThanOrEqual(70);
    expect(started[0]?.coalesced?.map((message) => message.id)).toEqual(['f-1', 'f-2', 'f-3']);
    expect(started[0]?.queueWaitMs).toBeGreaterThanOrEqual(70);
  });

  it('a burst of texts is one turn, joined in order', async () => {
    const service = fakeService([{ t: 'text', v: 'Hi! What do you want to know?' }]);
    const { handle, outbox, say } = setup(service);
    await say('oi', { id: 't-1' });
    await say('tudo bem?', { id: 't-2' });
    await say('queria saber X', { id: 't-3' });
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual([
      'oi\n\ntudo bem?\n\nqueria saber X',
    ]);
    expect(texts(outbox)).toEqual(['Hi! What do you want to know?']);
  });

  it('transformInbound sees each message of the burst with its own files and caption', async () => {
    const { service } = mediaService([{ t: 'text', v: 'ok' }]);
    const seen: { inbound: ChannelInbound; coalesced: number }[] = [];
    const { handle, say } = setup(service, {
      transformInbound: (inbound, context) => {
        seen.push({ inbound, coalesced: context.coalesced?.length ?? 1 });
        return {
          ...inbound,
          text: (inbound.parts ?? [])
            .map((part, index) => `[file ${index + 1}] ${part.text || '(no caption)'}`)
            .join('\n'),
        };
      },
    });
    await say('blood test', { id: 'p-1', media: [pdf('a.pdf')] });
    await say('', { id: 'p-2', media: [pdf('b.pdf')] });
    await handle.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.coalesced).toBe(2);
    expect(
      seen[0]?.inbound.parts?.map((part) => [part.message.id, part.text, part.attachments]),
    ).toEqual([
      ['p-1', 'blood test', [{ mediaId: 'media-1' }]],
      ['p-2', '', [{ mediaId: 'media-2' }]],
    ]);
    expect(service.sends[0]?.message).toBe('[file 1] blood test\n[file 2] (no caption)');
  });

  it('each file of a burst is refused on its own; the rest still make the turn', async () => {
    const { service } = mediaService([{ t: 'text', v: 'ok' }]);
    const { handle, outbox, say } = setup(service);
    await say('', { id: 'r-1', media: [pdf('a.pdf')] });
    await say('', {
      id: 'r-2',
      media: [{ kind: 'video', contentType: 'video/mp4', ref: { size: 10 } }],
    });
    await handle.drain();
    expect(service.sends).toHaveLength(1);
    expect(service.sends[0]?.attachments).toEqual([{ mediaId: 'media-1' }]);
    expect(texts(outbox)).toHaveLength(2);
    expect(texts(outbox)[1]).toBe('ok');
  });

  it('a control message is never swallowed: a text decision ends the burst and is handled alone, in order', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, say } = setup(service);
    await say('oi', { id: 'c-1' });
    await say('tudo bem?', { id: 'c-2' });
    await say('yes', { id: 'c-3' });
    await say('and another thing', { id: 'c-4' });
    await handle.drain();
    // "yes" decides nothing here (no card), so it is a turn — but never grouped.
    expect(service.sends.map((send) => send.message)).toEqual([
      'oi\n\ntudo bem?',
      'yes',
      'and another thing',
    ]);
  });

  it('a button press is handled alone, and the messages around it in order', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, say } = setup(service);
    await say('first', { id: 'b-1' });
    await say('Option A', { id: 'b-2', buttonWithoutId: true });
    await say('second', { id: 'b-3' });
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['first', 'Option A', 'second']);
  });

  it('while a question waits for its answer, every message is an answer of its own', async () => {
    const request: ElicitationRequest = {
      id: 'ask-1',
      source: 'ask',
      questions: [
        {
          id: 'size',
          prompt: 'Which size?',
          options: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' },
          ],
        },
        { id: 'note', prompt: 'Anything else?', input: { type: 'text' }, defaults: [] },
      ],
    };
    let answered!: (answers: unknown) => void;
    const answer = new Promise<unknown>((resolve) => {
      answered = resolve;
    });
    const calls: any[] = [];
    const service = fakeService(
      async function* () {
        yield { t: 'elicitation', runId: 'run-1', id: 'ask-1', request };
        await answer;
        yield { t: 'text', v: 'Ordered a large one.' };
      },
      {
        answer: async (args) => {
          calls.push(args);
          answered(args.answers);
        },
      },
    );
    const { handle, outbox, say } = setup(service);
    await say('order a shirt', { id: 'q-1' });
    await until(() => outbox.length === 1);
    await say('2', { id: 'q-2' });
    await say('Blue please', { id: 'q-3' });
    await handle.drain();
    // Two answers, read one at a time — never one message "2 Blue please".
    expect(calls.map((call) => call.answers)).toEqual([{ size: ['l'], note: ['Blue please'] }]);
    expect(texts(outbox).at(-1)).toBe('Ordered a large one.');
    expect(service.sends.map((send) => send.message)).toEqual(['order a shirt']);
  });

  it('messages that arrive while a grouped turn runs go to the next turn', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService((runId) =>
      (async function* (): AsyncGenerator<StreamFrame> {
        if (runId === 'run-1') await gate;
        yield { t: 'text', v: `answer to ${runId}` };
      })(),
    );
    const { handle, outbox, say } = setup(service);
    await say('one', { id: 'n-1' });
    await say('two', { id: 'n-2' });
    await until(() => service.subscribed.length === 1);
    await say('three', { id: 'n-3' });
    await say('four', { id: 'n-4' });
    await sleep(150);
    release();
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['one\n\ntwo', 'three\n\nfour']);
    expect(texts(outbox)).toEqual(['answer to run-1', 'answer to run-2']);
  });

  it('beforeTurn stopping one message of a burst leaves the others the turn', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const gated: { id: string; coalesced: number }[] = [];
    const { handle, ended, say } = setup(service, {
      beforeTurn: (message, _actor, context) => {
        gated.push({ id: message.id, coalesced: context.coalesced?.length ?? 1 });
        return message.text === 'spam' ? 'stop' : 'continue';
      },
    });
    await say('spam', { id: 's-1' });
    await say('real question', { id: 's-2' });
    await say('more', { id: 's-3' });
    await handle.drain();
    expect(gated).toEqual([
      { id: 's-1', coalesced: 3 },
      { id: 's-2', coalesced: 3 },
      { id: 's-3', coalesced: 3 },
    ]);
    expect(service.sends.map((send) => send.message)).toEqual(['real question\n\nmore']);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.message?.id).toBe('s-2');
    expect(ended[0]?.coalesced?.map((message) => message.id)).toEqual(['s-2', 's-3']);
  });

  it('beforeTurn stopping every message of a burst: no turn, told once, nothing left behind', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, ended, outbox, say } = setup(service, {
      beforeTurn: () => ({ reply: 'Accept the terms first.' }),
    });
    await say('a', { id: 'x-1' });
    await say('b', { id: 'x-2' });
    await handle.drain();
    expect(service.sends).toEqual([]);
    // Each message answered by its gate, as it would be alone.
    expect(texts(outbox)).toEqual(['Accept the terms first.', 'Accept the terms first.']);
    expect(ended.map((turn) => turn.outcome)).toEqual(['stopped']);
  });

  it('maxMessages caps a burst; the rest is the next turn', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, say } = setup(service, { coalesce: { quietMs: 80, maxMessages: 2 } });
    await say('1', { id: 'm-1' });
    await say('2', { id: 'm-2' });
    await say('3', { id: 'm-3' });
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['1\n\n2', '3']);
  });

  it('when() keeps some messages out of bursts (only files, say)', async () => {
    const { service } = mediaService([{ t: 'text', v: 'ok' }]);
    const { handle, say } = setup(service, {
      coalesce: { quietMs: 80, when: (message) => (message.media?.length ?? 0) > 0 },
    });
    await say('', { id: 'w-1', media: [pdf('a.pdf')] });
    await say('', { id: 'w-2', media: [pdf('b.pdf')] });
    await say('what are these?', { id: 'w-3' });
    await handle.drain();
    expect(service.sends.map((send) => [send.message, send.attachments?.length ?? 0])).toEqual([
      ['', 2],
      ['what are these?', 0],
    ]);
  });

  it('a webhook delivered again (same message id) neither re-groups nor answers twice', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, outbox, say } = setup(service);
    await say('oi', { id: 'd-1' });
    await say('oi', { id: 'd-1' });
    await say('tudo bem?', { id: 'd-2' });
    await say('tudo bem?', { id: 'd-2' });
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['oi\n\ntudo bem?']);
    expect(texts(outbox)).toEqual(['ok']);
  });

  it('a leader that fails before its turn leaves its burst to the messages’ own jobs — none dropped', async () => {
    let failing = true;
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const send = service.send;
    service.send = async (...args) => {
      if (failing) {
        failing = false;
        throw Object.assign(new Error('model down'), { status: 400 });
      }
      return send(...args);
    };
    const errors: string[] = [];
    const { handle, say } = setup(service, {
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });
    await say('one', { id: 'l-1' });
    await say('two', { id: 'l-2' });
    await say('three', { id: 'l-3' });
    await handle.drain();
    expect(errors).toEqual(['model down']);
    // The burst's turn never started: the other two are answered by their own jobs.
    expect(service.sends.map((send) => send.message)).toEqual(['two', 'three']);
  });

  it('without coalesce nothing waits and every message is its own turn', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { handle, ended, say } = setup(service, { noCoalesce: true });
    const startedAt = Date.now();
    await say('oi', { id: 'u-1' });
    await say('tudo bem?', { id: 'u-2' });
    await handle.drain();
    expect(Date.now() - startedAt).toBeLessThan(80);
    expect(service.sends.map((send) => send.message)).toEqual(['oi', 'tudo bem?']);
    // No new fields for a channel that did not ask for them.
    expect(ended[0]).not.toHaveProperty('coalesced');
    expect(ended[0]).not.toHaveProperty('attachments');
    expect(ended[0]).not.toHaveProperty('queueWaitMs');
  });
});

// ── durable ───────────────────────────────────────────────────────────────────

/** An engine with a transport serving dispatched steps, and its timer poller running. */
function durableDeployment(durableStore = new InMemoryStateStore()) {
  const transport = new InMemoryTransport();
  const engine = new WorkflowEngine({ store: durableStore, transport });
  let stopped = false;
  const ticker = (async () => {
    while (!stopped) {
      await engine.resumeDueTimers().catch(() => {});
      await sleep(10);
    }
  })();
  return {
    engine,
    transport,
    channelEngine: engine as unknown as ChannelWorkflowEngine,
    stepServer: transport as unknown as ChannelStepServer,
    stop: async () => {
      stopped = true;
      await ticker;
    },
  };
}

describe('coalesce (durable)', () => {
  const deployments: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(deployments.splice(0).map((deployment) => deployment.stop()));
  });

  it('waits for the burst with the engine’s durable sleep, then answers it as one turn', async () => {
    const app = durableDeployment();
    deployments.push(app);
    const { service, staged } = mediaService([{ t: 'text', v: 'All saved.' }]);
    const { outbox, ended, say } = setup(service, {
      durable: app.channelEngine,
      durableSteps: app.stepServer,
      coalesce: { quietMs: 1000 },
    });
    expect((await say('', { id: 'df-1', media: [pdf('a.pdf')] })).status).toBe(200);
    // The leader is asleep (durably): suspended with a wake time, nothing holding a process.
    let leader = await app.engine.getRun('agora.channel:test:message:df-1');
    const deadline = Date.now() + 2000;
    while (leader?.status !== 'suspended' && Date.now() < deadline) {
      await sleep(5);
      leader = await app.engine.getRun('agora.channel:test:message:df-1');
    }
    expect(leader?.status).toBe('suspended');
    expect(leader?.wakeAt).toBeDefined();
    await say('', { id: 'df-2', media: [pdf('b.pdf')] });
    await say('', { id: 'df-3', media: [pdf('c.pdf')] });
    for (const id of ['df-1', 'df-2', 'df-3'])
      await app.engine.waitForRun(`agora.channel:test:message:${id}`, {
        terminal: true,
        timeoutMs: 5000,
      });
    expect(service.sends).toHaveLength(1);
    expect(staged).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(texts(outbox)).toEqual(['All saved.']);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.coalesced?.map((message) => message.id)).toEqual(['df-1', 'df-2', 'df-3']);
    // The leader's history: its looks at the burst (dispatched), with durable sleeps between.
    const steps = await app.engine.listCheckpoints('agora.channel:test:message:df-1');
    const names = steps.map((step) => step.name);
    expect(names.filter((name) => name === 'agora.channel.gather').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(names).toEqual(
      expect.arrayContaining(['agora.channel.prepare', 'agora.channel.act', 'agora.channel.read']),
    );
    expect(steps.filter((step) => step.kind === 'sleep').length).toBeGreaterThanOrEqual(1);
    expect(
      steps.filter((step) => step.name.startsWith('agora.channel.')).map((step) => step.kind),
    ).not.toContain('local');
    // The others' jobs ended without a turn of their own.
    for (const id of ['df-2', 'df-3']) {
      const followers = await app.engine.listCheckpoints(`agora.channel:test:message:${id}`);
      expect(followers.map((step) => step.name)).toEqual(['channel', 'agora.channel.gather']);
    }
  });

  it('a process that dies while the burst waits: another one wakes it and answers once', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const first = durableDeployment(durableStore);
    deployments.push(first);
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { adapter, outbox } = fakeAdapter();
    const handleA = channels.handle(adapter, {
      service,
      store,
      durable: first.channelEngine,
      durableSteps: first.stepServer,
      actor: () => actor,
      thread: () => 't',
      coalesce: { quietMs: 1500 },
    });
    await handleA(makeCtx(inbound('oi', { id: 'k-1' })).ctx);
    await handleA(makeCtx(inbound('tudo bem?', { id: 'k-2' })).ctx);
    await sleep(40);
    // The first process stops before the wake (its poller with it).
    await first.stop();
    expect(service.sends).toEqual([]);

    // Another process over the same stores — it never saw the webhooks.
    const second = durableDeployment(durableStore);
    deployments.push(second);
    channels.handle(adapter, {
      service,
      store,
      durable: second.channelEngine,
      durableSteps: second.stepServer,
      actor: () => actor,
      thread: () => 't',
      coalesce: { quietMs: 1500 },
    });
    for (const id of ['k-1', 'k-2'])
      await second.engine.waitForRun(`agora.channel:test:message:${id}`, {
        terminal: true,
        timeoutMs: 5000,
      });
    expect(service.sends.map((send) => send.message)).toEqual(['oi\n\ntudo bem?']);
    expect(texts(outbox)).toEqual(['ok']);
    // Replayed again (a recovery sweep): nothing more.
    await second.engine.recoverIncomplete();
    await sleep(30);
    expect(service.sends).toHaveLength(1);
    expect(texts(outbox)).toEqual(['ok']);
  });
});
