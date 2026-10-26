import { describe, expect, it, vi } from 'vitest';
import type { RedisStreamClient, StreamFrame } from '../src/index.js';
import {
  InProcessTokenStreamSink,
  RedisTokenStreamSink,
  type TokenStreamSink,
  tokenSinks,
} from '../src/index.js';

/**
 * An in-memory stand-in for a Redis server (NOT a client) shared across sink instances — modelling the
 * one thing a real multi-replica deployment shares: the Redis server itself. Each `redis.client()`
 * returns an independent {@link RedisStreamClient} view over the SAME lists/values/subscriptions, so a
 * write on one replica's sink is visible to a subscriber on another replica's sink.
 */
class FakeRedisServer {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, string>();
  readonly subs = new Map<string, Set<(message: string) => void>>();
  /** Last TTL (seconds) set per key via EXPIRE — lets tests assert keys are bounded. */
  readonly ttls = new Map<string, number>();

  client(): RedisStreamClient {
    return {
      rpush: async (key, value) => {
        const list = this.lists.get(key) ?? [];
        list.push(value);
        this.lists.set(key, list);
      },
      lrange: async (key, start, stop) => {
        const list = this.lists.get(key) ?? [];
        return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
      },
      set: async (key, value) => {
        this.values.set(key, value);
      },
      get: async (key) => this.values.get(key) ?? null,
      publish: async (channel, message) => {
        // Deliver asynchronously, like a real pub/sub — proves the notify bridge, not a sync coincidence.
        for (const handler of [...(this.subs.get(channel) ?? [])]) {
          queueMicrotask(() => handler(message));
        }
      },
      subscribe: async (channel, onMessage) => {
        const handlers = this.subs.get(channel) ?? new Set();
        handlers.add(onMessage);
        this.subs.set(channel, handlers);
        return async () => {
          handlers.delete(onMessage);
        };
      },
      del: async (...keys) => {
        for (const key of keys) {
          this.lists.delete(key);
          this.values.delete(key);
        }
      },
      expire: async (key, seconds) => {
        this.ttls.set(key, seconds);
      },
    };
  }
}

function text(v: string): StreamFrame {
  return { t: 'text', v };
}

async function collect(iterable: AsyncIterable<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const frame of iterable) {
    out.push(frame);
  }
  return out;
}

function textOf(frames: StreamFrame[]): string {
  return frames.map((frame) => (frame.t === 'text' ? frame.v : '')).join('');
}

describe('RedisTokenStreamSink', () => {
  it('fans a run across replicas: a subscriber on replica B receives frames a writer on replica A published', async () => {
    const server = new FakeRedisServer();
    const replicaA = new RedisTokenStreamSink(server.client());
    const replicaB = new RedisTokenStreamSink(server.client());

    // Replica B serves the SSE (subscribes first), replica A runs the model.
    const collected = collect(replicaB.subscribe('run-x'));
    const writer = replicaA.open('run-x');
    await writer.write(text('Hel'));
    await writer.write(text('lo, '));
    await writer.write(text('world'));
    await writer.end();

    const frames = await collected;
    expect(textOf(frames)).toBe('Hello, world');
    // Tokens written within the flush window arrive as one frame holding their concatenation.
    expect(frames).toEqual([text('Hello, world')]);
  });

  it('replays buffered chunks for a late subscriber that connects after the run ended', async () => {
    const server = new FakeRedisServer();
    const writerSink = new RedisTokenStreamSink(server.client());
    const writer = writerSink.open('run-late');
    await writer.write(text('a'));
    await writer.write(text('b'));
    await writer.end();

    const readerSink = new RedisTokenStreamSink(server.client());
    expect(textOf(await collect(readerSink.subscribe('run-late')))).toBe('ab');
  });

  it('produces a frame stream identical to the in-process sink (unchanged SSE envelope, now typed frames)', async () => {
    const inProcess = new InProcessTokenStreamSink();
    const wIn = inProcess.open('run-eq');
    await wIn.write({ t: 'text', v: 'a' });
    await wIn.write({ t: 'component', name: 'x', data: { n: 1 } });
    wIn.end();
    const inFrames = await collect(inProcess.subscribe('run-eq'));

    const server = new FakeRedisServer();
    const redis = new RedisTokenStreamSink(server.client());
    const wRe = redis.open('run-eq');
    await wRe.write({ t: 'text', v: 'a' });
    await wRe.write({ t: 'component', name: 'x', data: { n: 1 } });
    await wRe.end();
    const reFrames = await collect(redis.subscribe('run-eq'));

    // Same frames, same order → identical agent-protocol SSE output.
    expect(reFrames).toEqual(inFrames);
  });

  it('ends the subscriber stream when the writer ends (no hang)', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client());
    const writer = sink.open('run-end');
    await writer.write(text('x'));
    await writer.end();

    // If `end()` did not terminate the stream, this `for await` would never resolve.
    expect(textOf(await collect(sink.subscribe('run-end')))).toBe('x');
  });

  it('close() drops the run buffer and terminal marker so the shared keys are cleaned up', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client());
    const writer = sink.open('run-close');
    await writer.write(text('gone'));
    await writer.end();
    expect(server.lists.size).toBeGreaterThan(0);
    expect(server.values.size).toBeGreaterThan(0);

    await sink.close('run-close');
    expect(server.lists.size).toBe(0);
    expect(server.values.size).toBe(0);
  });

  it('sets a TTL on the chunks and state keys so they self-expire (no leak without close())', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client(), { ttlSeconds: 120 });
    const writer = sink.open('run-ttl');
    await writer.write(text('x'));
    await writer.end();

    expect(server.ttls.get('agent:stream:run-ttl:chunks')).toBe(120);
    expect(server.ttls.get('agent:stream:run-ttl:state')).toBe(120);
  });

  it('applies a 1h default TTL, and ttlSeconds: 0 disables expiry', async () => {
    const server = new FakeRedisServer();
    const wDefault = new RedisTokenStreamSink(server.client()).open('run-default');
    await wDefault.write(text('a'));
    await wDefault.end();
    expect(server.ttls.get('agent:stream:run-default:chunks')).toBe(3600);

    const off = new FakeRedisServer();
    const wOff = new RedisTokenStreamSink(off.client(), { ttlSeconds: 0 }).open('run-off');
    await wOff.write(text('a'));
    await wOff.end();
    expect(off.ttls.size).toBe(0);
  });

  it('honours a custom keyPrefix for its list, state and channel keys', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client(), { keyPrefix: 'custom:ns' });
    // A subscriber registers the pub/sub channel; the writer creates the list + state keys.
    const collected = collect(sink.subscribe('run-1'));
    const writer = sink.open('run-1');
    await writer.write(text('hi'));
    await writer.end();
    await collected;

    expect([...server.lists.keys()]).toContain('custom:ns:run-1:chunks');
    expect([...server.values.keys()]).toContain('custom:ns:run-1:state');
    expect([...server.subs.keys()]).toContain('custom:ns:run-1');
  });
});

/** {@link FakeRedisServer}'s client, counting every command it is sent. */
function countingClient(server: FakeRedisServer, options: { pipelined?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const inner = server.client();
  const count = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    ((...args: A) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(...args);
    }) as (...args: A) => R;
  const client: RedisStreamClient = {
    rpush: count('rpush', inner.rpush),
    lrange: count('lrange', inner.lrange),
    set: count('set', inner.set),
    get: count('get', inner.get),
    publish: count('publish', inner.publish),
    subscribe: count('subscribe', inner.subscribe),
    del: count('del', inner.del),
    expire: count('expire', inner.expire as NonNullable<RedisStreamClient['expire']>),
    ...(options.pipelined === true
      ? {
          append: count(
            'append',
            async (key: string, value: string, ttl: number, channel: string, message: string) => {
              await inner.rpush(key, value);
              if (ttl > 0) await inner.expire?.(key, ttl);
              await inner.publish(channel, message);
            },
          ),
        }
      : {}),
  };
  return { client, calls };
}

const stepFrame = (index: number): StreamFrame => ({
  t: 'event',
  event: { kind: 'step-start', index } as never,
});

/** `promise`'s value, or `'pending'` when it has not settled within a few hundred ms. */
function settlesSoon<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 300)),
  ]);
}

describe('RedisTokenStreamSink round trips', () => {
  it('pushes a streamed answer as a handful of frames, not three commands per token', async () => {
    const server = new FakeRedisServer();
    const { client, calls } = countingClient(server);
    const writer = new RedisTokenStreamSink(client).open('run-tokens');
    const tokens = Array.from({ length: 200 }, (_, index) => `t${index} `);
    for (const token of tokens) await writer.write(text(token));
    await writer.end();

    expect(
      textOf(await collect(new RedisTokenStreamSink(server.client()).subscribe('run-tokens'))),
    ).toBe(tokens.join(''));
    expect(calls.rpush).toBe(1);
    expect(calls.publish).toBe(2);
  });

  it('coalesces reasoning deltas and one tool call’s argument deltas too', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client());
    const writer = sink.open('run-deltas');
    for (let i = 0; i < 20; i++) {
      await writer.write({ t: 'event', event: { kind: 'reasoning', text: `${i}` } });
    }
    for (let i = 0; i < 20; i++) {
      await writer.write({
        t: 'event',
        event: { kind: 'tool-input-delta', id: 'c1', delta: `${i}` },
      });
    }
    await writer.end();
    const digits = Array.from({ length: 20 }, (_, i) => `${i}`).join('');
    expect(await collect(sink.subscribe('run-deltas'))).toEqual([
      { t: 'event', event: { kind: 'reasoning', text: digits } },
      { t: 'event', event: { kind: 'tool-input-delta', id: 'c1', delta: digits } },
    ]);
  });

  it('writes each frame in one round trip when the client can pipeline', async () => {
    const server = new FakeRedisServer();
    const { client, calls } = countingClient(server, { pipelined: true });
    const writer = new RedisTokenStreamSink(client).open('run-pipelined');
    for (let index = 0; index < 5; index++) await writer.write(stepFrame(index));
    await writer.end();
    expect(calls.append).toBe(5);
    expect(calls.rpush ?? 0).toBe(0);
    expect(calls.expire ?? 0).toBe(2); // the end marker's TTLs
    expect(
      (await collect(new RedisTokenStreamSink(server.client()).subscribe('run-pipelined'))).length,
    ).toBe(5);
  });

  it('reads the terminal marker once per subscription, not once per frame', async () => {
    const server = new FakeRedisServer();
    const reader = countingClient(server);
    const followed = collect(new RedisTokenStreamSink(reader.client).subscribe('run-live'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const writer = new RedisTokenStreamSink(server.client()).open('run-live');
    for (let index = 0; index < 30; index++) {
      await writer.write(stepFrame(index));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await writer.end();
    expect((await followed).length).toBe(30);
    expect(reader.calls.get).toBe(1);
  });
});

describe('RedisTokenStreamSink subscriber', () => {
  it('follows a run whose list started over under it, without skipping a frame', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client());
    const writer = sink.open('run-restart');
    for (let index = 0; index < 3; index++) await writer.write(stepFrame(index));
    const iterator = sink.subscribe('run-restart')[Symbol.asyncIterator]();
    for (let index = 0; index < 3; index++) {
      expect((await iterator.next()).value).toEqual(stepFrame(index));
    }
    // Parked past the TTL: the keys expire (no message), then the run writes again.
    server.lists.clear();
    server.values.clear();
    await writer.write(stepFrame(10));
    await writer.write(stepFrame(11));
    await writer.end();
    const rest: unknown[] = [];
    for (let next = await settlesSoon(iterator.next()); next !== 'pending' && !next.done; ) {
      rest.push(next.value);
      next = await settlesSoon(iterator.next());
    }
    expect(rest).toEqual([stepFrame(10), stepFrame(11)]);
  });

  it('ends when the run’s keys expired under it, on its next quiet check', async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeRedisServer();
      const sink = new RedisTokenStreamSink(server.client());
      await sink.open('run-gone').write(stepFrame(0));
      const iterator = sink.subscribe('run-gone')[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual(stepFrame(0));
      server.lists.clear();
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await Promise.race([next, Promise.resolve('pending' as const)])).toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes as soon as its consumer returns', async () => {
    const server = new FakeRedisServer();
    const sink = new RedisTokenStreamSink(server.client());
    await sink.open('run-idle').write(stepFrame(0));
    const iterator = sink.subscribe('run-idle')[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    expect(await settlesSoon(Promise.all([pending, iterator.return?.()]))).not.toBe('pending');
    expect(server.subs.get('agent:stream:run-idle')?.size ?? 0).toBe(0);
  });
});

describe('the @adonisjs/redis adapter of tokenSinks.redis()', () => {
  it('writes each frame as one MULTI — push, TTL and publish in a single round trip', async () => {
    const sent: string[] = [];
    const lists = new Map<string, string[]>();
    const multi = () => {
      const queued: (() => void)[] = [];
      const chain = {
        rpush: (key: string, value: string) => {
          queued.push(() => {
            lists.set(key, [...(lists.get(key) ?? []), value]);
          });
          return chain;
        },
        expire: () => chain,
        publish: () => chain,
        exec: async () => {
          sent.push('multi');
          for (const run of queued) run();
          return queued.map(() => [null, 1] as [null, number]);
        },
      };
      return chain;
    };
    const io = {
      rpush: async () => {
        sent.push('rpush');
        return 1;
      },
      lrange: async () => [],
      set: async () => {
        sent.push('set');
      },
      get: async () => null,
      publish: async () => {
        sent.push('publish');
        return 0;
      },
      del: async () => 0,
      expire: async () => {
        sent.push('expire');
        return 1;
      },
      multi,
    };
    const app = {
      container: { make: async () => ({ connection: () => ({ ioConnection: io }) }) },
    };
    const sink = await tokenSinks.redis()({ app } as never);
    const writer = await (sink as TokenStreamSink).open('run-io');
    for (let index = 0; index < 3; index++) await writer.write(stepFrame(index));
    expect(sent).toEqual(['multi', 'multi', 'multi']);
    expect(lists.get('agent:stream:run-io:chunks')).toHaveLength(3);
  });
});
