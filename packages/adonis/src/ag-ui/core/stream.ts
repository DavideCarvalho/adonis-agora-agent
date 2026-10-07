import { AgUiEncoder, type AgUiEncoderOptions } from './encoder.js';
import type { AgUiEvent, AgUiSourceFrame } from './types.js';

export interface AgUiStreamOptions extends AgUiEncoderOptions {
  /**
   * How long the library stream may stay silent, while the run waits on a person AND has other work
   * announced, before the AG-UI run is reported interrupted. Default 750 ms.
   *
   * Only that mixed case needs a clock. A run whose every open tool call is waiting on someone is
   * reported at once; a run waiting on no one is never cut short.
   */
  quietMs?: number;
  /** Events to write right after `RUN_STARTED` (warnings about input that was dropped). */
  preamble?: AgUiEvent[];
  /**
   * Kept at the run's own sequence number (the native stream's SSE `id:`) of the library frame
   * whose events are being yielded — `0` before the first. Write it as each event's SSE `id:`
   * ({@link agUiSse}) and a consumer can re-attach to the native stream with `?after=` exactly where
   * this AG-UI run left off. Read from {@link withFrameSeq}; a frame not tagged leaves it as it is.
   */
  cursor?: AgUiCursor;
}

/** See {@link AgUiStreamOptions.cursor}. */
export interface AgUiCursor {
  seq: number;
}

/** The run's own sequence number of each source frame tagged by {@link withFrameSeq}. */
const frameSeqs = new WeakMap<object, number>();

/**
 * Tag a source frame with the run's own sequence number through it — the SSE `id:` of the last
 * event the native stream writes for it — for {@link AgUiStreamOptions.cursor}.
 */
export function withFrameSeq<T extends AgUiSourceFrame>(frame: T, seq: number): T {
  frameSeqs.set(frame, seq);
  return frame;
}

/** The run's own sequence number of a frame tagged by {@link withFrameSeq}, if any. */
export function frameSeq(frame: AgUiSourceFrame): number | undefined {
  return frameSeqs.get(frame);
}

const DEFAULT_QUIET_MS = 750;
const GRACE_MS = 50;

type Next = IteratorResult<AgUiSourceFrame> | 'quiet';

/**
 * One AG-UI run over a library run's stream.
 *
 * AG-UI has no mid-run channel from the consumer: a run that needs an approval or an answer does not
 * wait with the connection open — it ENDS, saying what it waits for, and a later run carries the
 * answers. The library run underneath does wait (parked, durably when the runner is durable). So this
 * stops reading when the run is waiting on someone and nothing else is moving, closes the AG-UI run
 * with the interrupt outcome, and leaves the library run parked for the resume to pick up.
 */
export async function* agUiEvents(
  frames: AsyncIterable<AgUiSourceFrame>,
  options: AgUiStreamOptions,
): AsyncGenerator<AgUiEvent> {
  const encoder = new AgUiEncoder(options);
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  yield* encoder.start();
  yield* options.preamble ?? [];
  const iterator = frames[Symbol.asyncIterator]();
  let upcoming: Promise<IteratorResult<AgUiSourceFrame>> | undefined;
  let ended = false;
  try {
    for (;;) {
      upcoming ??= iterator.next();
      // Frames buffered before this reader attached are replayed without a pause between them, so
      // "is it waiting?" is only asked of a stream that has caught up with what it already holds.
      const caughtUp = encoder.consumed >= (options.skip ?? 0);
      let next: Next;
      if (caughtUp && encoder.waiting) {
        // Nothing else in flight: only a frame already on its way (a sink that reads in batches)
        // can still arrive, so a short grace is enough. Otherwise wait out the quiet window.
        next = await raceQuiet(upcoming, encoder.busy ? quietMs : Math.min(quietMs, GRACE_MS));
      } else {
        next = await upcoming;
      }
      if (next === 'quiet') break;
      upcoming = undefined;
      if (next.done === true) {
        ended = true;
        break;
      }
      if (options.cursor !== undefined) {
        options.cursor.seq = frameSeq(next.value) ?? options.cursor.seq;
      }
      yield* encoder.encode(next.value);
    }
  } finally {
    // Stop following the library stream; the run it carries is left exactly as it is.
    void iterator.return?.();
  }
  yield* encoder.finish(ended);
}

function raceQuiet(upcoming: Promise<IteratorResult<AgUiSourceFrame>>, ms: number): Promise<Next> {
  return new Promise<Next>((resolve, reject) => {
    const timer = setTimeout(() => resolve('quiet'), ms);
    upcoming.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * One AG-UI event as an SSE frame: a single `data:` line, LF-terminated, as the binding pins. With a
 * positive `id`, an SSE `id:` line first — the run's sequence number ({@link AgUiStreamOptions.cursor}),
 * which AG-UI clients ignore and this package's React client re-attaches with.
 */
export function agUiSse(event: AgUiEvent, id?: number): string {
  const head = id !== undefined && id > 0 ? `id: ${id}\n` : '';
  return `${head}data: ${JSON.stringify(event)}\n\n`;
}
