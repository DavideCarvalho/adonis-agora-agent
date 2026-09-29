import type { StreamFrame } from './spi/token-stream-sink.js';
import type { AgentStreamEvent } from './stream-events.js';

/**
 * Which envelope a run's SSE is written in.
 *
 * - `'agent'` — the chat stream protocol shared with `@dudousxd/nestjs-agent`: one `AgentStreamEvent`
 *   JSON object per `data:` frame (`{"kind":"text","text":…}`, tool calls, reasoning, steps, …),
 *   `event: error` on failure. `@dudousxd/nestjs-agent-react` renders it unchanged.
 * - `'legacy'` — this package's original envelope: `data: {"delta":…}` for text, `event: component`,
 *   `event: elicitation`, `event: approval`. Frames it has no spelling for are skipped.
 */
export type StreamProtocol = 'agent' | 'legacy';

/**
 * Serializes a {@link StreamFrame} into the LEGACY SSE envelope. A text frame becomes
 * `data: {"delta":...}`; a component frame becomes `event: component\ndata: {name,data}`; a question
 * set becomes `event: elicitation`, carrying the whole request so a client can render the form
 * without a second fetch; a parked `action` becomes `event: approval`, carrying the tool and its
 * arguments. Both of those also carry the `runId` to answer against, which for a delegated
 * sub-agent is not the run this stream is keyed by. A failure is the `[error]` text delta it always
 * was. An agent-protocol-only frame (`t: 'event'`) has no spelling here and yields `''`.
 */
export function frameToSse(frame: StreamFrame): string {
  if (frame.t === 'component') {
    return `event: component\ndata: ${JSON.stringify({ name: frame.name, data: frame.data })}\n\n`;
  }
  if (frame.t === 'approval') {
    return `event: approval\ndata: ${JSON.stringify({ runId: frame.runId, id: frame.id, toolName: frame.toolName, input: frame.input })}\n\n`;
  }
  if (frame.t === 'elicitation') {
    return `event: elicitation\ndata: ${JSON.stringify({ runId: frame.runId, id: frame.id, request: frame.request })}\n\n`;
  }
  if (frame.t === 'event') {
    return '';
  }
  if (frame.t === 'error') {
    return `data: ${JSON.stringify({ delta: `\n[error] ${frame.message}` })}\n\n`;
  }
  return `data: ${JSON.stringify({ delta: frame.v })}\n\n`;
}

/** An event plus fields outside the shared vocabulary (allowed: readers ignore what they do not know). */
function withExtra(event: AgentStreamEvent, extra: Record<string, unknown>): AgentStreamEvent {
  return { ...extra, ...event };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The agent-protocol events one {@link StreamFrame} stands for. Pure: the same frame at the same
 * position always yields the same events, which is what lets a re-attaching reader number them the
 * way the first reader did.
 *
 * `position` is the frame's 0-based index in the run's buffer; it names a component frame buffered
 * before the loop stamped ids on them (`ui:<position>`), so a replay replaces rather than duplicates.
 */
export function frameToEvents(frame: StreamFrame, position: number): AgentStreamEvent[] {
  switch (frame.t) {
    case 'text':
      return frame.v.length > 0 ? [{ kind: 'text', text: frame.v }] : [];
    case 'event':
      return [frame.event];
    case 'component':
      return [
        {
          kind: 'ui',
          id: frame.id ?? `ui:${position}`,
          component: frame.name,
          props: isRecord(frame.data) ? frame.data : { value: frame.data },
          ...(frame.toolCallId !== undefined ? { toolCallId: frame.toolCallId } : {}),
        },
      ];
    case 'elicitation':
      // `runId` rides along (fields are only ever added): a delegated sub-agent's form is answered
      // against the CHILD run, which is not the stream it arrived on.
      return [
        withExtra(
          { kind: 'elicitation', id: frame.id, request: frame.request },
          { runId: frame.runId },
        ),
      ];
    case 'approval':
      // `approver: 'requester'` — the person chatting (or a governance-privileged actor) decides.
      // `runId`/`toolName`/`input` ride along for a reader that decides without the call's frames.
      return [
        withExtra(
          { kind: 'approval-requested', id: frame.id, approver: 'requester' },
          { runId: frame.runId, toolName: frame.toolName, input: frame.input },
        ),
      ];
    case 'error':
      return [];
  }
}

/**
 * Writes a run's frames in the agent protocol, one `data:` frame per event. Stateful only in the
 * frame position it counts, so feed it every frame of the run in buffer order.
 */
export class AgentSseEncoder {
  private position = 0;
  private failed = false;

  /** The SSE text for the next frame of the run (possibly `''`). */
  encode(frame: StreamFrame): string {
    const position = this.position;
    this.position += 1;
    if (frame.t === 'error') {
      this.failed = true;
      return `event: error\ndata: ${JSON.stringify({ code: frame.code, message: frame.message })}\n\n`;
    }
    return frameToEvents(frame, position)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('');
  }

  /**
   * The closing frame: `event: done` for a run that ended, nothing after an `event: error` — a
   * reader takes the error as the end, and a `done` after it would read as a success.
   */
  close(): string {
    return this.failed ? '' : 'event: done\ndata: {}\n\n';
  }
}
