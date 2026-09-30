import { type ChatFrame, type ChatPart, decodeFrame, foldPart, readSseStream } from './sse.js';

/**
 * Body of `POST /agent/chat` (shape accepted by the provider → `AgentService.chat`). `message` is
 * required; everything else is optional context. `pageContext` reaches the tools' ctx (not the model
 * prompt) and is rebuilt from each turn's input, so send it on every message, not just the first.
 */
export interface AgentChatRequestBody {
  message: string;
  threadId?: string;
  agent?: string;
  persona?: string;
  pageContext?: { kind?: string; [key: string]: unknown };
  /** Uploads named by id alone (`POST <base>/attachments` answered them). */
  attachments?: unknown[];
  /** Run THIS turn on a catalog model (`GET <base>/models`). Never pins it on the thread. */
  model?: string;
  /**
   * Answer the thread's last user message again (needs `threadId`; `message` is ignored): the
   * server drops the old answer and streams a new one under a new run.
   */
  regenerate?: true;
}

/** Options for {@link createAgentChatClient}. */
export interface AgentChatClientOptions {
  /**
   * Base path the provider mounted its routes under (`POST {basePath}/chat`,
   * `GET {basePath}/chat/:runId/stream`). Defaults to `/agent`.
   */
  basePath?: string;
  /** `fetch` implementation to use. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Extra headers merged into every request — e.g. an anti-CSRF token (`{ 'X-XSRF-TOKEN': ... }`).
   * Called per request so a rotating token is always read fresh.
   */
  getHeaders?: () => Record<string, string>;
  /** Reconnection policy for a dropped stream, or `false` to disable and fail on the first drop. */
  resume?: AgentChatResumeOptions | false;
}

/** Reconnection policy: how many times to re-attach, and the backoff before each attempt. */
export interface AgentChatResumeOptions {
  /** Max consecutive re-attach attempts before giving up. Defaults to 6. */
  maxAttempts?: number;
  /** Backoff before attempt `n` (1-based), in ms. Defaults to `min(400 * n, 3000)`. */
  backoffMs?: (attempt: number) => number;
}

/** Callbacks fired while a stream is consumed. All optional. */
export interface AgentChatHandlers {
  /** The assistant message's parts so far, rebuilt on every frame (safe to render directly). */
  onParts?: (parts: ChatPart[]) => void;
  /** Each decoded renderable/control frame, in wire order. */
  onFrame?: (frame: ChatFrame) => void;
  /** The run id, as soon as it is known (response header, then the `meta` frame). */
  onRunId?: (runId: string) => void;
  /** The thread id, as soon as it is known. */
  onThreadId?: (threadId: string) => void;
}

/** Arguments to {@link AgentChatClient.send}. */
export interface AgentChatSendOptions extends AgentChatHandlers {
  body: AgentChatRequestBody;
  signal?: AbortSignal;
}

/** The settled result of a completed chat turn. */
export interface AgentChatResult {
  runId?: string;
  threadId?: string;
  parts: ChatPart[];
}

/**
 * Thrown when a run's stream dropped and could not be resumed within the retry budget. Carries the
 * partial parts received so far (and the ids) so a consumer can keep what streamed and surface a
 * "couldn't finish, try again" state instead of losing the message.
 */
export class AgentChatDisconnectedError extends Error {
  readonly runId: string | undefined;
  readonly threadId: string | undefined;
  readonly parts: ChatPart[];
  constructor(runId: string | undefined, threadId: string | undefined, parts: ChatPart[]) {
    super('The agent stream dropped and could not be resumed.');
    this.name = 'AgentChatDisconnectedError';
    this.runId = runId;
    this.threadId = threadId;
    this.parts = parts;
  }
}

/**
 * The server refused the request before any stream started — a non-2xx answer. `message` is the
 * server's own words (`{ message, code? }`, the body every refusal answers), `code` its
 * machine-readable reason (`quota_exceeded`, `model_not_allowed`, `thread_required`, …) and `body`
 * the parsed answer, or `undefined` when it was not JSON.
 */
export class AgentChatHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, message: string, code: string | undefined, body: unknown) {
    super(message);
    this.name = 'AgentChatHttpError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Read a refused response into an {@link AgentChatHttpError}, keeping the server's words. */
async function httpError(response: Response): Promise<AgentChatHttpError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    message?: unknown;
    code?: unknown;
  };
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : `Failed to start agent chat (HTTP ${response.status}).`;
  return new AgentChatHttpError(
    response.status,
    message,
    typeof record.code === 'string' ? record.code : undefined,
    body,
  );
}

/**
 * The server ended the run with `event: error` (agent protocol). Not a dropped connection: the run
 * is over, so it is surfaced rather than re-attached. `code` is the server's (`quota_exceeded`,
 * `output_rejected`, `structured_output_invalid`, `run_failed`).
 */
export class AgentChatStreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentChatStreamError';
    this.code = code;
  }
}

const DEFAULT_MAX_ATTEMPTS = 6;

function defaultBackoff(attempt: number): number {
  return Math.min(400 * attempt, 3000);
}

/** An `AbortError`-shaped error without depending on `DOMException` (kept Node/browser portable). */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/**
 * A framework-agnostic client for the agent chat SSE endpoints. `send` posts a turn and streams the
 * reply; if the connection drops before the run finishes, it re-attaches to
 * `GET {basePath}/chat/:runId/stream` — which replays the whole stream from the start and follows live
 * — with backoff, until the run emits `done` or the retry budget is exhausted. The run itself is
 * durable and keeps executing server-side across the drop, so no tokens are lost.
 */
export interface AgentChatClient {
  send(options: AgentChatSendOptions): Promise<AgentChatResult>;
  /** Re-attach to an already-started run (e.g. after a fresh page load) and stream it to completion. */
  resume(
    runId: string,
    options?: AgentChatHandlers & { signal?: AbortSignal },
  ): Promise<AgentChatResult>;
}

export function createAgentChatClient(options: AgentChatClientOptions = {}): AgentChatClient {
  const basePath = (options.basePath ?? '/agent').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resumeCfg = options.resume;
  const maxAttempts = resumeCfg === false ? 0 : (resumeCfg?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoff = (resumeCfg === false ? undefined : resumeCfg?.backoffMs) ?? defaultBackoff;

  function headers(base: Record<string, string>): Record<string, string> {
    return { ...base, ...(options.getHeaders?.() ?? {}) };
  }

  /**
   * Drains one SSE stream, folding renderable frames into a fresh parts array (a re-attach replays
   * from the start, so rebuilding from `[]` yields the complete message without duplicating). Returns
   * whether the stream ended with `done` (the run finished) vs. was cut short.
   */
  async function consume(
    body: ReadableStream<Uint8Array>,
    sink: { onParts: (parts: ChatPart[]) => void; handlers: AgentChatHandlers },
  ): Promise<boolean> {
    let parts: ChatPart[] = [];
    for await (const event of readSseStream(body)) {
      const frame = decodeFrame(event);
      if (!frame) {
        continue;
      }
      sink.handlers.onFrame?.(frame);
      if (frame.type === 'done') {
        return true;
      }
      if (frame.type === 'error') {
        throw new AgentChatStreamError(frame.code, frame.message);
      }
      if (frame.type === 'meta') {
        if (frame.runId) {
          sink.handlers.onRunId?.(frame.runId);
        }
        if (frame.threadId) {
          sink.handlers.onThreadId?.(frame.threadId);
        }
        continue;
      }
      parts = foldPart(parts, frame);
      sink.onParts(parts);
    }
    return false;
  }

  /**
   * Runs the re-attach loop from a known `runId` until the run emits `done` or the retry budget is
   * exhausted. Shared by `send` (after the POST drops) and `resume` (from a cold start).
   */
  async function reattach(
    runId: string,
    signal: AbortSignal | undefined,
    sink: { onParts: (parts: ChatPart[]) => void; handlers: AgentChatHandlers },
  ): Promise<boolean> {
    let attempt = 0;
    let sawDone = false;
    while (!sawDone && !signal?.aborted && attempt < maxAttempts) {
      attempt += 1;
      await delay(backoff(attempt), signal);
      try {
        const response = await fetchImpl(`${basePath}/chat/${runId}/stream`, {
          method: 'GET',
          credentials: 'include',
          ...(signal ? { signal } : {}),
          headers: headers({ Accept: 'text/event-stream' }),
        });
        if (!response.ok || !response.body) {
          continue;
        }
        attempt = 0; // Reconnected: reset the budget; only the next drop counts again.
        sawDone = await consume(response.body, sink);
      } catch (error) {
        if (signal?.aborted || error instanceof AgentChatStreamError) {
          throw error;
        }
        // Dropped again — loop retries until the budget is spent.
      }
    }
    return sawDone;
  }

  async function send(sendOptions: AgentChatSendOptions): Promise<AgentChatResult> {
    const { body, signal } = sendOptions;
    let runId: string | undefined;
    let threadId: string | undefined;
    let lastParts: ChatPart[] = [];

    const handlers: AgentChatHandlers = {
      ...sendOptions,
      onRunId: (id) => {
        runId = id;
        sendOptions.onRunId?.(id);
      },
      onThreadId: (id) => {
        threadId = id;
        sendOptions.onThreadId?.(id);
      },
    };
    const onParts = (parts: ChatPart[]) => {
      lastParts = parts;
      sendOptions.onParts?.(parts);
    };
    const sink = { onParts, handlers };

    const response = await fetchImpl(`${basePath}/chat`, {
      method: 'POST',
      credentials: 'include',
      ...(signal ? { signal } : {}),
      headers: headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await httpError(response);
    }
    if (!response.body) {
      throw new Error(`Failed to start agent chat (HTTP ${response.status}): no response body.`);
    }
    // The provider sets these before any byte; capture the runId now so a mid-stream drop (before the
    // `meta` frame) can still re-attach.
    const headerRunId = response.headers.get('X-Agent-Run-Id');
    if (headerRunId) {
      runId = headerRunId;
      sendOptions.onRunId?.(headerRunId);
    }
    const headerThreadId = response.headers.get('X-Agent-Thread-Id');
    if (headerThreadId) {
      threadId = headerThreadId;
      sendOptions.onThreadId?.(headerThreadId);
    }

    let sawDone: boolean;
    try {
      sawDone = await consume(response.body, sink);
    } catch (error) {
      if (signal?.aborted || error instanceof AgentChatStreamError) {
        throw error;
      }
      sawDone = false; // Fall through to the re-attach loop instead of surfacing the drop as an error.
    }

    if (!sawDone && runId) {
      sawDone = await reattach(runId, signal, sink);
    }
    if (!sawDone) {
      throw new AgentChatDisconnectedError(runId, threadId, lastParts);
    }
    return {
      parts: lastParts,
      ...(runId !== undefined ? { runId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
    };
  }

  async function resume(
    runId: string,
    resumeOptions: AgentChatHandlers & { signal?: AbortSignal } = {},
  ): Promise<AgentChatResult> {
    let threadId: string | undefined;
    let lastParts: ChatPart[] = [];
    const handlers: AgentChatHandlers = {
      ...resumeOptions,
      onThreadId: (id) => {
        threadId = id;
        resumeOptions.onThreadId?.(id);
      },
    };
    const onParts = (parts: ChatPart[]) => {
      lastParts = parts;
      resumeOptions.onParts?.(parts);
    };
    const sawDone = await reattach(runId, resumeOptions.signal, { onParts, handlers });
    if (!sawDone) {
      throw new AgentChatDisconnectedError(runId, threadId, lastParts);
    }
    return {
      runId,
      parts: lastParts,
      ...(threadId !== undefined ? { threadId } : {}),
    };
  }

  return { send, resume };
}
