import type { StreamFrame } from './spi/token-stream-sink.js';
import type { AgentStreamEvent } from './stream-events.js';

/** An event plus fields outside the shared vocabulary (allowed: readers ignore what they do not know). */
function withExtra(event: AgentStreamEvent, extra: Record<string, unknown>): AgentStreamEvent {
  return { ...extra, ...event };
}

/**
 * A reconnect cursor from `?after=` or the `Last-Event-ID` header: a non-negative integer, or
 * `undefined` for anything else (absent, malformed).
 */
export function parseStreamCursor(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
          ...(frame.version !== undefined ? { version: frame.version } : {}),
          ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
          ...(frame.componentVersions !== undefined
            ? { componentVersions: frame.componentVersions }
            : {}),
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
          {
            kind: 'approval-requested',
            id: frame.id,
            ...(frame.target !== undefined ? { target: frame.target } : {}),
            approver: frame.approver ?? 'requester',
            ...(frame.confirmation !== undefined ? { confirmation: frame.confirmation } : {}),
            ...(frame.expiresAt !== undefined ? { expiresAt: frame.expiresAt } : {}),
          },
          { runId: frame.runId, toolName: frame.toolName, input: frame.input },
        ),
      ];
    case 'error':
      return [];
  }
}

/**
 * Writes a run's frames in the agent protocol, one `data:` frame per event. Stateful only in the
 * positions it counts, so feed it every frame of the run in buffer order.
 *
 * Every event carries an SSE `id:` — its 1-based sequence number within the run. The number is a
 * pure function of the run's buffered stream (every sink replays a run from its first frame, in
 * write order, and {@link frameToEvents} is pure), so the same event gets the same number on the
 * POST that started the run and on any later `GET …/stream`, whichever replica serves it. Events at
 * or below `after` — what a reconnecting client already has — are counted but not written. `meta`,
 * `done` and `error` carry no id.
 */
export class AgentSseEncoder {
  private position = 0;
  private seq = 0;
  private failed = false;

  constructor(private readonly after = 0) {}

  /** The SSE text for the next frame of the run (possibly `''`). */
  encode(frame: StreamFrame): string {
    const position = this.position;
    this.position += 1;
    if (frame.t === 'error') {
      this.failed = true;
      return `event: error\ndata: ${JSON.stringify({ code: frame.code, message: frame.message })}\n\n`;
    }
    let out = '';
    for (const event of frameToEvents(frame, position)) {
      this.seq += 1;
      if (this.seq > this.after) {
        out += `id: ${this.seq}\ndata: ${JSON.stringify(event)}\n\n`;
      }
    }
    return out;
  }

  /**
   * The closing frame: `event: done` for a run that ended, nothing after an `event: error` — a
   * reader takes the error as the end, and a `done` after it would read as a success.
   */
  close(): string {
    return this.failed ? '' : 'event: done\ndata: {}\n\n';
  }
}
