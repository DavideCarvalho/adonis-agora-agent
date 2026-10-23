import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  channels,
  evolutionApi,
  type InboundMessage,
  InMemoryChannelStore,
  telegram,
  whatsappCloud,
  whatsmiau,
} from '../src/channels/index.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  AgentService,
  type AgentStore,
  createAgentTables,
  DefaultRolesPolicy,
  defaultMessageTimestampFormat,
  type HistoryWindow,
  LucidAgentStore,
  type MessageTimestampsConfig,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  normalizeSentAt,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx } from './helpers/channels.js';
import { Journal } from './helpers/journal.js';
import { asStoreDb, makeMemoryDb, makeStoreDb } from './helpers/make-db.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
// 2026-10-23 11:17 in São Paulo.
const SENT = Date.UTC(2026, 9, 23, 14, 17, 5);
const SENT_ISO = new Date(SENT).toISOString();

describe('the adapters read the provider’s send time', () => {
  const evolution = evolutionApi({
    url: 'https://evo',
    instance: 'main',
    apiKey: 'k',
    webhookToken: 's',
  });
  const upsert = (messageTimestamp: unknown) => ({
    event: 'messages.upsert',
    instance: 'main',
    data: {
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'MSG1' },
      message: { conversation: 'começou a mamada agora' },
      ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
    },
  });

  it('Evolution: messageTimestamp in seconds, as a number, a string or a Long', () => {
    for (const value of [SENT / 1000 - 5, String(SENT / 1000 - 5), { low: SENT / 1000 - 5 }]) {
      const [message] = evolution.parse(upsert(value)) as InboundMessage[];
      expect(message?.sentAt).toBe(SENT - 5000);
    }
    const [none] = evolution.parse(upsert(undefined)) as InboundMessage[];
    expect(none).not.toHaveProperty('sentAt');
    const [garbage] = evolution.parse(upsert('soon')) as InboundMessage[];
    expect(garbage).not.toHaveProperty('sentAt');
  });

  it('Whatsmiau (Evolution’s format) reads it the same way', () => {
    const adapter = whatsmiau({
      url: 'http://whatsmiau:8080',
      instance: 'main',
      apiKey: 'k',
      webhookToken: 's',
    });
    const [message] = adapter.parse(upsert(1791420602)) as InboundMessage[];
    expect(message?.sentAt).toBe(1791420602000);
  });

  it('WhatsApp Cloud: the message’s timestamp (a string of seconds)', () => {
    const adapter = whatsappCloud({
      phoneNumberId: '1061',
      accessToken: 'EAAG',
      appSecret: 'app-secret',
      verifyToken: 'verify-me',
    });
    const parsed = adapter.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1061' },
                messages: [
                  {
                    from: '5511999990000',
                    id: 'wamid.1',
                    timestamp: String(SENT / 1000 - 5),
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }) as InboundMessage[];
    expect(parsed[0]?.sentAt).toBe(SENT - 5000);
  });

  it('Telegram: the message’s date; a button press has none', () => {
    const adapter = telegram({ botToken: '123:abc', secretToken: 'tg-secret' });
    const message = adapter.parse({
      update_id: 77,
      message: {
        message_id: 5,
        date: SENT / 1000 - 5,
        chat: { id: 42, type: 'private' },
        from: { id: 42, is_bot: false },
        text: 'hi',
      },
    }) as InboundMessage;
    expect(message.sentAt).toBe(SENT - 5000);
    const press = adapter.parse({
      update_id: 78,
      callback_query: {
        id: 'cq1',
        from: { id: 42 },
        data: 'x',
        message: { message_id: 6, date: 1, chat: { id: 42, type: 'private' } },
      },
    }) as InboundMessage;
    expect(press).not.toHaveProperty('sentAt');
  });
});

describe('the channel hands the send time to the turn', () => {
  function setup(coalesce: boolean) {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { adapter } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: false,
      actor: () => actor,
      thread: () => 't',
      ...(coalesce ? { coalesce: { quietMs: 60 } } : {}),
    });
    const say = async (text: string, extra: Partial<InboundMessage> = {}) => {
      const { ctx } = makeCtx(inbound(text, extra));
      await handle(ctx);
    };
    return { service, handle, say };
  }

  it('one message: its own sentAt', async () => {
    const { service, handle, say } = setup(false);
    await say('começou a mamada agora', { id: 'm-1', sentAt: SENT });
    await handle.drain();
    expect(service.sends[0]).toMatchObject({ sentAt: SENT });
  });

  it('a message without one sends none', async () => {
    const { service, handle, say } = setup(false);
    await say('hi', { id: 'm-1' });
    await handle.drain();
    expect(service.sends[0]).not.toHaveProperty('sentAt');
  });

  it('a coalesced burst: the first message’s', async () => {
    const { service, handle, say } = setup(true);
    await say('começou a mamada', { id: 'b-1', sentAt: SENT });
    await say('no esquerdo', { id: 'b-2', sentAt: SENT + 70_000 });
    await handle.drain();
    expect(service.sends).toHaveLength(1);
    expect(service.sends[0]).toMatchObject({
      message: 'começou a mamada\n\nno esquerdo',
      sentAt: SENT,
    });
  });
});

/** One loop turn, returning what the model was handed. */
async function pass(options: {
  store: AgentStore;
  threadId: string;
  journal?: Journal;
  messageTimestamps?: MessageTimestampsConfig;
  historyWindow?: HistoryWindow;
  sentAt?: string;
  userText?: string;
}): Promise<ModelMessage[]> {
  const sink = new InMemoryTokenStreamSink();
  const journal = options.journal ?? new Journal();
  let observed: ModelMessage[] = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args) => {
      observed = [...args.messages];
      return { text: 'anotado' };
    }),
    store: options.store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-10-23',
    systemPrompt: 'You are a test agent.',
    ...(options.messageTimestamps !== undefined
      ? { messageTimestamps: options.messageTimestamps }
      : {}),
    ...(options.historyWindow !== undefined ? { historyWindow: options.historyWindow } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => journal.at(name, () => fn()),
    patched: (id) => journal.patched(id),
  };
  journal.rewind();
  await runAgentLoop(
    deps,
    {
      threadId: options.threadId,
      actor: ACTOR,
      userText: options.userText ?? 'e agora?',
      ...(options.sentAt !== undefined ? { sentAt: options.sentAt } : {}),
    },
    hooks,
  );
  return observed;
}

/** A thread with an old exchange: the person's message sent at SENT (stored later), and one without. */
async function seeded(store: AgentStore) {
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  await store.appendMessage({
    threadId: thread.id,
    role: 'user',
    content: 'começou a mamada agora',
    sentAt: SENT_ISO,
  });
  await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'Anotei.' });
  const plain = await store.appendMessage({
    threadId: thread.id,
    role: 'user',
    content: 'trocou a fralda',
  });
  await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'Ok.' });
  return { thread, plainCreatedAt: plain.createdAt };
}

const SAO_PAULO: MessageTimestampsConfig = { timeZone: 'America/Sao_Paulo' };

describe('messageTimestamps: what the model reads', () => {
  it('off: the prompt and the load:thread payload are exactly what they were', async () => {
    const store = new InMemoryAgentStore();
    const { thread } = await seeded(store);
    const journal = new Journal();
    const observed = await pass({ store, threadId: thread.id, journal, sentAt: SENT_ISO });
    expect(observed.map((message) => message.content)).toEqual([
      'começou a mamada agora',
      'Anotei.',
      'trocou a fralda',
      'Ok.',
      'e agora?',
    ]);
    // The recorded rows are the prompt's: no send time rides into the checkpoint.
    expect(journal.recorded('load:thread')).not.toContain('sentAt');
    expect(journal.recorded('load:thread')).not.toContain('[sent');
  });

  it('on: every user message is labelled — sentAt, else createdAt — and nothing else is', async () => {
    const store = new InMemoryAgentStore();
    const { thread, plainCreatedAt } = await seeded(store);
    const now = SENT + 10 * 60_000;
    const observed = await pass({
      store,
      threadId: thread.id,
      messageTimestamps: SAO_PAULO,
      sentAt: new Date(now).toISOString(),
    });
    const fallback = defaultMessageTimestampFormat(new Date(plainCreatedAt), {
      timeZone: 'America/Sao_Paulo',
    });
    expect(observed.map((message) => message.content)).toEqual([
      '[sent 2026-10-23T11:17-03:00] começou a mamada agora',
      'Anotei.',
      `${fallback} trocou a fralda`,
      'Ok.',
      '[sent 2026-10-23T11:27-03:00] e agora?',
    ]);
  });

  it('never changes what is stored or what getThread returns', async () => {
    const store = new InMemoryAgentStore();
    const { thread } = await seeded(store);
    await pass({ store, threadId: thread.id, messageTimestamps: SAO_PAULO, sentAt: SENT_ISO });
    const read = await store.getThread(thread.id);
    expect(read?.messages.map((message) => message.content)).toEqual([
      'começou a mamada agora',
      'Anotei.',
      'trocou a fralda',
      'Ok.',
      'e agora?',
      'anotado',
    ]);
    expect(read?.messages[0]?.sentAt).toBe(SENT_ISO);
    expect(read?.messages[4]?.sentAt).toBe(SENT_ISO);
  });

  it('a zone per actor and a format of the app’s own', async () => {
    const store = new InMemoryAgentStore();
    const { thread } = await seeded(store);
    const zones: string[] = [];
    const observed = await pass({
      store,
      threadId: thread.id,
      sentAt: SENT_ISO,
      messageTimestamps: {
        timeZone: (who) => {
          zones.push(who.id);
          return 'America/Sao_Paulo';
        },
        format: (sentAt, ctx) => {
          const parts = new Intl.DateTimeFormat('pt-BR', {
            timeZone: ctx.timeZone,
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(sentAt);
          return ctx.message.content === 'trocou a fralda' ? '' : `[enviada ${parts}]`;
        },
      },
    });
    expect(zones).toEqual(['u1']);
    expect(observed[0]?.content).toBe('[enviada 23/10, 11:17] começou a mamada agora');
    // `''` leaves a message unlabelled.
    expect(observed[2]?.content).toBe('trocou a fralda');
  });

  it('a historyWindow selects over the labelled messages', async () => {
    const store = new InMemoryAgentStore();
    const { thread } = await seeded(store);
    const seen: string[][] = [];
    const window: HistoryWindow = {
      select(messages) {
        seen.push(messages.map((message) => message.content));
        return { keep: messages.slice(-3), drop: messages.slice(0, -3) };
      },
    };
    const observed = await pass({
      store,
      threadId: thread.id,
      messageTimestamps: SAO_PAULO,
      historyWindow: window,
      sentAt: SENT_ISO,
    });
    expect(seen[0]?.[0]).toBe('[sent 2026-10-23T11:17-03:00] começou a mamada agora');
    expect(observed.map((message) => message.content)).toEqual([
      expect.stringMatching(/^\[sent .*\] trocou a fralda$/),
      'Ok.',
      '[sent 2026-10-23T11:17-03:00] e agora?',
    ]);
  });

  it('a replay reads the labels back from load:thread, whatever the config says now', async () => {
    const store = new InMemoryAgentStore();
    const { thread } = await seeded(store);
    const journal = new Journal();
    const first = await pass({
      store,
      threadId: thread.id,
      journal,
      messageTimestamps: SAO_PAULO,
      sentAt: SENT_ISO,
    });
    // A resume from just after `load:thread` (the model call not yet recorded), under a different
    // zone: the recorded payload wins.
    const names = journal.names();
    for (let position = names.length - 1; position > names.indexOf('load:thread'); position -= 1) {
      journal.dropAt(position);
    }
    const replayed = await pass({
      store,
      threadId: thread.id,
      journal,
      messageTimestamps: { timeZone: 'Asia/Tokyo' },
      sentAt: SENT_ISO,
    });
    expect(replayed).toEqual(first);
  });
});

describe('defaultMessageTimestampFormat / normalizeSentAt', () => {
  it('ISO 8601 to the minute with the offset, Z in UTC, UTC for an unknown zone', () => {
    const at = new Date(SENT);
    expect(defaultMessageTimestampFormat(at, { timeZone: 'America/Sao_Paulo' })).toBe(
      '[sent 2026-10-23T11:17-03:00]',
    );
    expect(defaultMessageTimestampFormat(at, { timeZone: 'UTC' })).toBe('[sent 2026-10-23T14:17Z]');
    expect(defaultMessageTimestampFormat(at, { timeZone: 'Nowhere/Atlantis' })).toBe(
      '[sent 2026-10-23T14:17Z]',
    );
  });

  it('reads a Date, ISO or epoch ms; drops garbage; caps the future at now', () => {
    const now = SENT + 1000;
    expect(normalizeSentAt(new Date(SENT), now)).toBe(SENT_ISO);
    expect(normalizeSentAt(SENT_ISO, now)).toBe(SENT_ISO);
    expect(normalizeSentAt(SENT, now)).toBe(SENT_ISO);
    expect(normalizeSentAt('yesterday', now)).toBeUndefined();
    expect(normalizeSentAt(undefined, now)).toBeUndefined();
    expect(normalizeSentAt(SENT + 60_000, now)).toBe(new Date(now).toISOString());
  });
});

describe('LucidAgentStore keeps sent_at', () => {
  let db: Database | undefined;
  afterEach(async () => {
    await db?.manager.closeAll();
    db = undefined;
  });

  it('round-trips it through the turn read, and a fork copies it', async () => {
    db = await makeStoreDb();
    const store = new LucidAgentStore(asStoreDb(db));
    const { thread } = await seeded(store);
    const page = await store.loadThreadForTurn({ threadId: thread.id });
    expect(page?.messages[0]?.sentAt).toBe(SENT_ISO);
    expect(page?.messages[2]).not.toHaveProperty('sentAt');
    const observed = await pass({
      store,
      threadId: thread.id,
      messageTimestamps: SAO_PAULO,
      sentAt: SENT_ISO,
    });
    expect(observed[0]?.content).toBe('[sent 2026-10-23T11:17-03:00] começou a mamada agora');
    const fork = await store.forkThread(thread.id, page?.messages[1]?.id ?? '');
    expect((await store.getThread(fork.id))?.messages[0]?.sentAt).toBe(SENT_ISO);
  });

  it('queues it with a waiting message', async () => {
    db = await makeStoreDb();
    const store = new LucidAgentStore(asStoreDb(db));
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    const queued = await store.enqueueMessage({
      threadId: thread.id,
      actor: ACTOR,
      content: 'x',
      sentAt: SENT_ISO,
    });
    expect(queued.sentAt).toBe(SENT_ISO);
  });

  it('createAgentTables adds the columns to a database from before them', async () => {
    db = makeMemoryDb();
    await createAgentTables(asStoreDb(db));
    const raw = db.connection('sqlite');
    await raw.rawQuery('ALTER TABLE agent_message DROP COLUMN sent_at');
    await raw.rawQuery('ALTER TABLE agent_queued_message DROP COLUMN sent_at');
    const repairs = await createAgentTables(asStoreDb(db));
    expect(repairs).toEqual(
      expect.arrayContaining(['agent_message.sent_at', 'agent_queued_message.sent_at']),
    );
    expect(await raw.schema.hasColumn('agent_message', 'sent_at')).toBe(true);
  });

  it('autoCreateTables off, before the migration: sends still work, without the send time', async () => {
    db = makeMemoryDb();
    await createAgentTables(asStoreDb(db));
    const raw = db.connection('sqlite');
    await raw.rawQuery('ALTER TABLE agent_message DROP COLUMN sent_at');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const store = new LucidAgentStore(asStoreDb(db), { autoCreateTables: false });
      const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
      const appended = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'hi',
        sentAt: SENT_ISO,
      });
      expect(appended).not.toHaveProperty('sentAt');
      const page = await store.loadThreadForTurn({ threadId: thread.id });
      expect(page?.messages.map((message) => message.content)).toEqual(['hi']);
    } finally {
      console.warn = warn;
    }
  });
});

/** Answers every turn, recording each prompt; one message can be held mid-turn. */
class RecordingModel implements ModelProvider {
  readonly prompts: ModelMessage[][] = [];
  private release: (() => void) | undefined;
  private hold: Promise<void> | undefined;
  holdNext(): void {
    this.hold = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  releaseHeld(): void {
    this.release?.();
  }
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push([...args.messages]);
    const hold = this.hold;
    this.hold = undefined;
    await hold;
    await args.sink.write({ t: 'text', v: 'ok' });
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

describe('a send names its time (service, HTTP, queue)', () => {
  let booted: BootedApp | undefined;
  afterEach(async () => {
    await booted?.close();
    booted = undefined;
  });

  async function boot() {
    const model = new RecordingModel();
    const store = new InMemoryAgentStore();
    booted = await bootAgentApp({
      model,
      store: 'memory',
      stores: { memory: async () => store },
      messageTimestamps: SAO_PAULO,
    });
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    return { model, store, threadId: thread.id, url: booted.url };
  }

  async function settled(store: InMemoryAgentStore, threadId: string, answers: number) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const thread = await store.getThread(threadId);
      const done =
        thread !== null &&
        (thread.activeRunId ?? null) === null &&
        thread.messages.filter((message) => message.role === 'assistant').length >= answers;
      if (done) return thread;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('POST chat { sentAt } is stored and labelled', async () => {
    const { model, store, threadId, url } = await boot();
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify({ threadId, message: 'começou agora', sentAt: SENT_ISO }),
    });
    await response.text();
    const thread = await settled(store, threadId, 1);
    expect(thread.messages[0]).toMatchObject({ content: 'começou agora', sentAt: SENT_ISO });
    expect(model.prompts[0]?.at(-1)?.content).toBe('[sent 2026-10-23T11:17-03:00] começou agora');
  });

  it('a queued send keeps the time it was queued, not the time it started', async () => {
    const { model, store, threadId } = await boot();
    const service = await booted!.app.container.make(AgentService);
    model.holdNext();
    await service.send({ actor: { id: 'u1' }, threadId, message: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const queuedAt = Date.now();
    const queued = await service.send({ actor: { id: 'u1' }, threadId, message: 'second' });
    expect(queued).toMatchObject({ queued: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    model.releaseHeld();
    const thread = await settled(store, threadId, 2);
    const second = thread.messages.find((message) => message.content === 'second');
    expect(second?.sentAt).toBeDefined();
    const sentAt = Date.parse(second?.sentAt ?? '');
    expect(sentAt).toBeGreaterThanOrEqual(queuedAt - 5);
    // Stored when its turn started — at least the 120ms it waited after being queued.
    expect(Date.parse(second?.createdAt ?? '') - sentAt).toBeGreaterThanOrEqual(100);
  });
});
