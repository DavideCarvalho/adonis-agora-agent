import type { ChatStreamFile, ChatStreamRequest, ChatStreamResponse } from './backend.js';
import type { AgentStreamEvent } from './client-wire.js';

/**
 * Talk to an AG-UI 1.0 producer (https://docs.ag-ui.com/spec/1.0) through `useAgentChat`.
 *
 * `agUiChatStream` POSTs a `RunAgentInput` and hands the transport the answer re-framed in this
 * library's stream protocol, so everything built on `useAgentChat` — the transcript, tool activity,
 * generative UI — renders an AG-UI agent unchanged. Put it behind `openChatStream` of any backend:
 *
 * ```ts
 * const backend: AgentBackend = {
 *   ...httpBackend,
 *   openChatStream: (request) => agUiChatStream(request, { url: '/agent/ag-ui' }),
 * }
 * ```
 *
 * What maps where (the inverse of the producer in `@adonis-agora/agent/ag-ui`):
 *  - `TEXT_MESSAGE_*` → `text`; `REASONING_MESSAGE_*` → `reasoning`; `STEP_*` → `step-start` /
 *    `step-finish` (with the step's usage, cost and model from the `agora.step-usage` that follows
 *    it);
 *  - `TOOL_CALL_START` / `ARGS` / `END` → `tool-input-start` / `-delta` / `-available`, the call's
 *    kind from `metadata['agora.toolKind']` (`read` when a producer does not say);
 *    `TOOL_CALL_RESULT` → `tool-output` (or `tool-output-error` / `-denied`, from
 *    `metadata['agora.outcome']`);
 *  - `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` → a `ui` part named `AgUiActivity`, id
 *    `activity:<messageId>`, props `{ activityType, content }` — the whole content each time (the
 *    delta's JSON Patch applied here), so a repeat replaces the widget in place;
 *  - `RUN_ERROR` → the stream's `event: error`; `RUN_FINISHED` → `event: done` (a cancelled
 *    outcome writes `cancelled` first; an interrupt outcome whose interrupts the stream did not
 *    already carry as an approval or a question set writes a `ui` part named `AgUiInterrupt` with
 *    those, for the app to render);
 *  - `CUSTOM` events a producer of this family writes (`agora.ui`, `agora.title`, `agora.queue`,
 *    `agora.approval-requested` / `-settled`, `agora.elicitation`, `agora.step-usage`,
 *    `agora.run`) → the frames they stand for. Any other `CUSTOM` is ignored, as the protocol
 *    requires of a consumer that does not know it.
 *
 * The send's staged uploads (`attachments` refs) travel as media parts of the user message, by
 * `file` handle: `{ type: 'image' | …, source: { type: 'file', provider: 'agora', value: <mediaId> } }`
 * — what `agUiAdapter()` resolves for the caller. A regenerate travels as
 * `forwardedProps.regenerate`.
 */
export interface AgUiChatStreamOptions {
  /** The producer's endpoint (`POST`, `RunAgentInput` in, `text/event-stream` out). */
  url: string;
  /** Headers for every request (auth, CSRF). Per-request headers from the send win. */
  headers?: Record<string, string>;
  /** Defaults to the global `fetch`, with `credentials: 'same-origin'`. */
  fetch?: typeof fetch;
  /**
   * Shape `forwardedProps` from the send's body. Default: `{ pageContext, agent, model, persona, uiCapabilities }` from the
   * body, whichever are present. A regenerate adds `regenerate: true` to whatever this returns (an
   * object, or nothing).
   */
  forwardedProps?: (body: Record<string, unknown>) => unknown;
  /** Read the refusal of a non-2xx answer. Default: the JSON body's `message`, else the status. */
  refusal?: (response: Response) => Promise<Error>;
  /**
   * The user message's `content` for the send. Default: the body's `message` as a string, or —
   * when the send carries staged uploads (`attachments`) — a `text` part and one media part per
   * upload, by `file` handle (`provider: 'agora'`). Return your own list of AG-UI content parts to
   * send files otherwise — `{ type: 'image' | 'document' | …, source: { type: 'data',
   * value: <base64>, mimeType } }` — with the text as a `text` part. `files` describes the staged
   * uploads (content type, name) when the chat knows them.
   */
  content?: (
    body: Record<string, unknown>,
    files: readonly ChatStreamFile[],
  ) => string | AgUiContentPart[];
}

/** One AG-UI content part of a user message (text, or media by inline data, url or file handle). */
export type AgUiContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'audio' | 'video' | 'document';
      source:
        | { type: 'data'; value: string; mimeType: string }
        | { type: 'url'; value: string; mimeType?: string }
        | { type: 'file'; value: string; provider?: string; mimeType?: string };
      metadata?: Record<string, unknown>;
    };

/** The ids of an AG-UI run this consumer invented, when the send did not name a thread. */
function newId(): string {
  return globalThis.crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function defaultRefusal(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0) return new Error(body.message);
  } catch {
    // not JSON: fall through to the status
  }
  return new Error(`The agent refused the request (${response.status}).`);
}

/** The provider name `agUiAdapter()` reads a `file` handle to one of its own uploads by. */
const AG_UI_STAGED_MEDIA_PROVIDER = 'agora';

function mediaKind(contentType: string | undefined): 'image' | 'audio' | 'video' | 'document' {
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('audio/')) return 'audio';
  if (contentType?.startsWith('video/')) return 'video';
  return 'document';
}

/** The body's message, and its staged uploads as media parts by `file` handle. */
function defaultContent(
  body: Record<string, unknown>,
  files: readonly ChatStreamFile[],
): string | AgUiContentPart[] {
  const message = typeof body.message === 'string' ? body.message : '';
  const refs = Array.isArray(body.attachments)
    ? body.attachments.flatMap((ref) =>
        isRecord(ref) && typeof ref.mediaId === 'string' && ref.mediaId.length > 0
          ? [ref.mediaId]
          : [],
      )
    : [];
  if (refs.length === 0) return message;
  const parts: AgUiContentPart[] = message.length > 0 ? [{ type: 'text', text: message }] : [];
  for (const mediaId of refs) {
    const file = files.find((each) => each.mediaId === mediaId);
    parts.push({
      type: mediaKind(file?.contentType),
      source: {
        type: 'file',
        provider: AG_UI_STAGED_MEDIA_PROVIDER,
        value: mediaId,
        ...(file?.contentType !== undefined ? { mimeType: file.contentType } : {}),
      },
      ...(file?.name !== undefined ? { metadata: { filename: file.name } } : {}),
    });
  }
  return parts;
}

function defaultForwardedProps(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const key of ['pageContext', 'agent', 'model', 'persona', 'uiCapabilities']) {
    if (body[key] !== undefined && body[key] !== null) out[key] = body[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Start a turn against an AG-UI producer; the stream comes back in this library's framing. */
export async function agUiChatStream(
  request: ChatStreamRequest,
  options: AgUiChatStreamOptions,
): Promise<ChatStreamResponse> {
  const body = request.body;
  const threadId = typeof body.threadId === 'string' ? body.threadId : newId();
  const files = request.files ?? [];
  let forwarded = (options.forwardedProps ?? defaultForwardedProps)(body);
  // Not a body field the app shapes: without it the producer would answer the question again.
  if (body.regenerate === true && (forwarded === undefined || isRecord(forwarded))) {
    forwarded = { ...forwarded, regenerate: true };
  }
  const input = {
    threadId,
    runId: newId(),
    protocolVersion: '1.0',
    messages: [
      {
        id: newId(),
        role: 'user',
        content: (options.content ?? defaultContent)(body, files),
      },
    ],
    ...(forwarded !== undefined ? { forwardedProps: forwarded } : {}),
  };
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await doFetch(options.url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...options.headers,
      ...request.headers,
    },
    body: JSON.stringify(input),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  if (!response.ok || response.body === null) {
    throw await (options.refusal ?? defaultRefusal)(response);
  }
  const runId = response.headers.get('x-agent-run-id') ?? undefined;
  return {
    body: reframeAgUiStream(response.body, { threadId }),
    threadId,
    ...(runId !== undefined ? { runId } : {}),
  };
}

type AgUiEvent = { type: string; [key: string]: unknown };

interface Reframer {
  /** The frames (already SSE-encoded) one AG-UI event stands for. */
  push(event: AgUiEvent): string;
  /** What is still held back when the stream stops without a terminal event. */
  end(): string;
  /** Set when the run ended; nothing is written after it. */
  closed: boolean;
}

/**
 * Re-frame an AG-UI event stream (SSE, one event per `data:`) in this library's stream protocol:
 * `event: meta`, numbered `data:` frames of {@link AgentStreamEvent}, then `event: done` or
 * `event: error`. Exported for a backend that fetches the stream itself.
 */
export function reframeAgUiStream(
  source: ReadableStream<Uint8Array>,
  ids: { threadId: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reframer = createReframer(ids.threadId);
  const reader = source.getReader();
  let buffer = '';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          // A stream that stopped without a terminal event is a truncated run: end it plainly, and
          // the transport reads the stored thread for the rest.
          const rest = reframer.end();
          if (rest.length > 0) controller.enqueue(encoder.encode(rest));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let out = '';
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data.length === 0) continue;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          if (isRecord(event) && typeof event.type === 'string') {
            out += reframer.push(event as AgUiEvent);
          }
          if (reframer.closed) break;
        }
        if (out.length > 0) controller.enqueue(encoder.encode(out));
        if (reframer.closed) {
          void reader.cancel().catch(() => undefined);
          controller.close();
          return;
        }
        if (out.length > 0) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

function createReframer(threadId: string): Reframer {
  const activities = new Map<string, { activityType: string; content: Record<string, unknown> }>();
  let seq = 0;
  let metaSent = false;
  const tools = new Map<string, { name: string; args: string; toolKind: 'read' | 'action' }>();
  // `STEP_FINISHED` is held until the next event: the producer's `agora.step-usage` right after it
  // carries what the step spent.
  let stepFinished = false;
  // Interrupts the stream already carried as an approval card or a question set (by call id, and
  // the question sets themselves for one that belongs to no call).
  const carried = new Set<string>();
  const carriedRequests = new Set<string>();
  const state: Reframer = {
    closed: false,
    end() {
      if (state.closed || !stepFinished) return '';
      stepFinished = false;
      seq += 1;
      return `id: ${seq}\ndata: ${JSON.stringify({ kind: 'step-finish' })}\n\n`;
    },
    push(event) {
      if (state.closed) return '';
      let out = '';
      const frame = (streamEvent: AgentStreamEvent | Record<string, unknown>) => {
        seq += 1;
        out += `id: ${seq}\ndata: ${JSON.stringify(streamEvent)}\n\n`;
      };
      const meta = (runId: unknown, thread: unknown) => {
        if (metaSent) return;
        metaSent = true;
        out += `event: meta\ndata: ${JSON.stringify({
          runId: typeof runId === 'string' ? runId : '',
          threadId: typeof thread === 'string' ? thread : threadId,
        })}\n\n`;
      };
      const flushStep = (extra: Record<string, unknown> = {}) => {
        if (!stepFinished) return;
        stepFinished = false;
        frame({ kind: 'step-finish', ...extra });
      };
      if (
        stepFinished &&
        event.type === 'CUSTOM' &&
        event.name === 'agora.step-usage' &&
        isRecord(event.value)
      ) {
        const value = event.value;
        flushStep({
          ...(isRecord(value.usage) ? { usage: value.usage } : {}),
          ...(typeof value.costUsd === 'number' || value.costUsd === null
            ? { costUsd: value.costUsd }
            : {}),
          ...(typeof value.reasoningMs === 'number' ? { reasoningMs: value.reasoningMs } : {}),
          ...(typeof value.model === 'string' ? { model: value.model } : {}),
        });
        return out;
      }
      flushStep();
      switch (event.type) {
        case 'RUN_STARTED':
          // `agora.run` (next) names the library's own run; wait a beat for it only if it follows
          // at once — otherwise the protocol's own ids do.
          pendingStart = { runId: event.runId, threadId: event.threadId };
          return out;
        case 'CUSTOM': {
          const value = event.value;
          if (event.name === 'agora.run' && isRecord(value)) {
            meta(value.runId, pendingStart?.threadId ?? value.threadId);
            pendingStart = undefined;
            return out;
          }
          flushStart();
          if (!isRecord(value)) return out;
          if (event.name === 'agora.ui') frame({ kind: 'ui', ...value });
          else if (event.name === 'agora.title' && typeof value.title === 'string') {
            frame({ kind: 'title', title: value.title });
          } else if (event.name === 'agora.queue') frame({ kind: 'queue', ...value });
          else if (event.name === 'agora.approval-requested') {
            if (typeof value.id === 'string') carried.add(value.id);
            frame({ ...value, kind: 'approval-requested' });
          } else if (event.name === 'agora.elicitation') {
            // The question block answers it by id (the call that asked); a producer that does not
            // say which leaves it to the interrupt.
            if (typeof value.id === 'string' && isRecord(value.request)) {
              carried.add(value.id);
              carriedRequests.add(JSON.stringify(value.request));
              frame({ kind: 'elicitation', id: value.id, request: value.request });
            }
          } else if (event.name === 'agora.approval-settled') {
            frame({ ...value, kind: 'approval-settled' });
          }
          return out;
        }
        default:
          flushStart();
      }
      switch (event.type) {
        case 'TEXT_MESSAGE_CONTENT':
        case 'TEXT_MESSAGE_CHUNK':
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            frame({ kind: 'text', text: event.delta });
          }
          break;
        case 'REASONING_MESSAGE_CONTENT':
        case 'REASONING_MESSAGE_CHUNK':
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            frame({ kind: 'reasoning', text: event.delta });
          }
          break;
        case 'STEP_STARTED':
          frame({ kind: 'step-start' });
          break;
        case 'STEP_FINISHED':
          stepFinished = true;
          break;
        case 'TOOL_CALL_START':
        case 'TOOL_CALL_CHUNK': {
          const id = String(event.toolCallId ?? '');
          if (id === '') break;
          if (!tools.has(id)) {
            const name = typeof event.toolCallName === 'string' ? event.toolCallName : '';
            const toolKind =
              isRecord(event.metadata) && event.metadata['agora.toolKind'] === 'action'
                ? 'action'
                : 'read';
            tools.set(id, { name, args: '', toolKind });
            frame({ kind: 'tool-input-start', id, name, toolKind });
          }
          if (event.type === 'TOOL_CALL_CHUNK' && typeof event.delta === 'string') {
            (tools.get(id) as { args: string }).args += event.delta;
            frame({ kind: 'tool-input-delta', id, delta: event.delta });
          }
          break;
        }
        case 'TOOL_CALL_ARGS': {
          const call = tools.get(String(event.toolCallId));
          if (call === undefined || typeof event.delta !== 'string') break;
          call.args += event.delta;
          frame({ kind: 'tool-input-delta', id: String(event.toolCallId), delta: event.delta });
          break;
        }
        case 'TOOL_CALL_END': {
          const id = String(event.toolCallId);
          const call = tools.get(id);
          if (call === undefined) break;
          frame({
            kind: 'tool-input-available',
            id,
            name: call.name,
            input: parseJson(call.args, {}),
            toolKind: call.toolKind,
          });
          break;
        }
        case 'TOOL_CALL_RESULT': {
          const id = String(event.toolCallId);
          const content = contentText(event.content);
          const outcome = isRecord(event.metadata) ? event.metadata['agora.outcome'] : undefined;
          if (outcome === 'error') frame({ kind: 'tool-output-error', id, error: content });
          else if (outcome === 'denied') frame({ kind: 'tool-output-denied', id, reason: content });
          else frame({ kind: 'tool-output', id, output: parseJson(content, content) });
          break;
        }
        case 'ACTIVITY_SNAPSHOT':
        case 'ACTIVITY_DELTA': {
          const messageId = typeof event.messageId === 'string' ? event.messageId : '';
          if (messageId === '') break;
          const known = activities.get(messageId);
          const activityType =
            typeof event.activityType === 'string'
              ? event.activityType
              : (known?.activityType ?? '');
          let content: Record<string, unknown> | undefined;
          if (event.type === 'ACTIVITY_SNAPSHOT') {
            // `replace: false` leaves an existing activity as it stands
            if (known !== undefined && event.replace === false) break;
            content = isRecord(event.content) ? event.content : {};
          } else {
            // a delta for an activity nothing created is skipped, never fatal
            if (known === undefined || !Array.isArray(event.patch)) break;
            content = applyPatch(known.content, event.patch);
            if (content === undefined) break;
          }
          activities.set(messageId, { activityType, content });
          frame({
            kind: 'ui',
            id: `activity:${messageId}`,
            component: 'AgUiActivity',
            props: { activityType, content },
          });
          break;
        }
        case 'RUN_ERROR':
          state.closed = true;
          out += `event: error\ndata: ${JSON.stringify({
            code: typeof event.code === 'string' ? event.code : 'run_failed',
            message: typeof event.message === 'string' ? event.message : 'The run failed.',
          })}\n\n`;
          break;
        case 'RUN_FINISHED': {
          const outcome = isRecord(event.outcome) ? event.outcome : undefined;
          if (outcome?.type === 'cancelled') frame({ kind: 'cancelled' });
          if (outcome?.type === 'interrupt' && Array.isArray(outcome.interrupts)) {
            // What the stream already showed as an approval card or a question block is answered
            // there; the rest is the app's to render.
            const interrupts = outcome.interrupts.filter((interrupt) => !isCarried(interrupt));
            if (interrupts.length > 0) {
              frame({
                kind: 'ui',
                id: `ag-ui:interrupt:${String(event.runId ?? '')}`,
                component: 'AgUiInterrupt',
                props: { interrupts },
              });
            }
          }
          state.closed = true;
          out += 'event: done\ndata: {}\n\n';
          break;
        }
        default:
          // Everything else (message and span brackets, state, activity, raw) carries nothing this
          // framing does not already say.
          break;
      }
      return out;

      function isCarried(interrupt: unknown): boolean {
        if (!isRecord(interrupt)) return false;
        if (typeof interrupt.toolCallId === 'string' && carried.has(interrupt.toolCallId)) {
          return true;
        }
        const request = isRecord(interrupt.metadata)
          ? interrupt.metadata['agora.request']
          : undefined;
        return request !== undefined && carriedRequests.has(JSON.stringify(request));
      }

      function flushStart() {
        if (pendingStart !== undefined) {
          meta(pendingStart.runId, pendingStart.threadId);
          pendingStart = undefined;
        }
      }
    },
  };
  let pendingStart: { runId: unknown; threadId: unknown } | undefined;
  return state;
}

function parseJson(text: string, fallback: unknown): unknown {
  if (text.trim().length === 0) return fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

/** A result's content as text: a string, or its text parts in order (other parts carry no text). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('');
}

/**
 * RFC 6902 on a copy: `add`, `replace`, `remove` (and `test`, which fails the patch). `undefined`
 * when the patch does not apply — the activity then keeps its last good content until a snapshot.
 */
function applyPatch(
  target: Record<string, unknown>,
  patch: unknown[],
): Record<string, unknown> | undefined {
  const doc = structuredClone(target) as Record<string, unknown>;
  for (const operation of patch) {
    if (!isRecord(operation) || typeof operation.path !== 'string') return undefined;
    const tokens = operation.path
      .split('/')
      .slice(1)
      .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = tokens.pop();
    if (key === undefined) return undefined;
    let parent: unknown = doc;
    for (const token of tokens) {
      parent = Array.isArray(parent)
        ? parent[Number(token)]
        : isRecord(parent)
          ? parent[token]
          : undefined;
      if (parent === undefined) return undefined;
    }
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) return undefined;
      if (operation.op === 'add') parent.splice(index, 0, operation.value);
      else if (operation.op === 'replace' && index < parent.length) parent[index] = operation.value;
      else if (operation.op === 'remove' && index < parent.length) parent.splice(index, 1);
      else if (operation.op === 'test') {
        if (JSON.stringify(parent[index]) !== JSON.stringify(operation.value)) return undefined;
      } else return undefined;
    } else if (isRecord(parent)) {
      if (operation.op === 'add' || (operation.op === 'replace' && key in parent)) {
        parent[key] = operation.value;
      } else if (operation.op === 'remove' && key in parent) delete parent[key];
      else if (operation.op === 'test') {
        if (JSON.stringify(parent[key]) !== JSON.stringify(operation.value)) return undefined;
      } else return undefined;
    } else return undefined;
  }
  return doc;
}
