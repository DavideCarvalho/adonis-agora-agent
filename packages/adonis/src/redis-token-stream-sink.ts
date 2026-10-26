import { CoalescedWrites } from './coalesced-writes.js';
import { interruptible, untilAborted } from './interruptible.js';
import type { RedisStreamClient } from './redis-stream-client.js';
import type { SinkWriter, StreamFrame, TokenStreamSink } from './spi/token-stream-sink.js';

/** Marker stored at the state key once a run's stream has finished. */
const ENDED = 'ended';

/** Default TTL (seconds) for a run's Redis keys: 1h — a generous reconnect/replay window past finish. */
const DEFAULT_TTL_SECONDS = 3600;

/** Window (ms) consecutive deltas are gathered over before they are pushed as one list element. */
const FLUSH_MS = 50;

/**
 * How long a subscriber waits without a message before it reads the list again on its own: keys
 * that expire publish nothing, and this is how it learns that the run it follows is gone.
 */
const IDLE_CHECK_MS = 60_000;

export interface RedisTokenStreamSinkOptions {
  /** Key/channel namespace. Defaults to `agent:stream`. Keys are `${keyPrefix}:${runId}:...`. */
  keyPrefix?: string;
  /**
   * TTL (seconds) applied to a run's `chunks`/`state` keys so they self-expire — the framework never
   * calls {@link RedisTokenStreamSink.close}, so without this the replay buffer would accumulate in
   * Redis forever. The TTL is a sliding window refreshed on every write, so a long run stays alive and
   * a crashed run (that never `end`s) still expires. Defaults to 3600 (1h). Set `0` to disable and
   * retain keys until `close()`/manual cleanup (the pre-TTL behaviour).
   */
  ttlSeconds?: number;
}

/**
 * A multi-replica {@link TokenStreamSink} over Redis — the shared-transport counterpart to the default
 * {@link import('./in-process-sink.js').InProcessTokenStreamSink}. The replica running the model turn
 * `open`s the writer and appends each token chunk to a Redis LIST (`${keyPrefix}:${runId}:chunks`) so
 * ANY replica can replay the whole stream so far (the same late-subscriber/reconnect guarantee the
 * in-process sink gives, but shared across pods), and PUBLISHes to a per-run channel
 * (`${keyPrefix}:${runId}`) to wake live subscribers. The run's terminal state lives in a marker key
 * (`${keyPrefix}:${runId}:state`), so an SSE handler on ANOTHER replica that subscribes after the run
 * finished still sees the ending and closes the stream.
 *
 * Consecutive deltas written within 50 ms — answer text, reasoning, one tool call's argument text —
 * are pushed as ONE frame holding their concatenation, and each push is one round trip when the
 * client offers {@link RedisStreamClient.append}. Every reader appends those deltas, so the text a
 * client renders is unchanged; the list is the run's stream, so every replica numbers its SSE events
 * the same. A process that dies within that window loses the gathered delta from the LIVE stream
 * (the persisted message is unaffected).
 *
 * A subscriber reads the terminal marker once when it attaches and otherwise waits for the `end`
 * message. It ends when the run's keys expired under it, and starts over from the first element when
 * the list was started again (a run parked past its TTL that then wrote again).
 *
 * The host supplies a {@link RedisStreamClient} adapter over its own Redis driver; `subscribe` needs a
 * connection in subscriber mode (see the client docs). Wire it with `defineConfig({ sink:
 * tokenSinks.redis({...}) })`, which builds the adapter over `@adonisjs/redis` lazily.
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly writes: CoalescedWrites;

  constructor(
    private readonly client: RedisStreamClient,
    options: RedisTokenStreamSinkOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'agent:stream';
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.writes = new CoalescedWrites(FLUSH_MS, (runId, frame) => this.append(runId, frame));
  }

  /** Refresh the sliding TTL on `key` (no-op when TTL is disabled or the client can't `expire`). */
  private async touchTtl(key: string): Promise<void> {
    if (this.ttlSeconds > 0) {
      await this.client.expire?.(key, this.ttlSeconds);
    }
  }

  private chunksKey(runId: string): string {
    return `${this.keyPrefix}:${runId}:chunks`;
  }

  private stateKey(runId: string): string {
    return `${this.keyPrefix}:${runId}:state`;
  }

  private channel(runId: string): string {
    return `${this.keyPrefix}:${runId}`;
  }

  /** Push one frame and wake the subscribers, or (`null`) mark the run ended. */
  private async append(runId: string, frame: StreamFrame | null): Promise<void> {
    const chunks = this.chunksKey(runId);
    if (frame === null) {
      await this.client.set(this.stateKey(runId), ENDED);
      await this.touchTtl(this.stateKey(runId));
      await this.touchTtl(chunks);
      await this.client.publish(this.channel(runId), 'end');
      return;
    }
    const encoded = JSON.stringify(frame);
    if (this.client.append !== undefined) {
      await this.client.append(chunks, encoded, this.ttlSeconds, this.channel(runId), 'chunk');
      return;
    }
    await this.client.rpush(chunks, encoded);
    await this.touchTtl(chunks);
    await this.client.publish(this.channel(runId), 'chunk');
  }

  open(runId: string): SinkWriter {
    return {
      write: (frame: StreamFrame) => this.writes.write(runId, frame),
      flush: () => this.writes.flush(runId),
      end: () => this.writes.end(runId),
    };
  }

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    return interruptible((signal) => this.follow(runId, signal));
  }

  private async *follow(runId: string, signal: AbortSignal): AsyncGenerator<StreamFrame> {
    // Notify bridge: the pub/sub handler resolves the current `wake` promise so the drain loop
    // re-reads the list. A promise is armed BEFORE each drain, so a publish arriving mid-drain is
    // never lost.
    let resolveWake: (() => void) | null = null;
    let ended = false;
    const onMessage = (message: string) => {
      if (message === 'end') ended = true;
      const resolve = resolveWake;
      resolveWake = null;
      resolve?.();
    };
    const key = this.chunksKey(runId);
    const unsubscribe = await this.client.subscribe(this.channel(runId), onMessage);
    try {
      // A run that ended before this subscription existed publishes no `end` for it.
      if (await this.hasEnded(runId)) ended = true;
      let index = 0;
      // The last element read, read again with every drain so a list that is not the one read
      // (expired, or started over) is noticed.
      let last: string | undefined;
      while (!signal.aborted) {
        const drainsToEnd = ended;
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
        });
        const chunks = await this.client.lrange(key, index === 0 ? 0 : index - 1, -1);
        let fresh = chunks;
        if (index > 0) {
          if (chunks[0] !== last) {
            if ((await this.client.lrange(key, 0, 0)).length === 0) return;
            index = 0;
            last = undefined;
            continue;
          }
          fresh = chunks.slice(1);
        }
        for (const encoded of fresh) {
          index += 1;
          last = encoded;
          yield JSON.parse(encoded) as StreamFrame;
        }
        // The end marker is written after the last frame, so a drain begun after it was seen has
        // everything; one that began before reads once more.
        if (drainsToEnd) {
          return;
        }
        if (ended) {
          continue;
        }
        let idle: ReturnType<typeof setTimeout> | undefined;
        const quiet = new Promise<void>((resolve) => {
          idle = setTimeout(resolve, IDLE_CHECK_MS);
          idle.unref?.();
        });
        await untilAborted(Promise.race([wake, quiet]), signal);
        clearTimeout(idle);
      }
    } finally {
      await unsubscribe();
    }
  }

  async has(runId: string): Promise<boolean> {
    if ((await this.client.get(this.stateKey(runId))) !== null) return true;
    return (await this.client.lrange(this.chunksKey(runId), 0, 0)).length > 0;
  }

  async close(runId: string): Promise<void> {
    await this.writes.discard(runId);
    await this.client.del(this.chunksKey(runId), this.stateKey(runId));
  }

  private async hasEnded(runId: string): Promise<boolean> {
    const raw = await this.client.get(this.stateKey(runId));
    return raw === ENDED;
  }
}
