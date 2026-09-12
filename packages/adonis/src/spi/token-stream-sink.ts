import type { ElicitationRequest } from '../elicitation.js';

/**
 * The "data plane": live token transport, decoupled from the durable control plane.
 *
 * The model turn writes typed frames to a `SinkWriter` keyed by runId; the HTTP layer
 * `subscribe`s by runId and pipes the frames to the browser as SSE. A late subscriber
 * (reconnect/resume) replays buffered frames first, then follows live — which is what
 * makes streaming survive a dropped connection or a pod restart.
 */
export type StreamFrame =
  | { t: 'text'; v: string }
  | { t: 'component'; name: string; data: unknown }
  /**
   * A question set the run is now parked on. Carries the whole request, so a client renders the form
   * — and knows the total ("Question 1 of 3") — without a second fetch. Identical whether a
   * configured intake or the model's `ask` authored it.
   *
   * `runId` is the run that is PARKED, which is not always the stream this frame arrived on: a
   * delegated sub-agent forwards its frames into its top-level ancestor's stream so the human can
   * see them, and answering it means addressing the CHILD's run. Without the id on the frame a
   * watcher has the form and no way to reply to it.
   */
  | { t: 'elicitation'; runId: string; id: string; request: ElicitationRequest }
  /**
   * An `action` tool call the run is now parked on, waiting for an approve/reject. Carries the tool
   * and the arguments it was asked to run with, so a watcher can decide without a second fetch.
   *
   * `runId`, like the elicitation frame's, is the run that is PARKED rather than the stream this
   * arrived on: a delegated sub-agent's action suspends its OWN run, and forwarding the frame into
   * the ancestor's stream is the only way a human sees it — so the id has to ride along, or the
   * watcher can see the approval and not make it.
   */
  | { t: 'approval'; runId: string; id: string; toolName: string; input: unknown };

export interface SinkWriter {
  write(frame: StreamFrame): void | Promise<void>;
  /** Mark the run's stream finished (no more frames). */
  end(): void | Promise<void>;
}

export interface TokenStreamSink {
  /** Open (or reopen) the writer for a run. */
  open(runId: string): SinkWriter | Promise<SinkWriter>;
  /** Replay buffered frames for the run, then yield live ones until `end()`. */
  subscribe(runId: string): AsyncIterable<StreamFrame>;
  /** Drop any buffer/resources for the run. */
  close(runId: string): void | Promise<void>;
}

/**
 * Wrap a {@link SinkWriter} so a DELEGATED run forwards its frames into its top-level ancestor's
 * stream but never closes it.
 *
 * Forwarding is what makes a sub-agent visible at all: its own runId is not a stream anyone
 * subscribed to, so a question set it parks on would otherwise be written where nobody reads it.
 * The ancestor owns the stream's lifecycle across however many delegations it spans, so the child's
 * `end()` is a no-op — ending the shared stream mid-parent-run would cut the human off.
 */
export function childSinkWriter(inner: SinkWriter): SinkWriter {
  return {
    write: (chunk) => inner.write(chunk),
    end: () => {
      /* the top-level run owns end() */
    },
  };
}
