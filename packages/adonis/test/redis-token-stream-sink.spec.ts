import { describe, expect, it } from 'vitest';
import type { RedisStreamClient, StreamFrame } from '../src/index.js';
import { InProcessTokenStreamSink, RedisTokenStreamSink } from '../src/index.js';

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
    // Frame boundaries are preserved 1:1 (each write → one yielded frame → one SSE `data:` frame).
    expect(frames).toEqual([text('Hel'), text('lo, '), text('world')]);
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

    // Same frames, same order → identical `data: {"delta":...}` / component SSE output.
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
