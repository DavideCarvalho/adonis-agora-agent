import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelHandleOptions,
  type ChannelTurnEnded,
  type ChannelWorkflowEngine,
  channels,
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

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const never = <T = never>() => new Promise<T>(() => {});

const engineOver = (durableStore: InMemoryStateStore) =>
  new WorkflowEngine({ store: durableStore }) as unknown as ChannelWorkflowEngine & WorkflowEngine;

/** A handler whose `onTurnEnded` calls are recorded (the error left out, its message kept). */
function handler(
  service: FakeService,
  options: Partial<ChannelHandleOptions> = {},
  adapterCapabilities = {},
) {
  const { adapter, outbox } = fakeAdapter(adapterCapabilities);
  const events: string[] = [];
  adapter.acknowledge = async (message) => {
    events.push(`ack:${message.text}`);
  };
  const send = adapter.send;
  adapter.send = async (conversation, message) => {
    events.push(`sent:${message.text}`);
    await send(conversation, message);
  };
  const ended: ChannelTurnEnded[] = [];
  const handle = channels.handle(adapter, {
    service,
    store: new InMemoryChannelStore(),
    durable: false,
    actor: () => actor,
    thread: () => 't',
    onTurnEnded: (turn) => {
      ended.push(turn);
      events.push(`ended:${turn.outcome}`);
    },
    ...options,
  });
  const say = async (text: string, extra = {}) => {
    await handle(makeCtx(inbound(text, extra)).ctx);
    await handle.drain();
  };
  return { handle, outbox, ended, events, say };
}

const outcomes = (ended: ChannelTurnEnded[]) => ended.map((turn) => turn.outcome);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('onTurnEnded', () => {
  it('is told once, after the reply went out, with the turn', async () => {
    const service = fakeService([{ t: 'text', v: 'Hello' }]);
    const { ended, events, say } = handler(service);
    await say('hi', { id: 'm-1' });
    expect(ended).toEqual([
      {
        channel: 'test',
        conversation: 'chat-1',
        actor,
        message: expect.objectContaining({ id: 'm-1', text: 'hi' }),
        runId: 'run-1',
        threadId: 't',
        outcome: 'replied',
      },
    ]);
    expect(events).toEqual(['ack:hi', 'sent:Hello', 'ended:replied']);
  });

  it('is told once per message read, in order', async () => {
    const service = fakeService([{ t: 'text', v: 'ok' }]);
    const { ended, say } = handler(service);
    await say('one');
    await say('two');
    await say('three');
    expect(ended.map((turn) => [turn.message?.text, turn.runId, turn.outcome])).toEqual([
      ['one', 'run-1', 'replied'],
      ['two', 'run-2', 'replied'],
      ['three', 'run-3', 'replied'],
    ]);
  });

  it('is told after a turn that sent nothing (silent, or every message refused)', async () => {
    const silent = handler(fakeService([]));
    await silent.say('hi');
    expect(silent.outbox).toEqual([]);
    expect(outcomes(silent.ended)).toEqual(['replied']);

    const refused = handler(fakeService([{ t: 'text', v: 'secret' }]), {
      canDeliver: () => false,
    });
    await refused.say('hi');
    expect(refused.outbox).toEqual([]);
    expect(outcomes(refused.ended)).toEqual(['replied']);
  });

  it('is told after a failed turn, a timed-out one and a blocked one', async () => {
    const failed = handler(
      fakeService([{ t: 'error', code: 'run_failed', message: 'boom' } as StreamFrame]),
    );
    await failed.say('hi');
    expect(texts(failed.outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
    expect(outcomes(failed.ended)).toEqual(['failed']);

    const cancelled: string[] = [];
    const slow = fakeService(
      () =>
        (async function* (): AsyncGenerator<StreamFrame> {
          yield* await never<StreamFrame[]>();
        })(),
      {
        cancel: async (runId) => {
          cancelled.push(runId);
        },
      },
    );
    const timedOut = handler(slow, { timeoutMs: 20 });
    await timedOut.say('hi');
    expect(cancelled).toEqual(['run-1']);
    expect(timedOut.ended.map((turn) => [turn.runId, turn.outcome])).toEqual([
      ['run-1', 'timeout'],
    ]);

    const blocked = handler(
      fakeService([
        { t: 'approval', runId: 'run-1', id: 'call-1', toolName: 'refund', input: {} },
      ] as StreamFrame[]),
    );
    await blocked.say('refund');
    expect(outcomes(blocked.ended)).toEqual(['blocked']);
  });

  it('is told when the job fails after its retries, with the error — onError too', async () => {
    const boom = new Error('provider down');
    const errors: unknown[] = [];
    const { adapter } = fakeAdapter();
    adapter.send = async () => {
      throw boom;
    };
    const ended: ChannelTurnEnded[] = [];
    const handle = channels.handle(adapter, {
      service: fakeService([{ t: 'text', v: 'Hello' }]),
      store: new InMemoryChannelStore(),
      durable: false,
      retry: { attempts: 2, backoffMs: 1 },
      actor: () => actor,
      thread: () => 't',
      onError: (error) => errors.push(error),
      onTurnEnded: (turn) => {
        ended.push(turn);
      },
    });
    await handle(makeCtx(inbound('hi')).ctx);
    await handle.drain();
    expect(errors).toEqual([boom]);
    // Once for the job, not once per attempt of its phase.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'failed', error: boom, runId: 'run-1' });
  });

  it('is told when no turn ran: an unknown sender, a beforeTurn stop, nothing to answer', async () => {
    const unknown = handler(fakeService([]), { actor: () => null });
    await unknown.say('hi');
    expect(unknown.events).toEqual(['ack:hi', 'ended:stopped']);
    expect(unknown.ended[0]).toMatchObject({ actor: null, runId: null, outcome: 'stopped' });

    const gated = handler(fakeService([]), {
      beforeTurn: (message) => (message.text === 'quiet' ? 'stop' : { reply: 'Accept the terms.' }),
    });
    await gated.say('quiet');
    await gated.say('terms');
    expect(texts(gated.outbox)).toEqual(['Accept the terms.']);
    expect(gated.ended.map((turn) => [turn.actor?.id, turn.runId, turn.outcome])).toEqual([
      ['u1', null, 'stopped'],
      ['u1', null, 'stopped'],
    ]);

    const service = fakeService([]);
    const empty = handler(service);
    await empty.say('   ');
    expect(service.sends).toEqual([]);
    expect(empty.ended[0]).toMatchObject({ actor, threadId: 't', runId: null, outcome: 'handled' });
  });

  it('a hook that throws is logged and changes nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errors: unknown[] = [];
    const { adapter, outbox } = fakeAdapter();
    let calls = 0;
    const handle = channels.handle(adapter, {
      service: fakeService([{ t: 'text', v: 'ok' }]),
      store: new InMemoryChannelStore(),
      durable: false,
      actor: () => actor,
      thread: () => 't',
      onError: (error) => errors.push(error),
      onTurnEnded: async () => {
        calls += 1;
        throw new Error('presence service down');
      },
    });
    await handle(makeCtx(inbound('one')).ctx);
    await handle(makeCtx(inbound('two')).ctx);
    await handle.drain();
    expect(texts(outbox)).toEqual(['ok', 'ok']);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      '[@adonis-agora/agent] Channel onTurnEnded failed',
      expect.objectContaining({ channel: 'test', message: 'presence service down' }),
    );
  });

  it('a question parks the turn; the run resumed after its timeout is told on its own', async () => {
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
    const { ended, outbox, say } = handler(service, { questionTimeoutMs: 30 });
    await say('order');
    await until(() => texts(outbox).at(-1) === 'Went with defaults.');
    await until(() => ended.length === 2);
    expect(ended.map((turn) => [turn.message?.text ?? null, turn.runId, turn.outcome])).toEqual([
      ['order', 'run-1', 'parked'],
      // The resumed run: no message of its own.
      [null, 'run-1', 'replied'],
    ]);
    expect(ended[1]).toMatchObject({ actor, threadId: 't', conversation: 'chat-1' });
  });

  it('runs under a durable engine too — once for the message, once for its resumed run', async () => {
    const engine = engineOver(new InMemoryStateStore());
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
    const { handle, ended, outbox, say } = handler(service, {
      durable: engine,
      questionTimeoutMs: 30,
    });
    await say('order');
    expect(outcomes(ended)).toEqual(['parked']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.resumeDueTimers();
    await engine.waitForRun('agora.channel:test:timeout:run-1:ask-1', { terminal: true });
    await handle.drain();
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
    expect(ended.map((turn) => [turn.message?.text ?? null, turn.runId, turn.outcome])).toEqual([
      ['order', 'run-1', 'parked'],
      [null, 'run-1', 'replied'],
    ]);
  });
});
