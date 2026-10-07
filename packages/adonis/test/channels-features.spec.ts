import { describe, expect, it } from 'vitest';
import {
  type ChannelMediaFile,
  ChannelMediaTooLargeError,
  channels,
  type InboundMedia,
} from '../src/channels/index.js';
import type { ElicitationRequest } from '../src/elicitation.js';
import {
  AGENT_TABLES,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  ASK_TOOL_NAME,
  AttachmentRefusedError,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  ToolRegistry,
} from '../src/index.js';
import type { ActionProposal } from '../src/spi/action-proposal-store.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx, texts } from './helpers/channels.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

/** Wait until `check` holds (the handler works after the 200). */
async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── questions ─────────────────────────────────────────────────────────────────

describe('questions on a text channel', () => {
  const request: ElicitationRequest = {
    id: 'ask-1',
    source: 'ask',
    preamble: 'Two quick questions.',
    questions: [
      {
        id: 'size',
        prompt: 'Which size?',
        options: [
          { value: 's', label: 'Small' },
          { value: 'l', label: 'Large' },
        ],
      },
      {
        id: 'note',
        prompt: 'Anything else?',
        input: { type: 'text' },
        defaults: [],
      },
    ],
  };

  /** A run that asks, waits for the answer, then answers. */
  function askingService() {
    let answered!: (answers: unknown) => void;
    const answer = new Promise<unknown>((resolve) => {
      answered = resolve;
    });
    const calls: any[] = [];
    const service = fakeService(
      async function* () {
        yield { t: 'text', v: 'Let me check.' };
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
    return { service, calls };
  }

  it('asks one question at a time as text and resumes the run with the answers', async () => {
    const { adapter, outbox } = fakeAdapter();
    const { service, calls } = askingService();
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });

    await handle(makeCtx(inbound('order a shirt')).ctx);
    await until(() => outbox.length === 2);
    expect(texts(outbox)).toEqual([
      'Let me check.',
      [
        'Two quick questions.',
        '',
        '*(1/2) Which size?*',
        '',
        '1. Small',
        '2. Large',
        '',
        'Reply with the number of your choice.',
      ].join('\n'),
    ]);

    // not an option: asked again
    await handle(makeCtx(inbound('medium')).ctx);
    await until(() => outbox.length === 4);
    expect(texts(outbox)[2]).toBe('I could not read that answer (not one of the options).');
    expect(texts(outbox)[3]).toContain('Which size?');

    await handle(makeCtx(inbound('2')).ctx);
    await until(() => outbox.length === 5);
    expect(texts(outbox)[4]).toBe('*(2/2) Anything else?*');

    await handle(makeCtx(inbound('Blue please')).ctx);
    await handle.drain();
    expect(calls).toEqual([
      {
        runId: 'run-1',
        toolCallId: 'ask-1',
        answers: { size: ['l'], note: ['Blue please'] },
        answeredByRef: 'u1',
        answeredVia: 'test',
      },
    ]);
    expect(texts(outbox).at(-1)).toBe('Ordered a large one.');
    // The answers were answers, not new turns.
    expect(service.sends).toHaveLength(1);
  });

  it('leaves a skipped question to its defaults', async () => {
    const { adapter, outbox } = fakeAdapter();
    const { service, calls } = askingService();
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    await handle(makeCtx(inbound('order')).ctx);
    await until(() => outbox.length === 2);
    await handle(makeCtx(inbound('1')).ctx);
    await until(() => outbox.length === 3);
    await handle(makeCtx(inbound('skip')).ctx);
    await handle.drain();
    expect(calls[0].answers).toEqual({ size: ['s'] });
  });

  it('proceeds without the answers once nobody replied for questionTimeoutMs', async () => {
    const { adapter, outbox } = fakeAdapter();
    let resumed!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const service = fakeService(
      async function* () {
        yield { t: 'elicitation', runId: 'run-1', id: 'ask-1', request };
        await resume;
        yield { t: 'text', v: 'Went with defaults.' };
      },
      { answer: async () => {} },
    );
    service.skip = async (args) => {
      service.skipped.push(args);
      resumed();
    };
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => 't',
      questionTimeoutMs: 50,
    });
    await handle(makeCtx(inbound('order')).ctx);
    await handle.drain();
    expect(service.skipped).toEqual([
      { runId: 'run-1', toolCallId: 'ask-1', answeredByRef: 'u1', answeredVia: 'test' },
    ]);
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
    // and the next message is a message again, not an answer
    await handle(makeCtx(inbound('thanks')).ctx);
    await handle.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['order', 'thanks']);
  });
});

describe('questions against the real agent (inline runner, ask tool)', () => {
  it('asks the ask tool’s question as text and resumes the run with the chosen option', async () => {
    const store = new InMemoryAgentStore();
    const agents = new AgentRegistry();
    agents.register({ name: 'default', ask: true });
    const scope = {
      id: 'scope',
      prompt: 'How wide should I go?',
      options: [
        { value: 'narrow', label: 'This module only' },
        { value: 'everything', label: 'The whole repo' },
      ],
      defaults: ['narrow'],
    };
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider((args, turn) =>
        turn === 0
          ? {
              text: 'One question first.',
              toolCall: { name: ASK_TOOL_NAME, input: { questions: [scope] } },
            }
          : {
              text: `Going with ${JSON.stringify(args.messages.at(-1)?.toolResults?.[0]?.output ?? null)}`,
            },
      ),
      store,
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents,
    });
    const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
    const { adapter, outbox } = fakeAdapter();
    let threadId: string | null = null;
    const handle = channels.handle(adapter, {
      service,
      actor: () => actor,
      thread: () => threadId,
      onThreadCreated: (id) => {
        threadId = id;
      },
    });
    await handle(makeCtx(inbound('tidy up')).ctx);
    await until(() => outbox.length === 2).catch((error) => {
      throw new Error(`${error}: ${JSON.stringify(texts(outbox))}`);
    });
    expect(texts(outbox)[1]).toContain('1. This module only\n2. The whole repo');
    await handle(makeCtx(inbound('2')).ctx);
    await handle.drain();
    expect(texts(outbox).at(-1)).toContain('everything');
  });
});

// ── media ─────────────────────────────────────────────────────────────────────

describe('media on a text channel', () => {
  const limits = { maxBytes: 1000, allowedContentTypes: ['image/jpeg', 'application/pdf'] };

  function mediaSetup(opts: { attachments?: boolean } = {}) {
    const { adapter, outbox } = fakeAdapter();
    const downloads: InboundMedia[] = [];
    adapter.download = async (media, { maxBytes }): Promise<ChannelMediaFile> => {
      downloads.push(media);
      const size = (media.ref as { size: number }).size;
      if (size > maxBytes) throw new ChannelMediaTooLargeError(maxBytes);
      return { data: Buffer.alloc(size), contentType: media.contentType ?? 'image/jpeg' };
    };
    const staged: any[] = [];
    const service = fakeService([{ t: 'text', v: 'Nice picture.' }], {
      attachmentLimits: () => (opts.attachments === false ? null : limits),
      stageAttachment: async (who, file) => {
        if (!limits.allowedContentTypes.includes(file.contentType))
          throw new AttachmentRefusedError(415, 'no');
        staged.push({ who, ...file, size: file.data.byteLength });
        return {
          mediaId: `media-${staged.length}`,
          url: 'https://x',
          contentType: file.contentType,
          name: file.filename,
        };
      },
    });
    const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
    return { adapter, outbox, downloads, staged, service, handle };
  }

  const photo = (size: number, extra: Partial<InboundMedia> = {}): InboundMedia => ({
    kind: 'image',
    contentType: 'image/jpeg',
    ref: { size },
    ...extra,
  });

  it('downloads, stages and attaches an image, with its caption as the message', async () => {
    const { handle, staged, service, outbox } = mediaSetup();
    await handle(makeCtx(inbound('what is this?', { media: [photo(10)] })).ctx);
    await handle.drain();
    expect(staged).toEqual([
      {
        who: actor,
        data: expect.any(Buffer),
        contentType: 'image/jpeg',
        filename: 'image.jpeg',
        size: 10,
      },
    ]);
    expect(service.sends[0]).toMatchObject({
      message: 'what is this?',
      attachments: [{ mediaId: 'media-1' }],
    });
    expect(texts(outbox)).toEqual(['Nice picture.']);
  });

  it('refuses a type the attachment store does not take, without downloading it', async () => {
    const { handle, downloads, service, outbox } = mediaSetup();
    await handle(
      makeCtx(
        inbound('', {
          media: [{ kind: 'audio', contentType: 'audio/ogg; codecs=opus', ref: { size: 5 } }],
        }),
      ).ctx,
    );
    await handle.drain();
    expect(downloads).toEqual([]);
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['I cannot listen to audio messages. Please type your message.']);
  });

  it('refuses a file past the limit — by its declared size, or while downloading', async () => {
    const { handle, downloads, service, outbox } = mediaSetup();
    await handle(makeCtx(inbound('', { media: [photo(5000, { sizeBytes: 5000 })] })).ctx);
    await handle(makeCtx(inbound('look', { media: [photo(5000)] })).ctx);
    await handle.drain();
    expect(downloads).toHaveLength(1);
    expect(texts(outbox).slice(0, 2)).toEqual([
      'That file is too large (the limit is 1 KB).',
      'That file is too large (the limit is 1 KB).',
    ]);
    // the caption still goes to the agent, without the file
    expect(service.sends.map((send) => [send.message, send.attachments])).toEqual([
      ['look', undefined],
    ]);
  });

  it('says so when attachments are off', async () => {
    const { handle, service, outbox } = mediaSetup({ attachments: false });
    await handle(makeCtx(inbound('', { media: [photo(10)] })).ctx);
    await handle.drain();
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['I can only read text messages here.']);
  });
});

// ── outcomes and the store ────────────────────────────────────────────────────

describe('outcomes after the turn', () => {
  const settled = (conversation: string, outcomeText?: string) =>
    ({
      id: `proposal-${conversation}`,
      threadId: 't',
      decision: 'approved',
      execution: { status: 'succeeded', generation: 1, lease: null },
      executionContext: {
        requestId: 'r',
        pageContext: { kind: 'outcomes', channel: { name: 'outcomes', conversation } },
      },
      ...(outcomeText !== undefined ? { outcome: { text: outcomeText } } : {}),
    }) as unknown as ActionProposal;

  it('channels.onSettled relays an executed proposal once, through the registered adapter', async () => {
    const { adapter, outbox } = fakeAdapter();
    const named = { ...adapter, name: 'outcomes' };
    channels.handle(named, { service: fakeService([]), actor: () => actor, thread: () => 't' });
    await channels.onSettled(settled('chat-9', 'Refunded **10.00**.'));
    await channels.onSettled(settled('chat-9', 'Refunded **10.00**.'));
    expect(outbox).toEqual([{ conversation: 'chat-9', message: { text: 'Refunded *10.00*.' } }]);
    expect(channels.adapter('outcomes')).toBe(named);
  });

  it('ignores proposals from other surfaces, unregistered channels and failed ones get their text', async () => {
    const { adapter, outbox } = fakeAdapter();
    channels.handle(
      { ...adapter, name: 'outcomes' },
      {
        service: fakeService([]),
        actor: () => actor,
        thread: () => 't',
      },
    );
    const web = {
      ...settled('x'),
      executionContext: { requestId: 'r', pageContext: { kind: 'web' } },
    };
    expect(await channels.deliverOutcome(web as ActionProposal)).toBe(false);
    const elsewhere = settled('y');
    (elsewhere.executionContext!.pageContext as any).channel.name = 'nobody';
    expect(await channels.deliverOutcome(elsewhere)).toBe(false);
    const failed = {
      ...settled('z'),
      execution: { status: 'failed', generation: 1, lease: null, error: 'x' },
    };
    expect(await channels.deliverOutcome(failed as ActionProposal)).toBe(true);
    expect(texts(outbox)).toEqual(['The action could not be completed.']);
  });
});

describe('the default store', () => {
  it('is Lucid when the agent store is', async () => {
    const db = await makeStoreDb();
    try {
      const { adapter } = fakeAdapter();
      const service = fakeService([{ t: 'text', v: 'hi' }] as StreamFrame[], {
        lucidDatabase: () => asStoreDb(db),
      });
      const handle = channels.handle(adapter, { service, actor: () => actor, thread: () => 't' });
      await handle(makeCtx(inbound('hello', { id: 'wamid.1' })).ctx);
      await handle(makeCtx(inbound('hello', { id: 'wamid.1' })).ctx);
      await handle.drain();
      expect(service.sends).toHaveLength(1);
      const keys = (await db.from(AGENT_TABLES.channelState).select('key')).map((row) => row.key);
      expect(keys).toEqual(['test:wamid.1']);
    } finally {
      await db.manager.closeAll();
    }
  });
});
