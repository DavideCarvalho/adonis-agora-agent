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
   */
  | { t: 'elicitation'; id: string; request: ElicitationRequest };

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
