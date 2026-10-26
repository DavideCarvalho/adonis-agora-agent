import type { StreamFrame } from './spi/token-stream-sink.js';

/**
 * What consecutive frames of a run merge under, or `undefined` for a frame that is always written on
 * its own. Only the streamed deltas qualify — answer text, reasoning text, and the argument text of
 * ONE tool call — and only in their plain shape, so a merge can never drop a field: every reader
 * appends those deltas, which makes one frame holding their concatenation read the same as the run.
 */
export function coalesceKey(frame: StreamFrame): string | undefined {
  if (frame.t === 'text') return 'text';
  if (frame.t !== 'event') return undefined;
  const event = frame.event;
  if (event.kind === 'reasoning' && Object.keys(event).length === 2) return 'reasoning';
  if (event.kind === 'tool-input-delta' && Object.keys(event).length === 3) {
    return `tool-input-delta\u0000${event.id}`;
  }
  return undefined;
}

/** `next` appended to `held`; both have the same {@link coalesceKey}. */
function merge(held: StreamFrame, next: StreamFrame): StreamFrame {
  if (held.t === 'text' && next.t === 'text') return { t: 'text', v: held.v + next.v };
  if (held.t === 'event' && next.t === 'event') {
    const a = held.event;
    const b = next.event;
    if (a.kind === 'reasoning' && b.kind === 'reasoning') {
      return { t: 'event', event: { kind: 'reasoning', text: a.text + b.text } };
    }
    if (a.kind === 'tool-input-delta' && b.kind === 'tool-input-delta') {
      return {
        t: 'event',
        event: { kind: 'tool-input-delta', id: a.id, delta: a.delta + b.delta },
      };
    }
  }
  return next;
}

/** One run's write side in this process: the frame being gathered, and the writes already queued. */
interface RunWrites {
  held: StreamFrame | null;
  heldKey: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when every write queued so far has been attempted. Never rejects. */
  tail: Promise<void>;
  pending: number;
  /** A gathered write that failed with nobody awaiting it — reported by the next call. */
  failure: { error: unknown } | undefined;
}

/**
 * The write half a shared sink puts in front of its transport: consecutive deltas of one kind
 * (see {@link coalesceKey}) written within `flushMs` become ONE frame, and every frame of a run is
 * appended in call order, one append at a time.
 *
 * A model streams token by token, and a round trip per token is what a transport shared across
 * replicas can least afford. A gathered frame is written when its window passes (counted from its
 * FIRST delta, so a steady stream still lands every `flushMs`), when a frame that does not merge
 * with it arrives, and on `flush()`/`end()` — so order is always kept. `flushMs: 0` appends every
 * frame as it comes.
 *
 * Writers opened for the same run in one process share what they are gathering, so a delegated
 * run's text (forwarded through a `childSinkWriter`) and its parent's next frame keep the order they
 * were written in.
 */
export class CoalescedWrites {
  private readonly runs = new Map<string, RunWrites>();

  constructor(
    private readonly flushMs: number,
    /** Append one frame to the run's stream, or (`null`) its end marker. */
    private readonly append: (runId: string, frame: StreamFrame | null) => Promise<void>,
  ) {}

  private state(runId: string): RunWrites {
    let state = this.runs.get(runId);
    if (state === undefined) {
      state = {
        held: null,
        heldKey: undefined,
        timer: undefined,
        tail: Promise.resolve(),
        pending: 0,
        failure: undefined,
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  /** Forget a run's write state once nothing is gathered, queued or left to report. */
  private release(runId: string, state: RunWrites): void {
    if (
      state.pending === 0 &&
      state.held === null &&
      state.failure === undefined &&
      this.runs.get(runId) === state
    ) {
      this.runs.delete(runId);
    }
  }

  /** Queue `frame` behind every write already queued for the run, so frames land in call order. */
  private enqueue(runId: string, state: RunWrites, frame: StreamFrame | null): Promise<void> {
    state.pending += 1;
    const next = state.tail.then(() => this.append(runId, frame));
    state.tail = next
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        state.pending -= 1;
        this.release(runId, state);
      });
    return next;
  }

  /** Queue the gathered frame (if any). */
  private flushHeld(runId: string, state: RunWrites): Promise<void> {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const held = state.held;
    if (held === null) return Promise.resolve();
    state.held = null;
    state.heldKey = undefined;
    return this.enqueue(runId, state, held);
  }

  /** A write nobody awaits (a window that passed, a gathered frame a different one displaced). */
  private flushUnawaited(runId: string, state: RunWrites): void {
    this.flushHeld(runId, state).catch((error: unknown) => {
      state.failure = { error };
    });
  }

  /** Raise, once, a gathered write that failed with nobody awaiting it. */
  private raiseFailure(state: RunWrites): void {
    const failure = state.failure;
    if (failure !== undefined) {
      state.failure = undefined;
      throw failure.error;
    }
  }

  async write(runId: string, frame: StreamFrame): Promise<void> {
    const state = this.state(runId);
    this.raiseFailure(state);
    const key = this.flushMs > 0 ? coalesceKey(frame) : undefined;
    if (key !== undefined) {
      if (state.held !== null && state.heldKey === key) {
        state.held = merge(state.held, frame);
        return;
      }
      if (state.held !== null) this.flushUnawaited(runId, state);
      state.held = frame;
      state.heldKey = key;
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.flushUnawaited(runId, state);
      }, this.flushMs);
      return;
    }
    const flushed = this.flushHeld(runId, state);
    const appended = this.enqueue(runId, state, frame);
    await Promise.all([flushed, appended]);
  }

  /** Write out the gathered frame and wait for every queued write, without ending the stream. */
  async flush(runId: string): Promise<void> {
    const state = this.state(runId);
    const flushed = this.flushHeld(runId, state);
    await Promise.all([flushed, state.tail]);
    this.raiseFailure(state);
    this.release(runId, state);
  }

  /** Write out the gathered frame, then the end marker. */
  async end(runId: string): Promise<void> {
    const state = this.state(runId);
    const flushed = this.flushHeld(runId, state);
    const ended = this.enqueue(runId, state, null);
    await Promise.all([flushed, ended]);
    this.raiseFailure(state);
    this.release(runId, state);
  }

  /** Drop what is gathered for the run and wait out the writes already queued. */
  async discard(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (state === undefined) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    state.held = null;
    state.heldKey = undefined;
    state.failure = undefined;
    await state.tail;
    this.runs.delete(runId);
  }
}
