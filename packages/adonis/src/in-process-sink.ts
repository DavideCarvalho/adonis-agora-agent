import { interruptible, untilAborted } from './interruptible.js';
import type { SinkWriter, StreamFrame, TokenStreamSink } from './spi/token-stream-sink.js';

/**
 * How long a run's frames are kept past its last write: 1h, the replay window the Redis and Lucid
 * sinks keep too. Long enough to reconnect to a finished run; also what a run that never ends (its
 * process crashed, or it is parked on a person) is given before its buffer is let go.
 */
const RETAIN_MS = 3_600_000;

interface RunBuffer {
  chunks: StreamFrame[];
  ended: boolean;
  /** Set once the buffer was let go: its subscribers end, and the next write starts a new one. */
  dropped: boolean;
  notify: Set<() => void>;
  /** Epoch ms of the last write (or `end()`), what the retention window counts from. */
  touchedAt: number;
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The default {@link TokenStreamSink}: buffers typed frames per run in-process so a reconnecting
 * subscriber replays everything so far, then follows live until the run ends. Good for a single
 * replica; a multi-replica deployment needs a shared (Redis) sink so any pod can serve any run's
 * stream. Identical (frame-for-frame) to the `InMemoryTokenStreamSink` shipped from `./testing`.
 *
 * A run's buffer is dropped an hour after its last write, ended or not, so a long-lived process does
 * not keep every stream it ever served. The timers are `unref`'d: they never hold the process open.
 */
export class InProcessTokenStreamSink implements TokenStreamSink {
  private readonly runs = new Map<string, RunBuffer>();

  private buffer(runId: string): RunBuffer {
    let buf = this.runs.get(runId);
    if (buf === undefined) {
      buf = {
        chunks: [],
        ended: false,
        dropped: false,
        notify: new Set(),
        touchedAt: Date.now(),
        expiry: undefined,
      };
      this.runs.set(runId, buf);
      this.scheduleExpiry(runId, buf, RETAIN_MS);
    }
    return buf;
  }

  /**
   * One timer per run, re-armed for whatever is left of the window when it fires early, so a write
   * only stamps `touchedAt` instead of resetting a timer per token.
   */
  private scheduleExpiry(runId: string, buf: RunBuffer, delay: number): void {
    buf.expiry = setTimeout(() => {
      buf.expiry = undefined;
      const left = buf.touchedAt + RETAIN_MS - Date.now();
      if (left > 0) {
        this.scheduleExpiry(runId, buf, left);
        return;
      }
      this.drop(runId, buf);
    }, delay);
    buf.expiry.unref?.();
  }

  private drop(runId: string, buf: RunBuffer): void {
    if (buf.expiry !== undefined) clearTimeout(buf.expiry);
    buf.expiry = undefined;
    buf.dropped = true;
    if (this.runs.get(runId) === buf) this.runs.delete(runId);
    this.wake(buf);
  }

  private wake(buf: RunBuffer): void {
    for (const resolve of buf.notify) {
      resolve();
    }
    buf.notify.clear();
  }

  open(runId: string): SinkWriter {
    // Looked up per call rather than held: a writer that outlives its buffer's window (a run parked
    // for longer than that) writes into a fresh one instead of one nobody can reach.
    return {
      write: (frame: StreamFrame) => {
        const buf = this.buffer(runId);
        buf.chunks.push(frame);
        buf.touchedAt = Date.now();
        this.wake(buf);
      },
      end: () => {
        const buf = this.buffer(runId);
        buf.ended = true;
        buf.touchedAt = Date.now();
        this.wake(buf);
      },
    };
  }

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    return interruptible((signal) => this.follow(runId, signal));
  }

  private async *follow(runId: string, signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const buf = this.buffer(runId);
    let index = 0;
    while (!signal.aborted) {
      while (index < buf.chunks.length) {
        const chunk = buf.chunks[index];
        index += 1;
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      if (buf.ended || buf.dropped) {
        return;
      }
      let resolveWake!: () => void;
      const woken = new Promise<void>((resolve) => {
        resolveWake = resolve;
        buf.notify.add(resolve);
      });
      await untilAborted(woken, signal);
      buf.notify.delete(resolveWake);
    }
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  close(runId: string): void {
    const buf = this.runs.get(runId);
    if (buf !== undefined) this.drop(runId, buf);
  }
}
