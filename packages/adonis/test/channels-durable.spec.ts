import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { describe, expect, it } from 'vitest';
import {
  type ChannelWorkflowEngine,
  channels,
  InMemoryChannelStore,
} from '../src/channels/index.js';
import type { ElicitationRequest } from '../src/elicitation.js';
import type { StreamFrame } from '../src/spi/token-stream-sink.js';
import { actor, fakeAdapter, fakeService, inbound, makeCtx, texts } from './helpers/channels.js';

/** Wait until `check` holds. */
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const never = <T = never>() => new Promise<T>(() => {});

/**
 * A process that dies: its engine keeps holding the run (a hung step never settles), and a second
 * engine over the same durable store — the restarted process, its clock past the dead one's lease —
 * recovers the run with a handler created again under the same channel name.
 */
function restart(durableStore: InMemoryStateStore) {
  return new WorkflowEngine({
    store: durableStore,
    clock: () => Date.now() + 10 * 60_000,
  }) as unknown as ChannelWorkflowEngine & WorkflowEngine;
}

const engineOver = (durableStore: InMemoryStateStore) =>
  new WorkflowEngine({ store: durableStore }) as unknown as ChannelWorkflowEngine & WorkflowEngine;

describe('durable channels (an @adonis-agora/durable engine)', () => {
  it('persists the message before the 200 and answers it as a run', async () => {
    const durableStore = new InMemoryStateStore();
    const engine = engineOver(durableStore);
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ t: 'text', v: 'Hello **there**' }]);
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    const { ctx, sent } = makeCtx(inbound('hi', { id: 'm-1' }));
    await handle(ctx);
    expect(sent).toEqual({ status: 200, body: { ok: true } });
    // The message is a run of the channel workflow, under an id derived from the message's.
    const run = await engine.getRun('agora.channel:test:message:m-1');
    expect(run?.workflow).toBe('agora.channel.job');
    expect(run?.input).toMatchObject({ kind: 'message', conversation: 'chat-1' });
    await handle.drain();
    expect(texts(outbox)).toEqual(['Hello *there*']);
    expect((await engine.getRun('agora.channel:test:message:m-1'))?.status).toBe('completed');
  });

  it('answers 500 (and keeps the message retryable) when the engine cannot take it', async () => {
    const { adapter } = fakeAdapter();
    const store = new InMemoryChannelStore();
    let down = true;
    const engine: ChannelWorkflowEngine = {
      register: () => {},
      start: async () => {
        if (down) throw new Error('database unavailable');
        return {};
      },
    };
    const events: unknown[] = [];
    const handle = channels.handle(adapter, {
      service: fakeService([]),
      store,
      durable: engine,
      actor: () => actor,
      thread: () => 't',
      onWebhook: (event) => {
        events.push({ status: event.status, accepted: event.accepted });
      },
    });
    const first = makeCtx(inbound('hi', { id: 'm-1' }));
    await handle(first.ctx);
    expect(first.sent.status).toBe(500);
    down = false;
    const retried = makeCtx(inbound('hi', { id: 'm-1' }));
    await handle(retried.ctx);
    expect(retried.sent.status).toBe(200);
    expect(events).toEqual([
      { status: 'failed', accepted: 0 },
      { status: 'accepted', accepted: 1 },
    ]);
  });

  it('a crash between the 200 and the reply: the restarted process answers once, without a second turn', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const { adapter, outbox } = fakeAdapter();
    // The first process starts the turn and dies while reading it.
    const dying = fakeService(() =>
      (async function* (): AsyncGenerator<StreamFrame> {
        yield* await never<StreamFrame[]>();
      })(),
    );
    const first = channels.handle(adapter, {
      service: dying,
      store,
      durable: engineOver(durableStore),
      actor: () => actor,
      thread: () => 't',
    });
    await first(makeCtx(inbound('hi', { id: 'm-1' })).ctx);
    await until(() => dying.subscribed.length === 1);
    expect(dying.sends).toHaveLength(1);
    expect(outbox).toEqual([]);

    // The restarted process: the turn has finished meanwhile; its stream replays from the start.
    const engine = restart(durableStore);
    const alive = fakeService([{ t: 'text', v: 'The answer.' }]);
    const after = channels.handle(adapter, {
      service: alive,
      store,
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    await engine.recoverIncomplete();
    await engine.waitForRun('agora.channel:test:message:m-1', { terminal: true });
    await after.drain();
    // The turn was not started again: the recovered run read the one it had started.
    expect(alive.sends).toEqual([]);
    expect(alive.subscribed).toEqual(['run-1']);
    expect(texts(outbox)).toEqual(['The answer.']);

    // Recovered again (another replica, another tick): nothing more goes out.
    await engine.recoverIncomplete();
    expect(texts(outbox)).toEqual(['The answer.']);
  });

  it('a crash after the turn completed but before its reply went out: relayed once after recovery', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const { adapter, outbox } = fakeAdapter();
    const frames: StreamFrame[] = [
      { t: 'text', v: 'Your exam is saved.' },
      {
        t: 'approval',
        runId: 'run-1',
        id: 'call-1',
        toolName: 'share',
        input: {},
        target: { kind: 'proposal', proposalId: 'proposal-1' },
        confirmation: { title: 'Share it?', verb: 'Share' },
      },
    ];
    // Every frame of the turn arrived, then the process died before the stream's end was read
    // (nothing is sent before the end).
    const dying = fakeService(() =>
      (async function* () {
        yield* frames;
        await never();
      })(),
    );
    const first = channels.handle(adapter, {
      service: dying,
      store,
      durable: engineOver(durableStore),
      actor: () => actor,
      thread: () => 't',
    });
    await first(makeCtx(inbound('save it', { id: 'm-1' })).ctx);
    await until(() => dying.subscribed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbox).toEqual([]);

    const engine = restart(durableStore);
    const alive = fakeService(frames);
    channels.handle(adapter, {
      service: alive,
      store,
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    await engine.recoverIncomplete();
    await engine.waitForRun('agora.channel:test:message:m-1', { terminal: true });
    expect(texts(outbox)).toEqual([
      'Your exam is saved.',
      '*Share it?*\n\nReply *yes* to confirm or *no* to cancel.',
    ]);
    // The same webhook delivered again after the restart: deduplicated, nothing more.
    const handle = channels.handle(adapter, {
      service: alive,
      store,
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('save it', { id: 'm-1' })).ctx);
    await handle.drain();
    expect(outbox).toHaveLength(2);
    expect(alive.sends).toEqual([]);
  });

  it('retries a failed delivery with backoff, sending each message once', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter({ maxLength: 20 });
    let failures = 1;
    const send = adapter.send;
    adapter.send = async (conversation, message) => {
      // The second piece fails once (a provider 5xx).
      if (outbox.length === 1 && failures-- > 0) throw new Error('provider unavailable');
      await send(conversation, message);
    };
    const service = fakeService([{ t: 'text', v: 'First piece here.\n\nSecond piece here.' }]);
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: engine,
      retry: { attempts: 3, backoffMs: 5 },
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['First piece here.', 'Second piece here.']);
    expect(service.sends).toHaveLength(1);
  });

  it('handles the messages of one conversation in order, one at a time — others in parallel', async () => {
    const engine = engineOver(new InMemoryStateStore());
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
      store: new InMemoryChannelStore(),
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('first', { id: 'a1' })).ctx);
    await until(() => service.sends.length === 1);
    await handle(makeCtx(inbound('second', { id: 'a2' })).ctx);
    await handle(makeCtx(inbound('elsewhere', { id: 'b1', conversation: 'chat-2' })).ctx);
    await until(() => outbox.length === 1);
    // The other conversation was answered; this one's second message waits for the first.
    expect(outbox[0]).toEqual({ conversation: 'chat-2', message: { text: 'answer to run-2' } });
    expect(service.sends.map((send) => send.message)).toEqual(['first', 'elsewhere']);
    release();
    await handle.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-2', 'answer to run-2'],
      ['chat-1', 'answer to run-1'],
      ['chat-1', 'answer to run-3'],
    ]);
  });

  it('a question does not hold the conversation: its answer resumes the run', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
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
      ],
    };
    let answered!: () => void;
    const answer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const calls: unknown[] = [];
    const service = fakeService(
      async function* () {
        yield { t: 'text', v: 'Let me check.' };
        yield { t: 'elicitation', runId: 'run-1', id: 'ask-1', request };
        await answer;
        yield { t: 'text', v: 'Ordered a large one.' };
      },
      {
        answer: async (args) => {
          calls.push(args.answers);
          answered();
        },
      },
    );
    const handle = channels.handle(adapter, {
      service,
      store: new InMemoryChannelStore(),
      durable: engine,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('order a shirt', { id: 'q1' })).ctx);
    await until(() => outbox.length === 2);
    await handle(makeCtx(inbound('2', { id: 'q2' })).ctx);
    await handle.drain();
    expect(calls).toEqual([{ size: ['l'] }]);
    expect(texts(outbox)).toEqual([
      'Let me check.',
      '*Which size?*\n\n1. Small\n2. Large\n\nReply with the number of your choice.',
      'Ordered a large one.',
    ]);
    expect(service.sends).toHaveLength(1);
  });
});

describe('durable questions', () => {
  it('a question nobody answers is skipped by a durable timer, and the run’s rest is sent', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
    let resumed!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const request: ElicitationRequest = {
      id: 'ask-1',
      source: 'ask',
      questions: [{ id: 'note', prompt: 'Anything else?', input: { type: 'text' }, defaults: [] }],
    };
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
      store: new InMemoryChannelStore(),
      durable: engine,
      questionTimeoutMs: 30,
      actor: () => actor,
      thread: () => 't',
    });
    await handle(makeCtx(inbound('order')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['*Anything else?*']);
    // The timer is a run of its own, started for later, outside the conversation's order.
    const timer = await engine.getRun('agora.channel:test:timeout:run-1:ask-1');
    expect(timer?.workflow).toBe('agora.channel.timer');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.resumeDueTimers();
    await engine.waitForRun('agora.channel:test:timeout:run-1:ask-1', { terminal: true });
    await handle.drain();
    expect(service.skipped).toHaveLength(1);
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
  });
});
