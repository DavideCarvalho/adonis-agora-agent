import type {
  ActionProposal,
  ActionProposalMutationResult,
  AgentCatalogEntry,
  AgentClientConfig,
  ChatQueueState,
  MessageAttachment,
  MessageFeedback,
  ModelCatalogView,
  QuotaReport,
  SkillCatalogEntry,
  ThreadDetail,
  ThreadSummary,
  ToolCatalogEntry,
} from '../../index.js';
import type {
  AgentBackend,
  AgentConnection,
  AttachmentUploadStrategy,
  ChatStreamRequest,
  ChatStreamResponse,
  MessageFeedbackInput,
  QueuedMessageUpdate,
  QueuedSendResult,
  ResumeStreamRequest,
  ThreadPatch,
  UploadAttachmentOptions,
} from './backend.js';

import {
  type AgentRequestError,
  type ErrorAnswer,
  type HttpErrorListener,
  readErrorAnswer,
  readErrorResponse,
  reportHttpError,
} from './http-error.js';

export type { ThreadPatch } from './backend.js';
export type { AgentRequestError, HttpErrorListener } from './http-error.js';

/**
 * Thrown by {@link AgentClient} on a non-2xx response. Carries the HTTP `status` so callers can
 * branch (e.g. 403 → "not your thread", 429 → quota) instead of string-matching a generic Error,
 * and what the server said: `message` is the body's `message` when it sent one (so a hook that
 * shows `error.message` shows the server's words), `code` its machine-readable `code`, and `body`
 * the whole answer, parsed when it is JSON.
 */
export class AgentHttpError extends Error implements AgentRequestError {
  /** The answer's body: parsed JSON, else its text; `undefined` when empty. */
  readonly body: unknown;
  /** The body's `code` (`quota_exceeded`, …), when the server sent one. */
  readonly code: string | undefined;

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    statusText: string,
    answer: ErrorAnswer = { body: undefined, message: undefined, code: undefined },
  ) {
    super(answer.message ?? `Agent request failed: ${method} ${path} → ${status} ${statusText}`);
    this.name = 'AgentHttpError';
    this.body = answer.body;
    this.code = answer.code;
  }

  /** Read a refused `response`'s body into an error. */
  static async from(response: Response, method: string, path: string): Promise<AgentHttpError> {
    return new AgentHttpError(
      response.status,
      method,
      path,
      response.statusText,
      await readErrorResponse(response),
    );
  }
}

export interface CancelResult {
  aborted: boolean;
}

export interface OkResult {
  ok: boolean;
}

export interface AgentClientOptions {
  /**
   * The server's origin, e.g. `https://api.example.com`. Defaults to `''` (same origin). The
   * agent's route prefix is {@link AgentClientOptions.path}, not part of this.
   */
  baseUrl?: string;
  /**
   * The agent's route prefix — `AgentModule`'s `path`, with any global prefix in front
   * (`'api/agent'`). Leading/trailing slashes are optional. Defaults to `'agent'`.
   */
  path?: string;
  /** Static headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Resolved per request — for short-lived bearer tokens, or a CSRF header read from a cookie
   * (`{ 'X-XSRF-TOKEN': readCookie('XSRF-TOKEN') }`), which has to be read at request time because
   * the server may rotate it.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Forwarded to fetch so cookie auth works. Same-origin requests send cookies by default; set
   * `'include'` when the API lives on another origin (and have it answer with credentialed CORS).
   */
  credentials?: RequestCredentials;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
  /**
   * Called with every error answer (an {@link AgentHttpError}, or a `MediaUploadError` from a
   * `mediaAttachments()` upload) right before it is thrown — the place for app-wide reactions such
   * as "401 → sign in again". The error still reaches the caller. Not called for the `404` a
   * resume answers when nothing is streaming, which is an answer, not a failure.
   */
  onHttpError?: HttpErrorListener;
  /** Attachment uploads. */
  attachments?: {
    /**
     * How `uploadAttachment` uploads. Omitted → `POST <path>/attachments` (multipart). Pass
     * `mediaAttachments()` from `@adonis-agora/agent/react/media` for resumable uploads through
     * @adonis-agora/media, or your own {@link AttachmentUploadStrategy}.
     */
    upload?: AttachmentUploadStrategy;
  };
}

/** `'/api/agent'` from `'api/agent'`, `'/api/agent/'`, …; `''` for an empty path. */
export function normalizeAgentPath(path: string | undefined): string {
  const trimmed = (path ?? 'agent').replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

const HEADER_RUN_ID = 'x-agent-run-id';
const HEADER_THREAD_ID = 'x-agent-thread-id';

/**
 * Framework-agnostic REST client for the Adonis agent endpoints — the default {@link AgentBackend}.
 * Used by `useAgentChat`, but standalone-usable (vanilla fetch, no React).
 */
export class AgentClient implements AgentBackend {
  constructor(private readonly options: AgentClientOptions = {}) {}

  /** `POST <path>/chat` → the turn's SSE stream. Throws {@link AgentHttpError} on a non-2xx. */
  async openChatStream(request: ChatStreamRequest): Promise<ChatStreamResponse> {
    const response = await this.fetchImpl()(`${this.root()}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(await this.resolveHeaders()),
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      ...this.credentials(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (response.status === 202) {
      // Queued behind a turn already running on the thread: JSON, not a stream.
      return { body: emptyStream(), queued: (await response.json()) as QueuedSendResult };
    }
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const decision = (await response.json()) as NonNullable<
        ChatStreamResponse['proposalDecision']
      >;
      if (decision.proposalDecision !== undefined && typeof decision.threadId === 'string')
        return { body: emptyStream(), threadId: decision.threadId, proposalDecision: decision };
      throw new Error('Unexpected JSON chat response');
    }
    if (!response.ok || !response.body) {
      throw await this.failure(response, 'POST', `${this.agentPath()}/chat`);
    }
    return streamResponse(response);
  }

  /**
   * `POST <path>/chat` for a message that should wait in the thread's queue — the body carries
   * `mode: 'queue'` (or `'interrupt'`), which the server always answers with `202` JSON.
   */
  enqueueMessage(request: ChatStreamRequest): Promise<QueuedSendResult> {
    return this.request<QueuedSendResult>('POST', '/chat', {
      mode: 'queue',
      ...request.body,
    });
  }

  /** `GET <path>/threads/:id/queue` — the thread's waiting messages, and whether it drains. */
  getQueue(threadId: string): Promise<ChatQueueState> {
    return this.request<ChatQueueState>('GET', `/threads/${encodeURIComponent(threadId)}/queue`);
  }

  /** `PATCH <path>/queue/:messageId` — change a waiting message's text/attachments, or move it. */
  updateQueuedMessage(messageId: string, update: QueuedMessageUpdate): Promise<ChatQueueState> {
    return this.request<ChatQueueState>('PATCH', `/queue/${encodeURIComponent(messageId)}`, update);
  }

  /** `DELETE <path>/queue/:messageId`. */
  removeQueuedMessage(messageId: string): Promise<ChatQueueState> {
    return this.request<ChatQueueState>('DELETE', `/queue/${encodeURIComponent(messageId)}`);
  }

  /**
   * `POST <path>/queue/:messageId/interrupt` — run a waiting message now, cancelling the running
   * turn for it. `runId` when nothing was running and it started; else `interrupting`.
   */
  interruptQueuedMessage(
    messageId: string,
  ): Promise<ChatQueueState & { runId?: string; interrupting?: string }> {
    return this.request<ChatQueueState & { runId?: string; interrupting?: string }>(
      'POST',
      `/queue/${encodeURIComponent(messageId)}/interrupt`,
    );
  }

  /** `DELETE <path>/threads/:id/queue` — drop every waiting message. */
  clearQueue(threadId: string): Promise<ChatQueueState> {
    return this.request<ChatQueueState>('DELETE', `/threads/${encodeURIComponent(threadId)}/queue`);
  }

  /** `POST <path>/threads/:id/queue/resume` — lift a pause; `runId` when the head started. */
  resumeQueue(threadId: string): Promise<ChatQueueState & { runId?: string }> {
    return this.request<ChatQueueState & { runId?: string }>(
      'POST',
      `/threads/${encodeURIComponent(threadId)}/queue/resume`,
    );
  }

  /**
   * `GET <path>/chat/:runId/stream[?after=<seq>]` → the run's SSE stream, or `null` when nothing is
   * streaming under that id (404).
   */
  async resumeChatStream(request: ResumeStreamRequest): Promise<ChatStreamResponse | null> {
    const path = `/chat/${encodeURIComponent(request.runId)}/stream`;
    const query = request.after !== undefined && request.after > 0 ? `?after=${request.after}` : '';
    const response = await this.fetchImpl()(`${this.root()}${path}${query}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(await this.resolveHeaders()),
        ...request.headers,
      },
      ...this.credentials(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok || !response.body) {
      throw await this.failure(response, 'GET', `${this.agentPath()}${path}`);
    }
    return streamResponse(response);
  }

  /**
   * Rate a message (`'up'`/`'down'`, optional comment) or clear its rating (`value: null`). Answers
   * the stored rating.
   */
  setMessageFeedback(
    messageId: string,
    input: MessageFeedbackInput,
  ): Promise<{ feedback: MessageFeedback | null }> {
    return this.request<{ feedback: MessageFeedback | null }>(
      'POST',
      `/messages/${encodeURIComponent(messageId)}/feedback`,
      input,
    );
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.request<ThreadSummary[]>('GET', '/threads');
  }

  /**
   * The skills this caller can invoke right now, scope-resolved — the same list, built by the same
   * call, that the model is offered, so what a user can type after a `/` and what the agent can
   * reach cannot drift apart. `threadId` reaches the host's own resolver, which may scope a skill to
   * one conversation; omitted, the server reads it as a brand-new thread.
   */
  listSkills(threadId?: string): Promise<SkillCatalogEntry[]> {
    const query = threadId === undefined ? '' : `?threadId=${encodeURIComponent(threadId)}`;
    return this.request<SkillCatalogEntry[]>('GET', `/skills${query}`);
  }

  /**
   * The tools this caller can reach through `agent` (the default agent when omitted), each with the
   * server-declared `presentation` a chat narrates it by — the same list the model is offered.
   * Prefer {@link useToolCatalog}, which fetches it once and shares it.
   */
  listTools(agent?: string): Promise<ToolCatalogEntry[]> {
    const query = agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`;
    return this.request<ToolCatalogEntry[]>('GET', `/tools${query}`);
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.request<ThreadDetail>('GET', `/threads/${encodeURIComponent(id)}`);
  }

  deleteThread(id: string): Promise<void> {
    return this.request<void>('DELETE', `/threads/${encodeURIComponent(id)}`);
  }

  forkFromMessage(threadId: string, messageId: string): Promise<ThreadSummary> {
    return this.request<ThreadSummary>(
      'POST',
      `/threads/${encodeURIComponent(threadId)}/fork-from/${encodeURIComponent(messageId)}`,
    );
  }

  /** General `PATCH <path>/threads/:threadId` — title and/or the thread's pinned default agent. */
  updateThread(id: string, patch: ThreadPatch): Promise<OkResult> {
    return this.request<OkResult>('PATCH', `/threads/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Uploads a file (image/PDF) for a vision-capable model turn. Multipart, field name `file` —
   * mirrors the backend's `POST <path>/attachments`. The returned {@link MessageAttachment} is
   * what a caller then rides on `sendMessage({ text }, { body: { attachments: [...] } })`.
   */
  async uploadAttachment(
    file: File,
    options: UploadAttachmentOptions = {},
  ): Promise<MessageAttachment> {
    const upload = this.options.attachments?.upload;
    if (upload !== undefined) {
      return upload(file, options, this.connection());
    }
    // `fetch` cannot observe an upload's progress; XHR can. Only when someone is listening, and
    // never when a `fetch` was injected (tests, non-browser runtimes).
    if (
      options.onProgress !== undefined &&
      this.options.fetch === undefined &&
      typeof XMLHttpRequest !== 'undefined'
    ) {
      return this.uploadWithProgress(file, options);
    }
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.fetchImpl()(`${this.root()}/attachments`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(await this.resolveHeaders()),
      },
      body: formData,
      ...this.credentials(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const attachment = await this.handleResponse<MessageAttachment>(
      response,
      'POST',
      `${this.agentPath()}/attachments`,
    );
    options.onProgress?.(1);
    return attachment;
  }

  private async uploadWithProgress(
    file: File,
    { signal, onProgress }: UploadAttachmentOptions,
  ): Promise<MessageAttachment> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(await this.resolveHeaders()),
    };
    const url = `${this.root()}/attachments`;
    return new Promise<MessageAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      // Same-origin requests carry cookies regardless; this is the cross-origin opt-in.
      xhr.withCredentials = this.options.credentials === 'include';
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new AgentHttpError(
            xhr.status,
            'POST',
            `${this.agentPath()}/attachments`,
            xhr.statusText,
            readErrorAnswer(xhr.responseText),
          );
          reportHttpError(this.options.onHttpError, error);
          reject(error);
          return;
        }
        onProgress?.(1);
        resolve(JSON.parse(xhr.responseText) as MessageAttachment);
      };
      xhr.onerror = () => reject(new TypeError('Network error while uploading the attachment'));
      xhr.onabort = () => reject(new DOMException('The upload was aborted', 'AbortError'));
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new DOMException('The upload was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });
  }

  promoteThread(id: string): Promise<OkResult> {
    return this.request<OkResult>('POST', `/threads/${encodeURIComponent(id)}/promote`);
  }

  truncateFromMessage(threadId: string, messageId: string): Promise<OkResult> {
    return this.request<OkResult>(
      'DELETE',
      `/threads/${encodeURIComponent(threadId)}/from/${encodeURIComponent(messageId)}`,
    );
  }

  /** `GET <path>/models?agent=` — the models this caller may pick, grouped by provider. */
  listModels(agent?: string): Promise<ModelCatalogView> {
    const query = agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`;
    return this.request<ModelCatalogView>('GET', `/models${query}`);
  }

  /** `GET <path>/agents` — the registered agents, the default one flagged. */
  listAgents(): Promise<AgentCatalogEntry[]> {
    return this.request<AgentCatalogEntry[]>('GET', '/agents');
  }

  /** `GET <path>/config` — attachment limits and upload mode, and which features are on. */
  getConfig(): Promise<AgentClientConfig> {
    return this.request<AgentClientConfig>('GET', '/config');
  }

  /** `GET <path>/quota` — the caller's budget windows and the one blocking sends, if any. */
  getQuota(): Promise<QuotaReport> {
    return this.request<QuotaReport>('GET', '/quota');
  }

  cancelStream(runId: string): Promise<CancelResult> {
    return this.request<CancelResult>('POST', `/chat/${encodeURIComponent(runId)}/cancel`);
  }

  /**
   * `remember` approves later calls of the same tool in the same thread; `via` names the surface
   * the decision came through (the server records `'web'` when omitted).
   */
  async listActionProposals({ threadId }: { threadId: string }): Promise<ActionProposal[]> {
    const proposals = new Map<string, ActionProposal>();
    let after: { createdAt: number; id: string } | undefined;
    for (;;) {
      const route = `/threads/${encodeURIComponent(threadId)}/action-proposals${
        after === undefined ? '' : `?after=${encodeURIComponent(JSON.stringify(after))}`
      }`;
      const response = await this.requestResponse('GET', route);
      const page = await this.handleResponse<unknown>(
        response,
        'GET',
        `${this.agentPath()}${route}`,
      );
      if (!Array.isArray(page)) throw new TypeError('Invalid action proposal page');
      for (const proposal of page) proposals.set(proposal.id, proposal);
      const header = response.headers.get('X-Action-Proposals-Next');
      if (header === null) return [...proposals.values()];
      let next: unknown;
      try {
        next = JSON.parse(decodeURIComponent(header));
      } catch {
        throw new TypeError('Invalid action proposal cursor');
      }
      if (
        typeof next !== 'object' ||
        next === null ||
        !('createdAt' in next) ||
        typeof next.createdAt !== 'number' ||
        !Number.isSafeInteger(next.createdAt) ||
        !('id' in next) ||
        typeof next.id !== 'string' ||
        next.id.length === 0 ||
        next.id.length > 255 ||
        (after !== undefined &&
          (next.createdAt < after.createdAt ||
            (next.createdAt === after.createdAt && next.id <= after.id)))
      )
        throw new TypeError('Invalid or non-advancing action proposal cursor');
      after = { createdAt: next.createdAt, id: next.id };
    }
  }
  approveActionProposal({
    threadId,
    proposalId,
    remember,
  }: {
    threadId: string;
    proposalId: string;
    remember?: boolean;
  }): Promise<ActionProposalMutationResult> {
    return this.request(
      'POST',
      `/threads/${encodeURIComponent(threadId)}/action-proposals/${encodeURIComponent(proposalId)}/approve`,
      remember === undefined ? {} : { remember },
    );
  }
  rejectActionProposal({
    threadId,
    proposalId,
    reason,
  }: {
    threadId: string;
    proposalId: string;
    reason?: string;
  }): Promise<ActionProposalMutationResult> {
    return this.request(
      'POST',
      `/threads/${encodeURIComponent(threadId)}/action-proposals/${encodeURIComponent(proposalId)}/reject`,
      reason === undefined ? {} : { reason },
    );
  }

  approveToolCall(input: { toolCallId: string; remember?: boolean; via?: string }): Promise<void> {
    return this.request<void>('POST', '/tool-call/approve', input);
  }

  rejectToolCall(input: { toolCallId: string; reason?: string; via?: string }): Promise<void> {
    return this.request<void>('POST', '/tool-call/reject', input);
  }

  /**
   * Settle a parked question set. `answers` is questionId → chosen option values; a question left
   * out takes the pre-picked default the request carried, resolved server-side against the request
   * the run already holds. Omit the whole object and the user has confirmed every pre-picked
   * answer — which is the point of the surface, so it is a valid submission rather than a blank.
   * `via` names the surface the answer came through (the server records `'web'` when omitted).
   */
  answerToolCall(input: {
    toolCallId: string;
    answers?: Record<string, string[]>;
    via?: string;
  }): Promise<void> {
    return this.request<void>('POST', '/tool-call/answer', input);
  }

  /**
   * Decline to answer and let the agent proceed on its own pre-picked values. Lands on the same
   * values a confirmation would, and persists differently on purpose — only one of them is
   * evidence the user chose them.
   */
  skipToolCall(input: { toolCallId: string; via?: string }): Promise<void> {
    return this.request<void>('POST', '/tool-call/skip', input);
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  /** This client's connection, for an {@link AttachmentUploadStrategy}. */
  private connection(): AgentConnection {
    return {
      baseUrl: this.baseUrl(),
      path: this.agentPath(),
      headers: () => this.resolveHeaders(),
      fetch: this.fetchImpl(),
      ...this.credentials(),
      ...(this.options.onHttpError !== undefined ? { onHttpError: this.options.onHttpError } : {}),
    };
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? '').replace(/\/+$/, '');
  }

  private agentPath(): string {
    return normalizeAgentPath(this.options.path);
  }

  /** Origin + agent path: what every route hangs off. */
  private root(): string {
    return `${this.baseUrl()}${this.agentPath()}`;
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    const dynamic = (await this.options.getHeaders?.()) ?? {};
    return { ...this.options.headers, ...dynamic };
  }

  private credentials(): { credentials?: RequestCredentials } {
    return this.options.credentials !== undefined ? { credentials: this.options.credentials } : {};
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await this.requestResponse(method, route, body);
    return this.handleResponse<T>(response, method, `${this.agentPath()}${route}`);
  }

  private async requestResponse(method: string, route: string, body?: unknown): Promise<Response> {
    const path = `${this.agentPath()}${route}`;
    const response = await this.fetchImpl()(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(await this.resolveHeaders()),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...this.credentials(),
    });
    return response;
  }

  /** The error for a refused `response`, already reported to `onHttpError`. */
  private async failure(response: Response, method: string, path: string): Promise<AgentHttpError> {
    const error = await AgentHttpError.from(response, method, path);
    reportHttpError(this.options.onHttpError, error);
    return error;
  }

  private async handleResponse<T>(response: Response, method: string, path: string): Promise<T> {
    if (!response.ok) {
      throw await this.failure(response, method, path);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function streamResponse(response: Response): ChatStreamResponse {
  const body = response.body as ReadableStream<Uint8Array>;
  const runId = response.headers?.get(HEADER_RUN_ID) ?? undefined;
  const threadId = response.headers?.get(HEADER_THREAD_ID) ?? undefined;
  return {
    body,
    ...(runId ? { runId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
