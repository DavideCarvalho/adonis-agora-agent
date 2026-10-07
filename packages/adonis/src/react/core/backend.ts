import type {
  ActionProposal,
  ActionProposalMutationResult,
  AgentCatalogEntry,
  AgentClientConfig,
  ChatQueueState,
  MessageAttachment,
  MessageFeedback,
  MessageFeedbackValue,
  ModelCatalogView,
  QuotaReport,
  SkillCatalogEntry,
  ThreadDetail,
  ThreadSummary,
  ToolCatalogEntry,
} from '../../index.js';
import type { HttpErrorListener } from './http-error.js';

/**
 * Partial update accepted by `PATCH <base>/threads/:threadId`. `defaultAgent: null` clears a
 * previously-set default back to the module's own default; omitting it leaves the thread's
 * current default untouched.
 */
export interface ThreadPatch {
  title?: string;
  defaultAgent?: string | null;
  /** Pin a catalog model on the thread; `null` unpins it. */
  model?: string | null;
  /** Pin one of the agent's personas on the thread; `null` clears it (the agent's default applies). */
  persona?: string | null;
}

/** Starting a turn: the body `POST <base>/chat` takes (see docs/stream-protocol.md). */
export interface ChatStreamRequest {
  /** `{ message, threadId?, agent?, persona?, model?, attachments?, pageContext?, regenerate?, … }`. */
  body: Record<string, unknown>;
  /** Per-request headers the AI SDK was handed for this send. */
  headers?: Record<string, string>;
  /** Aborted when the user stops the turn. */
  signal?: AbortSignal;
  /**
   * What the message's staged uploads are, as it shows them: the body's `attachments` refs carry
   * only ids. For a backend that describes a file on its own wire (AG-UI's media parts).
   */
  files?: ChatStreamFile[];
}

/** One staged upload of the message being sent. */
export interface ChatStreamFile {
  mediaId: string;
  contentType?: string;
  name?: string;
}

/** Attaching to a run that is already streaming: `GET <base>/chat/:runId/stream?after=<seq>`. */
export interface ResumeStreamRequest {
  runId: string;
  /**
   * The sequence number (SSE `id:`) of the last frame the client already has. Omitted → replay
   * from the first frame. A backend that cannot skip may ignore it: the transport also drops frames
   * at or below it.
   */
  after?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * An open chat stream: the raw `text/event-stream` bytes in the stream-protocol framing, plus the
 * identity a backend may learn before the first frame (the `X-Agent-Run-Id` / `X-Agent-Thread-Id`
 * headers). The body's own `event: meta` frame supplies them otherwise.
 */
export interface ChatStreamResponse {
  proposalDecision?: {
    threadId: string;
    proposalDecision: ActionProposalMutationResult | { status: 'ambiguous'; proposalIds: string[] };
    text?: string;
  };
  body: ReadableStream<Uint8Array>;
  runId?: string;
  threadId?: string;
  /**
   * The server queued the message instead of starting a turn (`202`): the thread already had one
   * running — another tab, another device. `body` is then empty; the transport reports this as a
   * transient `data-queue` part and `useAgentChat` moves the message into `chat.queue`.
   */
  queued?: QueuedSendResult;
}

/**
 * `POST <base>/chat` answered `202`: the message waits in the thread's queue (see
 * docs/stream-protocol.md, "Message queue").
 */
export interface QueuedSendResult {
  queued: true;
  threadId: string;
  /** The queued message's id — also the id of the run it will start. */
  messageId: string;
  /** 0-based place in the queue when it was queued. */
  position: number;
  queue: ChatQueueState;
  /** Set when it started straight away (the thread was idle after all): attach to this run. */
  runId?: string;
  /** The run an interrupt cancelled to make room for it. */
  interrupting?: string;
}

/** What `PATCH <base>/queue/:messageId` takes. */
export interface QueuedMessageUpdate {
  message?: string;
  /** `[{ mediaId }]` refs replacing the message's attachments; `null` drops them. */
  attachments?: Array<{ mediaId: string }> | null;
  /** Move it to this 0-based place in the queue. */
  position?: number;
}

/** What `POST <base>/messages/:id/feedback` takes. `value: null` clears the rating. */
export interface MessageFeedbackInput {
  value: MessageFeedbackValue | null;
  comment?: string;
}

export interface UploadAttachmentOptions {
  signal?: AbortSignal;
  /** Called with 0..1 as the upload progresses, when the backend can observe it. */
  onProgress?: (fraction: number) => void;
}

/** How {@link AgentClient} reaches the server — handed to an {@link AttachmentUploadStrategy}. */
export interface AgentConnection {
  /** The server's origin, trailing slash removed (`''` for same-origin). */
  baseUrl: string;
  /** The agent's route prefix, normalized to a leading slash (`'/agent'`), or `''`. */
  path: string;
  /** The client's static + per-request headers, resolved now (auth, CSRF). */
  headers: () => Promise<Record<string, string>>;
  credentials?: RequestCredentials;
  fetch: typeof fetch;
  /** The client's `onHttpError` — call it with an upload's error answer before throwing it. */
  onHttpError?: HttpErrorListener;
}

/**
 * Replaces {@link AgentClient}'s own `uploadAttachment` (`POST <path>/attachments`) — e.g.
 * `mediaAttachments()` from `@adonis-agora/agent/react/media`, or your own storage. Gets the
 * client's connection so it needs no configuration of its own. Resolve with the attachment your
 * server's `AGENT_ATTACHMENT_STAGING` recognises by `mediaId`.
 */
export type AttachmentUploadStrategy = (
  file: File,
  options: UploadAttachmentOptions,
  connection: AgentConnection,
) => Promise<MessageAttachment>;

/**
 * Everything the React layer asks of a server — the seam between `useAgentChat` (and the other
 * hooks) and whatever serves the agent. {@link AgentClient} is the default implementation, over the
 * library's own REST routes with `fetch`. An app with its own client — a generated one, a different
 * auth scheme (cookie session + CSRF header), a backend that is not this library at all but speaks
 * docs/stream-protocol.md — implements this instead and passes it as `<AgentProvider backend>` (or
 * per hook, `useAgentChat({ backend })`).
 *
 * The streaming, thread and cancel members are required: without them there is no chat. The rest
 * are optional; a hook that needs one the backend does not have throws
 * {@link AgentBackendUnsupportedError} when it is called, so a backend only implements what its
 * server supports.
 */
export interface AgentBackend {
  /** Start a turn and return its SSE stream. Throw on a non-2xx answer. */
  openChatStream(request: ChatStreamRequest): Promise<ChatStreamResponse>;
  /** Attach to a streaming run. Resolve `null` when nothing is streaming under that id (HTTP 404). */
  resumeChatStream(request: ResumeStreamRequest): Promise<ChatStreamResponse | null>;
  /** Hard-stop a run server-side. */
  cancelStream(runId: string): Promise<unknown>;

  listThreads(): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail>;
  updateThread(id: string, patch: ThreadPatch): Promise<unknown>;
  deleteThread(id: string): Promise<unknown>;

  /**
   * Queue a message on a thread (`POST <base>/chat` with `mode: 'queue'` or `'interrupt'`), which
   * the server answers with `202` JSON rather than a stream. What `chat.queue` sends through; a
   * backend without it keeps the composer blocked while a turn runs.
   */
  enqueueMessage?(request: ChatStreamRequest): Promise<QueuedSendResult>;
  /** `GET <base>/threads/:id/queue`. */
  getQueue?(threadId: string): Promise<ChatQueueState>;
  /** `PATCH <base>/queue/:messageId` — edit and/or move a waiting message. */
  updateQueuedMessage?(messageId: string, update: QueuedMessageUpdate): Promise<ChatQueueState>;
  /** `DELETE <base>/queue/:messageId`. */
  removeQueuedMessage?(messageId: string): Promise<ChatQueueState>;
  /**
   * `POST <base>/queue/:messageId/interrupt` — run a waiting message now: it moves to the head as an
   * interrupt and the running turn is cancelled for it. `interrupting` is the run that was
   * cancelled; `runId` is set instead when nothing was running and the message started at once.
   * What `chat.queue.interrupt(id)` calls.
   */
  interruptQueuedMessage?(
    messageId: string,
  ): Promise<ChatQueueState & { runId?: string; interrupting?: string }>;
  /** `DELETE <base>/threads/:id/queue`. */
  clearQueue?(threadId: string): Promise<ChatQueueState>;
  /** `POST <base>/threads/:id/queue/resume` — `runId` when the head started. */
  resumeQueue?(threadId: string): Promise<ChatQueueState & { runId?: string }>;

  forkFromMessage?(threadId: string, messageId: string): Promise<ThreadSummary>;
  promoteThread?(id: string): Promise<unknown>;
  truncateFromMessage?(threadId: string, messageId: string): Promise<unknown>;

  listActionProposals?(input: { threadId: string }): Promise<ActionProposal[]>;
  approveActionProposal?(input: {
    threadId: string;
    proposalId: string;
    remember?: boolean;
  }): Promise<ActionProposalMutationResult>;
  rejectActionProposal?(input: {
    threadId: string;
    proposalId: string;
    reason?: string;
  }): Promise<ActionProposalMutationResult>;

  approveToolCall?(input: {
    toolCallId: string;
    remember?: boolean;
    via?: string;
  }): Promise<unknown>;
  rejectToolCall?(input: { toolCallId: string; reason?: string; via?: string }): Promise<unknown>;
  answerToolCall?(input: {
    toolCallId: string;
    answers?: Record<string, string[]>;
    via?: string;
  }): Promise<unknown>;
  skipToolCall?(input: { toolCallId: string; via?: string }): Promise<unknown>;

  uploadAttachment?(file: File, options?: UploadAttachmentOptions): Promise<MessageAttachment>;
  listTools?(agent?: string): Promise<ToolCatalogEntry[]>;
  listSkills?(threadId?: string): Promise<SkillCatalogEntry[]>;
  /** `GET <base>/quota` — every budget window, and which one blocks sends, if any. */
  getQuota?(): Promise<QuotaReport>;
  /** `GET <base>/models?agent=` — what a model picker offers. */
  listModels?(agent?: string): Promise<ModelCatalogView>;
  /** `GET <base>/agents` — what an agent picker offers. */
  listAgents?(): Promise<AgentCatalogEntry[]>;
  /** `GET <base>/config` — attachment limits and upload mode, and which features are on. */
  getConfig?(): Promise<AgentClientConfig>;
  setMessageFeedback?(
    messageId: string,
    input: MessageFeedbackInput,
  ): Promise<{ feedback: MessageFeedback | null }>;
}

/** An optional {@link AgentBackend} member the bound backend does not implement was called. */
export class AgentBackendUnsupportedError extends Error {
  constructor(readonly method: string) {
    super(`The agent backend does not implement ${method}()`);
    this.name = 'AgentBackendUnsupportedError';
  }
}

type OptionalMethod = {
  [K in keyof AgentBackend]-?: undefined extends AgentBackend[K] ? K : never;
}[keyof AgentBackend];

/**
 * The optional backend method `name`, bound — or a throw naming it. For hook code that has to call
 * something a backend may not offer.
 */
export function requireBackendMethod<K extends OptionalMethod>(
  backend: AgentBackend,
  name: K,
): NonNullable<AgentBackend[K]> {
  const method = backend[name];
  if (typeof method !== 'function') {
    throw new AgentBackendUnsupportedError(name);
  }
  return (method as (...args: never[]) => unknown).bind(backend) as NonNullable<AgentBackend[K]>;
}
