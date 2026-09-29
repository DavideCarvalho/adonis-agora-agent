import type { RedisStreamClient } from './redis-stream-client.js';
import type { SinkWriter, StreamFrame, TokenStreamSink } from './spi/token-stream-sink.js';

/** Marker stored at the state key once a run's stream has finished. */
const ENDED = 'ended';

/** Default TTL (seconds) for a run's Redis keys: 1h — a generous reconnect/replay window past finish. */
const DEFAULT_TTL_SECONDS = 3600;

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
 * The yielded frames are identical (frame-for-frame) to the in-process sink's, so the SSE envelope
 * the provider pipes (`data: {"delta":...}` for text, a component event for `{ t: 'component' }`)
 * is unchanged — swapping this in is transparent to clients.
 *
 * The host supplies a {@link RedisStreamClient} adapter over its own Redis driver; `subscribe` needs a
 * connection in subscriber mode (see the client docs). Wire it with `defineConfig({ sink:
 * tokenSinks.redis({...}) })`, which builds the adapter over `@adonisjs/redis` lazily.
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly client: RedisStreamClient,
    options: RedisTokenStreamSinkOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'agent:stream';
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
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

  open(runId: string): SinkWriter {
    return {
      write: async (frame: StreamFrame) => {
        await this.client.rpush(this.chunksKey(runId), JSON.stringify(frame));
        await this.touchTtl(this.chunksKey(runId));
        await this.client.publish(this.channel(runId), 'chunk');
      },
      end: async () => {
        await this.client.set(this.stateKey(runId), ENDED);
        await this.touchTtl(this.stateKey(runId));
        await this.touchTtl(this.chunksKey(runId));
        await this.client.publish(this.channel(runId), 'end');
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<StreamFrame> {
    // Notify bridge: the pub/sub handler resolves the current `wake` promise so the drain loop
    // re-reads the list. A promise is armed BEFORE each drain, so a publish arriving mid-drain is
    // never lost.
    let resolveWake: (() => void) | null = null;
    const onMessage = () => {
      const resolve = resolveWake;
      resolveWake = null;
      resolve?.();
    };
    const unsubscribe = await this.client.subscribe(this.channel(runId), onMessage);
    try {
      let index = 0;
      while (true) {
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
        });
        const chunks = await this.client.lrange(this.chunksKey(runId), index, -1);
        for (const encoded of chunks) {
          index += 1;
          yield JSON.parse(encoded) as StreamFrame;
        }
        if (await this.hasEnded(runId)) {
          return;
        }
        await wake;
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
    await this.client.del(this.chunksKey(runId), this.stateKey(runId));
  }

  private async hasEnded(runId: string): Promise<boolean> {
    const raw = await this.client.get(this.stateKey(runId));
    return raw === ENDED;
  }
}
