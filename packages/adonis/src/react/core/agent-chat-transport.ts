import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type {
  AgentBackend,
  ChatStreamFile,
  ChatStreamResponse,
  QueuedSendResult,
} from './backend.js';
import { AgentClient } from './client.js';
import type { AgentStreamEvent } from './client-wire.js';
import { reasoningDurationMetadata } from './reasoning/timing.js';
import type { AgentRunFailure } from './run-errors.js';

/** JSON-safe metadata, as the SDK's `toolMetadata` requires (its `JSONObject` is not exported). */
type ToolMetadata = { [key: string]: string };

/** Identity surfaced by the backend's `meta` SSE frame / response headers. */
export interface AgentStreamMeta {
  runId: string;
  threadId: string;
}

/**
 * How the transport retries a stream that dropped mid-run. It reconnects only to a server that
 * numbers its frames (SSE `id:`) — without a cursor a reconnect would replay the run into the
 * message it is already writing.
 */
export interface ReconnectOptions {
  /** Attempts before giving up with an error chunk. Default 6. */
  maxAttempts?: number;
  /** Delay before the first attempt, doubled each attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Cap on the delay between attempts. Default 8000 ms. */
  maxDelayMs?: number;
}

/** Where a live stream stands. `reconnecting` → it dropped and the transport is retrying. */
export type StreamConnectionState =
  | { status: 'live' }
  | { status: 'reconnecting'; runId: string; attempt: number; after: number }
  /** The run ended while the client was away (the resume answered 404): reload the thread. */
  | { status: 'gone'; runId: string }
  /** Every attempt failed; the stream ended with an error chunk. */
  | { status: 'failed'; runId: string };

export interface AgentChatTransportOptions {
  /**
   * What the transport talks to. Default: an {@link AgentClient} built from `baseUrl`, `headers`,
   * `getHeaders`, `credentials` and `fetch` below — which are ignored when a backend is given.
   */
  backend?: AgentBackend;
  /** Retry a dropped stream from its last frame. Default on; `false` turns it off. */
  reconnect?: ReconnectOptions | false;
  /** Fires as a stream drops, reconnects, or gives up. */
  onConnectionChange?: (state: StreamConnectionState) => void;
  /** The server's origin, e.g. `https://api.example.com`. Defaults to `''` (same origin). */
  baseUrl?: string;
  /** The agent's route prefix (`AgentModule`'s `path`, global prefix included). Default `'agent'`. */
  path?: string;
  /** Static headers merged into every request (e.g. a tenant ref). */
  headers?: Record<string, string>;
  /**
   * Resolved at request time — use for short-lived bearer tokens that
   * must not be captured once at construction. Merged over `headers`.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Forwarded to `fetch` so cookie-based auth/impersonation works. */
  credentials?: RequestCredentials;
  /** Named agent to run the turn (backend `agent` field). */
  agent?: string;
  /** One of the agent's personas to answer as (backend `persona` field). */
  persona?: string;
  /**
   * Extra body fields evaluated per send — the hook injects `threadId`
   * and `pageContext` through this. Returned object is spread into the
   * request body after the SDK's own `body`.
   */
  getBody?: () => Record<string, unknown>;
  /**
   * The run id to resume on mount, if any. Returning `undefined` makes
   * `reconnectToStream` resolve to `null` WITHOUT hitting the network —
   * this is the generalized fix for "useChat fires a doomed GET on mount
   * and surfaces its 404". Wire this to the thread's `activeRunId`.
   */
  getResumeRunId?: () => string | undefined;
  /**
   * Fires once `reconnectToStream` has attached to a run's stream, with that run's id. A resumed
   * stream replays frames but opens with no `meta` frame, so this is the only place a caller learns
   * which run it is now reading — what a Stop pressed after a reload has to cancel.
   */
  onResumeAttached?: (runId: string) => void;
  /** Fires whenever a stream emits its `meta` frame. */
  onMeta?: (meta: AgentStreamMeta) => void;
  /**
   * Fires synchronously at the very start of `sendMessages`/`reconnectToStream`, before any network
   * call — i.e. strictly before that attempt's own `onMeta` (if any) can fire. Lets a caller reset
   * "which run is THIS attempt settling" state without racing React's render/effect timing: a
   * consumer that also read `onMeta` to learn the current run id would otherwise risk misattributing
   * an early failure (no meta ever arrives) to a PRIOR attempt's id.
   */
  onAttemptStart?: () => void;
  /**
   * A resume found nothing streaming under the run id (the backend answered 404): the run already
   * ended. The SDK is told there is nothing to resume, so the caller is the one that has to reload
   * what the run wrote — `useAgentChat` re-reads the thread.
   */
  onResumeGone?: (runId: string) => void;
  /**
   * The run's stream ended with the backend's `event: error` frame — called with its `code` and
   * `message` right before the stream is closed with an error chunk. The chunk can only carry the
   * text; this is where the `code` reaches a caller, so it can word the failure itself.
   */
  onRunError?: (failure: AgentRunFailure) => void;
  /** Injectable for tests / non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

/**
 * The tool name BOTH elicitation surfaces persist their question set under (core's
 * `ASK_TOOL_NAME`), so a synthesized part and a replayed `tool-ask` row are the same part type.
 * Spelled out rather than imported: every other core import in this package is type-only, and a
 * value import would pull the agent loop into a browser bundle for a three-letter string.
 */
const ASK_TOOL_NAME = 'ask';

/**
 * AI SDK v7 `ChatTransport` for the Adonis agent backend. POSTs
 * `/agent/chat`, parses the backend's `meta` + `{delta}` + `done` SSE
 * frames, and re-emits them as the v7 UI-message chunk stream
 * (`start` → `text-start` → `text-delta`* → `text-end` → `finish`).
 *
 * The backend hydrates prior history from its store, so only the latest
 * user message text is sent each turn — keeping payloads tiny and
 * preventing the client from corrupting replayed history.
 *
 * Attachments (image/PDF for a vision-capable model) ride the per-send body:
 * `sendMessage({ text }, { body: { attachments: MessageAttachment[] } })`. They
 * flow to the backend as the turn's `attachments`, get persisted on the user
 * message, and are rendered as native model content parts. Optimistic display of
 * the user's own attachment thumbnails is the consumer's concern (it stages the
 * upload), the same way history rendering reads `StoredMessage.attachments`.
 *
 * Frames beyond text/reasoning/tools become AI SDK data parts (seen by `useChat`'s `onData`):
 *  - `ui`                 → `data-ui` part, `id` = the component id (a repeat id updates it in place)
 *  - `approval-requested` → `data-approval-requested` part keyed by the call id, plus the SDK's
 *                           native `tool-approval-request` (the part moves to `approval-requested`)
 *  - `approval-settled`   → `data-approval-settled` part keyed by the call id (who decided, through
 *                           what, remembered or not); the outcome still rides the call's own output
 *  - `title`, `cancelled`, `queue` → transient `data-title` / `data-cancelled` / `data-queue` (never
 *                           stored on the message). A send the server queued (`202`) is reported
 *                           as a transient `data-queue` too, carrying `queuedSend`
 *  - any other kind       → `data-<kind>` part carrying the frame minus `kind`, keyed by its `id`
 *                           when it has one — forwarded, never dropped
 * `parentId` on a tool frame rides the part's `toolMetadata` next to `toolKind`.
 */
export class AgentChatTransport implements ChatTransport<UIMessage> {
  private currentRunId: string | undefined;
  private currentThreadId: string | undefined;

  /**
   * One attempt at a time. The AI SDK keeps a single in-flight response per chat and decides
   * whether its streamed message REPLACES the list's last entry or is appended by comparing that
   * response's message id against the last entry alone. Two attempts writing into one chat
   * therefore append alternating copies of each other's message, and the list ends up holding
   * several entries under each id — which React renders as duplicate keys.
   */
  private attemptLive = false;

  private readonly backend: AgentBackend;

  constructor(private readonly options: AgentChatTransportOptions = {}) {
    this.backend =
      options.backend ??
      new AgentClient({
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.getHeaders !== undefined ? { getHeaders: options.getHeaders } : {}),
        ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
  }

  /** Run id of the most recent stream — HITL approve/reject target this. */
  get runId(): string | undefined {
    return this.currentRunId;
  }

  /** Thread id of the most recent stream. */
  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  /**
   * True from the moment a send or resume attempt starts until its chunk stream terminates. A
   * caller that can refuse a turn BEFORE the SDK commits to one — `useAgentChat` wrapping
   * `sendMessage` — reads this; the transport itself can only refuse a resume, which is the one
   * attempt the SDK lets a transport decline.
   */
  get isAttemptLive(): boolean {
    return this.attemptLive;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.options.onAttemptStart?.();
    this.attemptLive = true;
    try {
      const lastMessage = options.messages.at(-1);
      const message = lastMessage ? extractText(lastMessage) : '';
      const body: Record<string, unknown> = {
        ...(this.options.agent !== undefined ? { agent: this.options.agent } : {}),
        ...(this.options.persona !== undefined ? { persona: this.options.persona } : {}),
        ...(this.options.getBody?.() ?? {}),
        ...((options.body as Record<string, unknown> | undefined) ?? {}),
        message,
      };
      const headers = headerRecord(options.headers);
      const files = lastMessage ? stagedFiles(lastMessage) : [];
      const response = await this.backend.openChatStream({
        body,
        ...(files.length > 0 ? { files } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });
      if (response.queued !== undefined) {
        // The thread already had a turn running (another tab, another device): the server queued
        // the message instead. Nothing streams; the chat learns it through a transient part.
        this.attemptLive = false;
        return queuedChunkStream(response.queued);
      }
      this.captureHeaderMeta(response);
      if (response.proposalDecision !== undefined) {
        this.attemptLive = false;
        return proposalDecisionChunkStream(response.proposalDecision);
      }
      return this.toChunkStream(response, {
        ...(headers !== undefined ? { headers } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });
    } catch (error) {
      this.attemptLive = false;
      throw error;
    }
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Already attached: a second reconnect replays the SAME buffered frames into the SAME chat, so
    // it adds a duplicate of the message the first attempt is writing rather than a second turn.
    // React StrictMode runs the SDK's resume effect twice on mount, which makes this the ordinary
    // case and not an edge one. `null` is the SDK's own "nothing to resume" answer and, unlike a
    // throw, leaves it holding no state for an attempt that never happened.
    if (this.attemptLive) return null;
    this.options.onAttemptStart?.();
    const runId = this.options.getResumeRunId?.();
    // No buffered run → resolve null without a network round-trip so we
    // never surface a 404 from a doomed resume GET.
    if (runId === undefined) return null;
    this.attemptLive = true;
    try {
      const headers = headerRecord(options.headers);
      const response = await this.backend.resumeChatStream({
        runId,
        ...(headers !== undefined ? { headers } : {}),
      });
      if (response === null) {
        this.attemptLive = false;
        this.options.onResumeGone?.(runId);
        return null;
      }
      this.captureHeaderMeta(response);
      this.options.onResumeAttached?.(response.runId ?? runId);
      return this.toChunkStream(response, {
        runId,
        ...(headers !== undefined ? { headers } : {}),
      });
    } catch (error) {
      this.attemptLive = false;
      throw error;
    }
  }

  private captureHeaderMeta(response: ChatStreamResponse): void {
    if (response.runId) this.currentRunId = response.runId;
    if (response.threadId) this.currentThreadId = response.threadId;
  }

  private reconnectPolicy(): Required<ReconnectOptions> | null {
    const configured = this.options.reconnect;
    if (configured === false) return null;
    return { ...DEFAULT_RECONNECT, ...configured };
  }

  private recordMeta(meta: AgentStreamMeta): void {
    this.currentRunId = meta.runId;
    this.currentThreadId = meta.threadId;
    this.options.onMeta?.(meta);
  }

  /**
   * Parse the backend's SSE byte stream and re-emit it as a valid v7 UI-message chunk stream.
   * Recognized frames:
   *  - `event: meta`  `data: {"runId","threadId"}`   → records identity
   *  - `data: <AgentStreamEvent JSON>`                → mapped to UI chunks (text / reasoning / tool /
   *                                                     `data-*`; see {@link AgentChatTransport} docs)
   *  - `event: done`  `data: {}`                      → terminates
   *  - `event: error` `data: {code,message}`          → error chunk
   *
   * A run is ONE UI message with N steps. Each `step-start`/`step-finish` pair brackets a model
   * call plus its tool execution; text and reasoning open lazily and close at the step boundary, so
   * tool-call cards (input streaming → output) render live between the prose.
   */
  private toChunkStream(
    source: ChatStreamResponse,
    context: { runId?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ): ReadableStream<UIMessageChunk> {
    let reader = source.body.getReader();
    let decoder = new TextDecoder();
    let buffer = '';
    // Resuming a dropped stream: the run it belongs to, and the sequence number (SSE `id:`) of the
    // last frame this stream has taken in. Only a server that numbers its frames can be resumed.
    let streamRunId = source.runId ?? context.runId;
    let lastSeq: number | undefined;
    let cancelled = false;
    const backend = this.backend;
    const policy = this.reconnectPolicy();
    const notify = (state: StreamConnectionState) => this.options.onConnectionChange?.(state);
    const reportRunError = (failure: { code: string | undefined; message: string }) => {
      try {
        this.options.onRunError?.({
          ...failure,
          ...(streamRunId !== undefined ? { runId: streamRunId } : {}),
        });
      } catch {
        /* a listener that throws must not replace the stream's own terminal */
      }
    };
    const aborted = () => cancelled || context.signal?.aborted === true;
    const canResume = () =>
      policy !== null && lastSeq !== undefined && streamRunId !== undefined && !aborted();
    /**
     * Re-attach after a drop: `GET …/stream?after=<lastSeq>`, backing off between attempts. The
     * chunk state (open step, text run, announced calls) is kept, so the resumed frames continue
     * the message instead of starting another.
     */
    const resume = async (): Promise<'resumed' | 'gone' | 'failed' | 'aborted'> => {
      const runId = streamRunId as string;
      const after = lastSeq ?? 0;
      const { maxAttempts, baseDelayMs, maxDelayMs } = policy as Required<ReconnectOptions>;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        notify({ status: 'reconnecting', runId, attempt, after });
        await delay(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)), context.signal);
        if (aborted()) return 'aborted';
        try {
          const next = await backend.resumeChatStream({
            runId,
            after,
            ...(context.headers !== undefined ? { headers: context.headers } : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          });
          if (next === null) {
            notify({ status: 'gone', runId });
            return 'gone';
          }
          reader = next.body.getReader();
          decoder = new TextDecoder();
          buffer = '';
          notify({ status: 'live' });
          return 'resumed';
        } catch {
          if (aborted()) return 'aborted';
        }
      }
      notify({ status: 'failed', runId });
      return 'failed';
    };
    let started = false;
    let stepOpen = false;
    let stepIndex = 0;
    let textId: string | null = null;
    let reasoningId: string | null = null;
    // When the open reasoning run started, for the duration stamped on its end when the backend
    // does not report one (see `closeRuns`).
    let reasoningStartedAt = 0;
    // Text/reasoning runs opened within the current step. A pushed UI component closes the open run
    // so prose after it lands AFTER it; the next run then needs an id of its own.
    let textSeq = 0;
    let reasoningSeq = 0;
    // Tool calls this STREAM has already announced. The AI SDK settles a tool part by looking it
    // up by call id and throws — dropping the whole message — when there is none, so an outcome
    // must never be the first a client hears of a call. Per stream, not per transport: a resumed
    // run replays its buffered frames from the beginning.
    const announced = new Set<string>();
    // What each call's tool part carries as `toolMetadata`. The SDK REPLACES a part's metadata with
    // whatever the latest chunk carries, so a `parentId` learnt from `tool-input-start` would be
    // wiped by the `tool-input-available` that follows unless every chunk restates the merge.
    const toolMetadata = new Map<string, ToolMetadata>();
    const record = (meta: AgentStreamMeta) => {
      streamRunId = meta.runId;
      this.recordMeta(meta);
    };
    // Every way out of the read loop below passes through here: the attempt is over the moment its
    // chunk stream terminates, and a latch left set would refuse every later turn.
    const endAttempt = () => {
      this.attemptLive = false;
    };

    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        function ensureStarted() {
          if (started) return;
          started = true;
          // The run rides the message's metadata, so a later call about THIS message (feedback,
          // a resync) can find the rows the server persisted for it.
          // `createdAt` so a live message has a timestamp the way a replayed one does.
          controller.enqueue({
            type: 'start',
            messageMetadata: {
              ...(streamRunId !== undefined ? { runId: streamRunId } : {}),
              createdAt: new Date().toISOString(),
            },
          });
        }
        function openStep() {
          ensureStarted();
          if (stepOpen) closeStep();
          stepOpen = true;
          stepIndex += 1;
          textId = null;
          reasoningId = null;
          textSeq = 0;
          reasoningSeq = 0;
          controller.enqueue({ type: 'start-step' });
        }
        function ensureStep() {
          if (!stepOpen) openStep();
        }
        /**
         * `reasoningMs` is the backend's own measurement (`step-finish.reasoningMs`) — the number the
         * store persists, so a reloaded thread reads the same duration. Without one, the time this
         * client watched the run stream, which is what the reader saw but reads ~0 on a replay.
         */
        function closeRuns(reasoningMs?: number) {
          if (textId !== null) {
            controller.enqueue({ type: 'text-end', id: textId });
            textId = null;
          }
          if (reasoningId !== null) {
            controller.enqueue({
              type: 'reasoning-end',
              id: reasoningId,
              providerMetadata: reasoningDurationMetadata(
                reasoningMs ?? Math.max(0, Date.now() - reasoningStartedAt),
              ),
            });
            reasoningId = null;
          }
        }
        function closeStep(reasoningMs?: number) {
          if (!stepOpen) return;
          closeRuns(reasoningMs);
          controller.enqueue({ type: 'finish-step' });
          stepOpen = false;
        }
        /** Merge what this frame says about a call into what earlier frames said, and return it. */
        function metadataFor(
          id: string,
          toolKind: string | undefined,
          parentId: string | undefined,
        ): ToolMetadata | undefined {
          const merged: ToolMetadata = { ...toolMetadata.get(id) };
          if (toolKind !== undefined) merged.toolKind = toolKind;
          // A call's parent is fixed by the first frame that names one.
          if (parentId !== undefined && merged.parentId === undefined) merged.parentId = parentId;
          if (Object.keys(merged).length === 0) return undefined;
          toolMetadata.set(id, merged);
          return merged;
        }
        /** Forward a frame this transport has no dedicated mapping for as an AI SDK data part. */
        function forwardAsData(event: { kind: string }, transient: boolean) {
          ensureStarted();
          const { kind, ...data } = event as { kind: string } & Record<string, unknown>;
          controller.enqueue({
            type: `data-${kind}`,
            ...(typeof data.id === 'string' ? { id: data.id } : {}),
            data,
            ...(transient ? { transient: true } : {}),
          });
        }
        function emit(event: AgentStreamEvent) {
          switch (event.kind) {
            case 'step-start':
              openStep();
              break;
            case 'step-finish':
              closeStep(event.reasoningMs);
              // `costUsd` rides the step boundary once the backend reports it (older backends omit
              // it entirely — `undefined`, never a crash). `null` means "priced provider/estimate
              // unavailable", distinct from a real $0 turn — surfaced verbatim as message metadata
              // (merged onto `message.metadata` by the AI SDK) so a UI can render running cost
              // without polling `GET /quota`.
              if (event.costUsd !== undefined) {
                controller.enqueue({
                  type: 'message-metadata',
                  messageMetadata: { costUsd: event.costUsd },
                });
              }
              break;
            case 'text':
              ensureStep();
              if (textId === null) {
                textId = textSeq === 0 ? `txt-${stepIndex}` : `txt-${stepIndex}.${textSeq}`;
                textSeq += 1;
                controller.enqueue({ type: 'text-start', id: textId });
              }
              controller.enqueue({ type: 'text-delta', id: textId, delta: event.text });
              break;
            case 'reasoning':
              ensureStep();
              if (reasoningId === null) {
                reasoningId =
                  reasoningSeq === 0 ? `rsn-${stepIndex}` : `rsn-${stepIndex}.${reasoningSeq}`;
                reasoningSeq += 1;
                reasoningStartedAt = Date.now();
                controller.enqueue({ type: 'reasoning-start', id: reasoningId });
              }
              controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: event.text });
              break;
            case 'tool-input-start': {
              ensureStep();
              announced.add(event.id);
              // `toolKind` is absent on older backends — omitted (not `undefined`-valued) so
              // `toolMetadata` itself is only present when there's something to say, letting a
              // UI gate approval affordances on `kind === 'action'` without hardcoding tool names.
              // `parentId` nests the call under another one (see `TranscriptToolCall.children`).
              const metadata = metadataFor(event.id, event.toolKind, event.parentId);
              controller.enqueue({
                type: 'tool-input-start',
                toolCallId: event.id,
                toolName: event.name,
                ...(metadata !== undefined ? { toolMetadata: metadata } : {}),
              });
              break;
            }
            case 'tool-input-delta':
              ensureStep();
              controller.enqueue({
                type: 'tool-input-delta',
                toolCallId: event.id,
                inputTextDelta: event.delta,
              });
              break;
            case 'tool-input-available': {
              ensureStep();
              announced.add(event.id);
              const metadata = metadataFor(event.id, event.toolKind, event.parentId);
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: event.id,
                toolName: event.name,
                input: event.input,
                ...(metadata !== undefined ? { toolMetadata: metadata } : {}),
              });
              break;
            }
            case 'elicitation':
              ensureStep();
              // An authored intake asks before the turn's first model call, so nothing announced
              // the call this question set is parked under — open it here, carrying the request as
              // the part's input, which is exactly what the store persists as the call's input and
              // therefore what a reloaded thread replays. The model's own `ask` announced its call
              // itself, and re-stating it would fire a consumer's `onToolCall` twice.
              if (!announced.has(event.id)) {
                announced.add(event.id);
                controller.enqueue({
                  type: 'tool-input-available',
                  toolCallId: event.id,
                  toolName: ASK_TOOL_NAME,
                  input: {
                    ...(event.request.preamble !== undefined
                      ? { preamble: event.request.preamble }
                      : {}),
                    questions: event.request.questions,
                  },
                });
              }
              break;
            case 'tool-output':
              ensureStep();
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId: event.id,
                output: event.output,
              });
              break;
            case 'tool-output-error':
              ensureStep();
              controller.enqueue({
                type: 'tool-output-error',
                toolCallId: event.id,
                errorText: event.error,
              });
              break;
            case 'tool-output-denied':
              ensureStep();
              // The SDK's own state for "a person said no": it keeps the part's input and metadata
              // and only moves its state, so a card can say the decision was carried out instead of
              // drawing the red treatment an error gets. The reason (when one was given) rides the
              // persisted call, not this chunk — the SDK's shape carries no room for it.
              controller.enqueue({ type: 'tool-output-denied', toolCallId: event.id });
              break;
            case 'approval-requested':
              ensureStep();
              // Who decides and until when rides a `data-approval-requested` part keyed by the call
              // id — the SDK's approval chunk has no room for it, and restating the call's input
              // chunk to widen its metadata would fire a consumer's `onToolCall` a second time.
              forwardAsData(event, false);
              // The SDK settles an approval against a part it already holds and throws — dropping
              // the whole message — when there is none, so only a call this stream announced moves
              // into the native state. The approval id IS the call id: the lib settles approvals
              // by tool-call id, so a second identifier would only have to be mapped back.
              if (announced.has(event.id)) {
                controller.enqueue({
                  type: 'tool-approval-request',
                  approvalId: event.id,
                  toolCallId: event.id,
                });
              }
              break;
            case 'approval-settled':
              ensureStep();
              // Metadata about a call, like the request: the transcript folds it into that call's
              // `approval`. The call's own state moves on its output frame, not on this one.
              forwardAsData(event, false);
              break;
            case 'ui':
              ensureStep();
              // Positioned content: close the open prose so text written after the component
              // renders after it instead of growing the paragraph above it.
              closeRuns();
              controller.enqueue({
                type: 'data-ui',
                id: event.id,
                data: {
                  id: event.id,
                  component: event.component,
                  props: event.props,
                  ...(event.version !== undefined ? { version: event.version } : {}),
                  ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
                },
              });
              break;
            case 'message-metadata':
              ensureStarted();
              controller.enqueue({ type: 'message-metadata', messageMetadata: event.metadata });
              break;
            case 'title':
            case 'cancelled':
            // The thread's queue changed, or this run handed the thread to the next queued message
            // (`started`). Thread-level, like the title.
            case 'queue':
              // Thread- and run-level facts, not message content: seen by `onData`, never stored
              // as a part of the message.
              forwardAsData(event, true);
              break;
            default:
              // A kind this version does not know (a newer server, a runner that is not this
              // library's loop). Forwarded rather than dropped, so a host can render it from
              // `message.parts` / `onData` without waiting for a release that maps it.
              forwardAsData(event as { kind: string }, false);
              break;
          }
        }
        function finish() {
          ensureStarted();
          closeStep();
          controller.enqueue({ type: 'finish' });
          controller.close();
          endAttempt();
        }
        function fail(errorText: string, start = true) {
          if (start) ensureStarted();
          controller.enqueue({ type: 'error', errorText });
          controller.close();
          endAttempt();
        }
        /** The stream dropped (or ended without `done`): resume it, or report how it ended. */
        async function recover(error: unknown): Promise<boolean> {
          if (!canResume()) {
            if (error === undefined) {
              finish();
            } else {
              fail(error instanceof Error ? error.message : 'Agent stream error', false);
            }
            return false;
          }
          const outcome = await resume();
          if (outcome === 'resumed') return true;
          if (outcome === 'failed') {
            fail('Lost the connection to the agent stream');
          } else {
            // Gone: the run ended while we were away — what we have is all this stream will get,
            // and the persisted thread holds the rest. Aborted: the user stopped the turn.
            finish();
          }
          return false;
        }
        try {
          while (true) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
              result = await reader.read();
            } catch (error) {
              if (await recover(error)) continue;
              return;
            }
            if (result.done) {
              if (await recover(undefined)) continue;
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            let separator = buffer.indexOf('\n\n');
            while (separator !== -1) {
              const rawEvent = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              separator = buffer.indexOf('\n\n');
              const frame = parseSseFrame(rawEvent);
              if (frame.id !== undefined) {
                // Already taken in before a reconnect — a server that ignored `after` resends it.
                if (lastSeq !== undefined && frame.id <= lastSeq) continue;
                lastSeq = frame.id;
              }
              if (frame.event === 'done') {
                finish();
                return;
              }
              if (frame.event === 'error') {
                const failure = parseErrorFrame(frame.data);
                reportRunError(failure);
                fail(failure.message);
                return;
              }
              if (frame.event === 'meta') {
                const meta = parseMeta(frame.data);
                if (meta) record(meta);
              } else if (frame.data) {
                const event = parseEvent(frame.data);
                if (event) emit(event);
              }
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : 'Agent stream error', false);
        }
      },
      cancel() {
        cancelled = true;
        // A stop aborts the request first, which errors the body: cancelling an errored stream
        // rejects with that same AbortError, and nobody is left to hear it.
        reader.cancel().catch(() => undefined);
        endAttempt();
      },
    });
  }
}

/** The chunk stream for a send the server queued: one transient `data-queue` part, then the end. */
function queuedChunkStream(queued: QueuedSendResult): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({
        type: 'data-queue',
        data: { queue: queued.queue, queuedSend: queued },
        transient: true,
      });
      controller.close();
    },
  });
}

interface SseFrame {
  event: string | undefined;
  data: string | undefined;
  /** The frame's sequence number (SSE `id:`), when the server numbers its frames. */
  id: number | undefined;
}

/** Split one `event:`/`data:` SSE block into its fields. */
function parseSseFrame(raw: string): SseFrame {
  let event: string | undefined;
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('id:')) {
      const parsed = Number(line.slice('id:'.length).trim());
      if (Number.isSafeInteger(parsed) && parsed > 0) id = parsed;
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  return {
    event,
    data: dataLines.length > 0 ? dataLines.join('\n') : undefined,
    id,
  };
}

function parseMeta(data: string | undefined): AgentStreamMeta | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'runId' in parsed &&
      'threadId' in parsed &&
      typeof parsed.runId === 'string' &&
      typeof parsed.threadId === 'string'
    ) {
      return { runId: parsed.runId, threadId: parsed.threadId };
    }
  } catch {
    /* malformed meta frame — ignore */
  }
  return null;
}

/** Read the backend's `event: error` frame (`{code,message}`); a malformed one is a bare failure. */
function parseErrorFrame(data: string | undefined): { code: string | undefined; message: string } {
  const fallback = { code: undefined, message: 'Agent run failed' };
  if (!data) return fallback;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as { code?: unknown; message?: unknown };
      return {
        code: typeof record.code === 'string' && record.code !== '' ? record.code : undefined,
        message:
          typeof record.message === 'string' && record.message !== ''
            ? record.message
            : fallback.message,
      };
    }
  } catch {
    /* malformed error frame — fall through to the default */
  }
  return fallback;
}

/** Parse a `data:` frame as an `AgentStreamEvent`. Returns null for anything without a `kind`. */
function parseEvent(data: string): AgentStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === 'object' && 'kind' in parsed) {
      return parsed as AgentStreamEvent;
    }
  } catch {
    /* not an event frame — ignore */
  }
  return null;
}

/** Collect all text parts of a UI message into a single string. */
function extractText(message: UIMessage): string {
  let text = '';
  for (const part of message.parts ?? []) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

/** The message's file parts that name a staged upload (`providerMetadata.agent.mediaId`). */
function stagedFiles(message: UIMessage): ChatStreamFile[] {
  const files: ChatStreamFile[] = [];
  for (const part of message.parts ?? []) {
    if (part.type !== 'file') continue;
    const mediaId = (part.providerMetadata?.agent as { mediaId?: unknown } | undefined)?.mediaId;
    if (typeof mediaId !== 'string' || mediaId.length === 0) continue;
    files.push({
      mediaId,
      ...(part.mediaType ? { contentType: part.mediaType } : {}),
      ...(part.filename ? { name: part.filename } : {}),
    });
  }
  return files;
}

/** Per-request headers as the AI SDK hands them over, as a plain record (or nothing). */
function headerRecord(
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  return headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
}

/** Wait `ms`, resolving early when `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function proposalDecisionChunkStream(
  decision: NonNullable<ChatStreamResponse['proposalDecision']>,
): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'start', messageId: `decision:${crypto.randomUUID()}` });
      controller.enqueue({ type: 'data-proposal-decision', data: decision, transient: true });
      if (decision.text !== undefined && decision.text.length > 0) {
        controller.enqueue({ type: 'text-start', id: 'decision' });
        controller.enqueue({ type: 'text-delta', id: 'decision', delta: decision.text });
        controller.enqueue({ type: 'text-end', id: 'decision' });
      }
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
}
