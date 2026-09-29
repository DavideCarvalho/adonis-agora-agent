import type { ElicitationRequest } from '../elicitation.js';
import type { AgentStreamErrorCode, AgentStreamEvent } from '../stream-events.js';

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
  /**
   * A component a tool pushed (`ctx.emitComponent`). `id` and `toolCallId` are stamped by the loop
   * (`<toolCallId>:ui:<n>`) so the agent protocol can carry it as a `ui` frame a repeat replaces;
   * a frame buffered before they existed has neither, and is numbered by its position instead.
   */
  | {
      t: 'component';
      name: string;
      data: unknown;
      id?: string;
      toolCallId?: string;
      /** Schema version of `data` (`ctx.emitUi`'s `version`). */
      version?: number;
    }
  /**
   * One frame of the agent stream protocol (`AgentStreamEvent`, shared with `@dudousxd/nestjs-agent`)
   * that has no older spelling here: reasoning, tool-call announcements and outcomes, step brackets,
   * title, cancel. The legacy envelope has no place for them and skips them.
   */
  | { t: 'event'; event: AgentStreamEvent }
  /**
   * The run failed. Streamed as `event: error` `{ code, message }` under the agent protocol; the
   * legacy envelope writes it as the `[error]` text delta it always did.
   */
  | { t: 'error'; code: AgentStreamErrorCode; message: string }
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
  | {
      t: 'approval';
      runId: string;
      id: string;
      toolName: string;
      input: unknown;
      /** Who may decide (`'requester'` or a role), from the turn's `ApprovalPolicy`. Absent → the requester. */
      approver?: string;
      /** ISO-8601 instant the request lapses. Absent → it never does. */
      expiresAt?: string;
    };

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
  /**
   * OPTIONAL: does this sink hold anything for the run — a buffer it opened, frames, an end marker?
   * `GET <path>/chat/:runId/stream` answers `404` when it says no, which a client reads as "nothing to
   * resume" (the run ended while it was away, or the buffer went with a restarted process) instead of
   * waiting forever on a stream nobody will write. Absent → the route subscribes regardless.
   */
  has?(runId: string): boolean | Promise<boolean>;
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
