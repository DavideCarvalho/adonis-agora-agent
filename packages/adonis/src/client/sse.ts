/**
 * Client-side counterpart to {@link import('../sse.js').AgentSseEncoder}: parses the provider's SSE
 * back into typed frames the browser can render. Kept framework-agnostic (no React, no Adonis) so
 * any consumer — a React hook, a Vue composable, a plain fetch loop — decodes the wire format the
 * same way, and so the envelope stays owned by the package that emits it.
 *
 * Wire format — the agent stream protocol shared with `@dudousxd/nestjs-agent`:
 * - `event: meta\ndata: {runId,threadId}`   — sent once, first, before any token
 * - `id: <seq>\ndata: <AgentStreamEvent>`    — one event per frame (`{"kind":"text","text":…}`,
 *   `ui`, `elicitation`, `approval-requested`, reasoning, tool calls, steps, title, …)
 * - `event: error\ndata: {code,message}`     — the run failed (terminal)
 * - `event: done\ndata: {}`                  — the run's stream finished
 */

import type { ElicitationRequest } from '../elicitation.js';
import type { ToolConfirmation } from '../tool-presentation.js';

/** A rendered part of an assistant message: streamed text, or a named component with its props. */
export type ChatPart =
  | { type: 'text'; text: string }
  | {
      type: 'component';
      name: string;
      data: unknown;
      id?: string;
      version?: number;
      fallbackText?: string;
      componentVersions?: Record<string, number>;
      /**
       * A preview of a layout the model is still writing (genui `streaming: 'partial'`): unvalidated,
       * replaced in place by the final component under the same `id`.
       */
      partial?: true;
    };

/** A decoded stream frame — the typed form of one SSE event. */
export type ChatFrame =
  | { type: 'text'; delta: string }
  | {
      type: 'component';
      name: string;
      data: unknown;
      id?: string;
      version?: number;
      fallbackText?: string;
      componentVersions?: Record<string, number>;
      /**
       * A preview of a layout the model is still writing (genui `streaming: 'partial'`): unvalidated,
       * replaced in place by the final component under the same `id`.
       */
      partial?: true;
    }
  | { type: 'meta'; runId?: string; threadId?: string }
  /** A failed run (`event: error` under the agent protocol). Terminal, like `done`. */
  | { type: 'error'; code: string; message: string }
  /** Any other agent-protocol event — reasoning, tool calls, steps, title, … */
  | { type: 'event'; event: Record<string, unknown> & { kind: string } }
  /**
   * A question set the run is parked on, with everything needed to answer it: `runId` and
   * `toolCallId` are the body `POST /agent/tool-call/answer` takes, and `request` is the form.
   *
   * `runId` is NOT necessarily the run this stream was opened for. A delegated sub-agent forwards
   * its frames into its top-level ancestor's stream — that is the only stream a human is watching —
   * so the run to answer is the child's, and reading it off `meta` would address the wrong one.
   */
  | { type: 'elicitation'; runId: string; toolCallId: string; request: ElicitationRequest }
  /**
   * An action tool awaiting an approve/reject, with what it means to run. `runId`/`toolCallId` are
   * the body `POST /agent/tool-call/approve` (or `/reject`) takes — and `runId` is the parked run,
   * which for a delegated sub-agent is not the run this stream was opened for.
   */
  | {
      type: 'approval';
      target?: { kind: 'proposal'; proposalId: string };
      runId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      confirmation?: ToolConfirmation;
      approver?: string;
      expiresAt?: string;
      reason?: string;
    }
  | { type: 'done' };

/** One raw SSE event: the `event:` name (default `message`) and the joined `data:` payload. */
export interface SseEvent {
  event: string;
  data: string;
  /**
   * The frame's `id:` — its sequence number in the run. Strictly increasing within a run, gaps
   * allowed; `meta`, `done` and `error` carry none.
   */
  id?: string;
}

/**
 * Parses one raw SSE frame (the text between `\n\n` separators, without them) into `{event, data}`.
 * A frame with no `data:` line (e.g. a `:` keep-alive comment) returns `null`.
 */
export function parseSseEvent(frame: string): SseEvent | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    } else if (line.startsWith('id:')) {
      id = line.slice('id:'.length).trim();
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join('\n'), ...(id !== undefined ? { id } : {}) };
}

/**
 * Decodes a parsed {@link SseEvent} into a typed {@link ChatFrame}, or `null` when the payload is
 * malformed (non-JSON, or missing required fields) so callers can skip it without crashing.
 */
export function decodeFrame(event: SseEvent): ChatFrame | null {
  if (event.event === 'done') {
    return { type: 'done' };
  }
  if (event.event === 'meta') {
    try {
      const parsed = JSON.parse(event.data) as { runId?: unknown; threadId?: unknown };
      return {
        type: 'meta',
        ...(typeof parsed?.runId === 'string' ? { runId: parsed.runId } : {}),
        ...(typeof parsed?.threadId === 'string' ? { threadId: parsed.threadId } : {}),
      };
    } catch {
      return null;
    }
  }
  if (event.event === 'error') {
    try {
      const parsed = JSON.parse(event.data) as { code?: unknown; message?: unknown };
      return {
        type: 'error',
        code: typeof parsed?.code === 'string' ? parsed.code : 'run_failed',
        message: typeof parsed?.message === 'string' ? parsed.message : 'The run failed.',
      };
    } catch {
      return { type: 'error', code: 'run_failed', message: 'The run failed.' };
    }
  }
  // Default event: one `AgentStreamEvent` (`{ kind, … }`).
  try {
    const parsed = JSON.parse(event.data) as { kind?: unknown } | null;
    if (typeof parsed?.kind !== 'string') {
      return null;
    }
    return decodeAgentEvent(parsed as Record<string, unknown> & { kind: string });
  } catch {
    return null;
  }
}

/**
 * One frame of the agent stream protocol as a {@link ChatFrame}. The kinds this client folds into a
 * message or acts on (text, ui, elicitation, approval-requested) get their own frame; every other
 * kind (reasoning, tool calls, steps, title, …) arrives as `{ type: 'event' }`, which
 * {@link foldPart} ignores — but for a `step-start`, see there — and `onFrame` still sees.
 */
function decodeAgentEvent(event: Record<string, unknown> & { kind: string }): ChatFrame | null {
  if (event.kind === 'text') {
    return typeof event.text === 'string' && event.text.length > 0
      ? { type: 'text', delta: event.text }
      : null;
  }
  if (event.kind === 'ui' && typeof event.component === 'string') {
    return {
      type: 'component',
      name: event.component,
      data: event.props,
      ...(typeof event.id === 'string' ? { id: event.id } : {}),
      ...(typeof event.version === 'number' ? { version: event.version } : {}),
      ...(typeof event.fallbackText === 'string' ? { fallbackText: event.fallbackText } : {}),
      ...(event.componentVersions !== null &&
      typeof event.componentVersions === 'object' &&
      !Array.isArray(event.componentVersions)
        ? { componentVersions: event.componentVersions as Record<string, number> }
        : {}),
      ...(event.partial === true ? { partial: true as const } : {}),
    };
  }
  if (event.kind === 'elicitation' && typeof event.id === 'string') {
    if (typeof event.runId !== 'string') return { type: 'event', event };
    return {
      type: 'elicitation',
      runId: event.runId,
      toolCallId: event.id,
      request: event.request as ElicitationRequest,
    };
  }
  if (
    event.kind === 'approval-requested' &&
    typeof event.id === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.toolName === 'string'
  ) {
    const confirmation = decodeConfirmation(event.confirmation);
    return {
      type: 'approval',
      ...(event.target &&
      typeof event.target === 'object' &&
      Reflect.get(event.target, 'kind') === 'proposal' &&
      typeof Reflect.get(event.target, 'proposalId') === 'string'
        ? {
            target: {
              kind: 'proposal' as const,
              proposalId: Reflect.get(event.target, 'proposalId') as string,
            },
          }
        : {}),
      runId: event.runId,
      toolCallId: event.id,
      toolName: event.toolName,
      input: event.input,
      ...(confirmation !== undefined ? { confirmation } : {}),
      ...(typeof event.approver === 'string' ? { approver: event.approver } : {}),
      ...(typeof event.expiresAt === 'string' ? { expiresAt: event.expiresAt } : {}),
      ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
    };
  }
  return { type: 'event', event };
}

/**
 * Folds a renderable {@link ChatFrame} (text or component) into the message's parts, concatenating
 * consecutive text deltas into the trailing text part and appending components in order. A
 * `step-start` closes the text before it with a paragraph break ({@link STEP_SEPARATOR}), so two
 * model steps never run into each other.
 * `meta`/`elicitation`/`approval`/`done` are control frames and are ignored here — a form to put to
 * the user is not a part of the assistant's message. Returns a new array (never mutates the input).
 */
export function foldPart(parts: ChatPart[], frame: ChatFrame): ChatPart[] {
  if (frame.type === 'component') {
    const part: ChatPart = {
      type: 'component',
      name: frame.name,
      data: frame.data,
      ...(frame.id !== undefined ? { id: frame.id } : {}),
      ...(frame.version !== undefined ? { version: frame.version } : {}),
      ...(frame.fallbackText !== undefined ? { fallbackText: frame.fallbackText } : {}),
      ...(frame.componentVersions !== undefined
        ? { componentVersions: frame.componentVersions }
        : {}),
      ...(frame.partial === true ? { partial: true as const } : {}),
    };
    // A repeat id (agent protocol `ui`) replaces the component in place, never adds a second one.
    const at =
      frame.id === undefined
        ? -1
        : parts.findIndex((each) => each.type === 'component' && each.id === frame.id);
    // A withdrawn preview (partial, nothing to draw) removes the component it previewed.
    if (frame.partial === true && isEmptyRecord(frame.data)) {
      return at === -1 ? parts : parts.filter((_, index) => index !== at);
    }
    return at === -1 ? [...parts, part] : parts.map((each, index) => (index === at ? part : each));
  }
  if (frame.type === 'text') {
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') {
      return [...parts.slice(0, -1), { type: 'text', text: last.text + frame.delta }];
    }
    return [...parts, { type: 'text', text: frame.delta }];
  }
  if (frame.type === 'event' && frame.event.kind === 'step-start') {
    // A new model step. What it says is a new paragraph, not the continuation of a sentence: the
    // step before it ended to call tools, so its text stops wherever the model stopped ("…before
    // answering.") and the next one would otherwise be glued to it ("…before answering.Let me…").
    // Only text the message already ends with is closed — a step that opens after a component, or
    // first, has nothing to be separated from.
    const last = parts[parts.length - 1];
    if (
      last &&
      last.type === 'text' &&
      last.text.trim().length > 0 &&
      !last.text.endsWith('\n\n')
    ) {
      return [...parts.slice(0, -1), { type: 'text', text: `${last.text}${STEP_SEPARATOR}` }];
    }
  }
  return parts;
}

/** What separates the text of two consecutive model steps in one message: a paragraph break. */
export const STEP_SEPARATOR = '\n\n';

/**
 * Reads a byte {@link ReadableStream} (a `fetch` `response.body`) as a sequence of raw SSE events,
 * splitting on the `\n\n` frame separator and buffering partial frames across chunks. Yields only
 * frames that carry a `data:` payload (keep-alives are dropped).
 */
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const parsed = parseSseEvent(frame);
        if (parsed) {
          yield parsed;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Optional presentation metadata is accepted only when every supplied field has its declared type. */
function decodeConfirmation(value: unknown): ToolConfirmation | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    !('verb' in value) ||
    typeof value.verb !== 'string'
  )
    return undefined;
  if ('detail' in value && typeof value.detail !== 'string') return undefined;
  return {
    title: value.title,
    verb: value.verb,
    ...('detail' in value && typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** The parts with every preview left standing removed — what a finished stream keeps. */
export function settleParts(parts: ChatPart[]): ChatPart[] {
  return parts.some((part) => part.type === 'component' && part.partial === true)
    ? parts.filter((part) => !(part.type === 'component' && part.partial === true))
    : parts;
}
