import type { SinkWriter, StreamFrame, TokenStreamSink } from './spi/token-stream-sink.js';

/** What a failed stream write reports: the run, the step of the writer that failed, the error. */
export interface StreamFailure {
  runId: string;
  stage: 'open' | 'write' | 'end' | 'flush';
  error: unknown;
}

export interface ResilientTokenStreamSinkOptions {
  /**
   * Told once per run, at the first failure (later ones on the same run are the same outage).
   * Default: a `console.warn`.
   */
  onFailure?: (failure: StreamFailure) => void;
}

const NOOP_WRITER: SinkWriter = { write() {}, end() {} };

/**
 * Keep a run alive when its live stream breaks.
 *
 * The sink is the TRANSPORT of a turn's tokens to whoever is watching; the turn's outcome is the
 * message the store persists. Without this, a sink that throws — Redis out of memory, a dropped
 * connection, a table the Lucid sink can't write — rejects the loop's `await writer.write(…)` and
 * fails the whole run: the model's answer is never written, even though only the live view was
 * broken.
 *
 * Wrapped, the first failure of a run is reported and that run's writer goes quiet: its later
 * frames are dropped and `end()` is still attempted (a subscriber may yet get the end marker), but
 * nothing throws back into the loop. The run finishes, the answer is persisted, and a reload — the
 * thread read, not the stream — shows it whole. Reading (`subscribe`, `has`, `close`) is untouched:
 * a broken read is the SSE route's to report, and does not affect the run.
 */
export class ResilientTokenStreamSink implements TokenStreamSink {
  private readonly report: (failure: StreamFailure) => void;
  /** The wrapped sink's, when it has one (the SSE route reads its absence as "subscribe anyway"). */
  readonly has?: (runId: string) => boolean | Promise<boolean>;

  constructor(
    private readonly inner: TokenStreamSink,
    options: ResilientTokenStreamSinkOptions = {},
  ) {
    this.report =
      options.onFailure ??
      ((failure) =>
        console.warn(
          `[@adonis-agora/agent] live stream of run ${failure.runId} failed at ${failure.stage}; ` +
            'the run continues and its answer is still persisted.',
          failure.error,
        ));
    const innerHas = this.inner.has;
    if (innerHas) this.has = (runId) => innerHas.call(this.inner, runId);
  }

  async open(runId: string): Promise<SinkWriter> {
    let writer: SinkWriter;
    try {
      writer = await this.inner.open(runId);
    } catch (error) {
      this.safeReport({ runId, stage: 'open', error });
      return NOOP_WRITER;
    }

    let broken = false;
    const fail = (stage: StreamFailure['stage'], error: unknown) => {
      if (!broken) this.safeReport({ runId, stage, error });
      broken = true;
    };

    return {
      write: async (frame: StreamFrame) => {
        if (broken) return;
        try {
          await writer.write(frame);
        } catch (error) {
          fail('write', error);
        }
      },
      end: async () => {
        // Attempted even after a failed write: the end marker is what lets a waiting subscriber go.
        try {
          await writer.end();
        } catch (error) {
          fail('end', error);
        }
      },
      ...(writer.flush
        ? {
            flush: async () => {
              if (broken) return;
              try {
                await writer.flush!();
              } catch (error) {
                fail('flush', error);
              }
            },
          }
        : {}),
    };
  }

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    return this.inner.subscribe(runId);
  }

  close(runId: string): void | Promise<void> {
    return this.inner.close(runId);
  }

  /** A failing reporter must not be the thing that breaks the run. */
  private safeReport(failure: StreamFailure) {
    try {
      this.report(failure);
    } catch {
      // nothing more to do
    }
  }
}
