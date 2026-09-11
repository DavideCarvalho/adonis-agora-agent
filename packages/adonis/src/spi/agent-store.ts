import type {
  Actor,
  MessageAttachment,
  MessageUsage,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallRequest,
  ToolCallStatus,
  ToolResult,
  UsagePurpose,
} from '../types.js';

export interface CreateThreadInput {
  actor: Actor;
  persona: string;
  transient?: boolean;
  title?: string;
}

export interface AppendMessageInput {
  threadId: string;
  role: StoredMessage['role'];
  content: string;
  persona?: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** Files the user attached to this message (image/PDF); persisted with it and replayed to the model. */
  attachments?: MessageAttachment[];
  followUps?: string[];
  usage?: MessageUsage;
  /** The run (turn) this message belongs to, for run-detail assembly + trace deep-links. */
  runId?: string;
}

export interface RecordToolCallInput {
  toolCallId: string;
  messageId: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  status: ToolCallStatus;
  /** The run (turn) this tool call belongs to, for run-detail assembly + trace deep-links. */
  runId?: string;
}

export interface UpdateToolCallInput {
  toolCallId: string;
  status: ToolCallStatus;
  output?: unknown;
  error?: string;
  executionMs?: number;
  executedByRef?: string;
}

export interface RecordUsageInput {
  threadId: string;
  actorRef: string;
  messageId?: string;
  modelId: string;
  purpose: UsagePurpose;
  usage: MessageUsage;
  /** Provider-reported actual USD cost for this turn, when known (gateways report it). */
  costUsd?: number;
  /** The run (turn) this usage row belongs to, for run-detail assembly + trace deep-links. */
  runId?: string;
}

/** A run's lifecycle status: created `running`, then settled once (terminal). */
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Opens a run (turn) row at start — status `running`, `started_at` stamped by the store. */
export interface RecordRunStartInput {
  runId: string;
  threadId: string;
  /** Acting identity; the store persists `actor.id` as `actor_ref` and `actor.tenantRef` as `tenant_ref`. */
  actor: Actor;
  /** The agent that handled the run; `null`/omitted for the default agent. */
  agentName?: string;
  /**
   * The run that started this one, for a delegation's child run. The parent->child edge exists in
   * the durable runtime's own journal, but only there: a governance surface reading run rows alone
   * cannot roll a delegation's cost up to the turn that asked for it.
   *
   * Optional, and a store that persists nothing for it still works — it loses the tree, not the run.
   */
  parentRunId?: string;
  /** True when the run executes as a replay-safe durable workflow, false for the inline runner. */
  durable?: boolean;
}

/**
 * Settles a run's outcome (terminal). A store MUST apply this only while the run is still `running`
 * (first terminal wins) so a late `completed` from the loop can never overwrite a `failed`/`cancelled`
 * already recorded by the runner. `error` is set only for `failed`. Token/step/cost totals are the
 * loop's run-level rollup on `completed`; a runner-recorded failure/cancel may omit them.
 */
export interface RecordRunEndInput {
  runId: string;
  status: Exclude<AgentRunStatus, 'running'>;
  /** Epoch-ms finish time; defaults to now inside the store when omitted. */
  finishedAt?: number;
  stepCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

/** Which thread, and how many of its newest messages, {@link ThreadTurnReader.loadThreadForTurn} reads. */
export interface ThreadTurnQuery {
  threadId: string;
  /** Omitted reads every message; `0` reads none. */
  messageLimit?: number;
}

/** What a turn reads off a thread — a bounded window, not the transcript. */
export interface ThreadTurnPage {
  title: string;
  /** Whether the THREAD has ever been answered, not whether {@link messages} holds an answer. */
  hasAssistantMessage: boolean;
  /** Oldest first, carrying only the fields a model turn reads. */
  messages: StoredMessage[];
}

/**
 * A store that can hand a turn the WINDOW it is about to send, instead of the thread's transcript.
 *
 * {@link AgentStore.getThread} materializes every message row, every attachment and every tool
 * output a thread ever recorded, and `load:thread` then journals what it loaded — so a long thread
 * pays for its whole history on every turn and again on every replay, to send a prompt bounded to
 * its last few messages. This read is bounded by the database (`order by created_at desc limit ?`),
 * projected to the columns a model turn actually reads.
 *
 * `hasAssistantMessage` is answered over the WHOLE thread, never the page: it answers "has this
 * conversation been answered before?" — what a `thread-start` intake asks — and a thread whose
 * window happens to hold only the user's last questions has still been answered. `null` for a thread
 * that is unknown or soft-deleted, matching `getThread`.
 *
 * Probed STRUCTURALLY rather than declared on {@link AgentStore}: it is an optimization a store
 * either offers or does not, and one that offers none still answers correctly through the full read.
 */
export interface ThreadTurnReader {
  loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null>;
}

/** ORM-agnostic persistence. Refs are string ids; adapters may add real relations. */
export interface AgentStore {
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  getThread(threadId: string): Promise<ThreadDetail | null>;
  /**
   * The owning `actor_ref` of a thread, or `null` when it is unknown (or soft-deleted). Backs the
   * per-actor ownership check on the thread routes (`threads/:id` read/delete/fork), so a caller can
   * only act on threads it owns.
   */
  getThreadActorRef(threadId: string): Promise<string | null>;
  listThreads(actorRef: string, limit?: number): Promise<ThreadSummary[]>;
  softDeleteThread(threadId: string): Promise<void>;
  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary>;
  setTitle(threadId: string, title: string): Promise<void>;
  setActiveStream(threadId: string, runId: string | null): Promise<void>;

  appendMessage(input: AppendMessageInput): Promise<StoredMessage>;
  /**
   * Attach a turn's settled tool RESULTS to a message already appended, replacing whatever it held.
   * A message's tool calls are known when it is written and their outputs are not, but a thread
   * reader pairs the two off THAT MESSAGE — so an output that only ever reaches the tool-call table
   * leaves every call on a reopened thread looking like a tool still running.
   *
   * Required rather than optional: a store that silently declines this renders a finished turn as a
   * permanently in-flight one, with nothing logged and nothing to notice. A missing method should
   * fail to compile instead.
   */
  setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void>;
  truncateFrom(threadId: string, messageId: string): Promise<void>;

  recordToolCall(input: RecordToolCallInput): Promise<void>;
  updateToolCall(input: UpdateToolCallInput): Promise<void>;

  recordUsage(input: RecordUsageInput): Promise<void>;
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }>;

  /** Open a run (turn) row at start. Replay-safe: the loop calls it under a durable step. */
  recordRunStart(input: RecordRunStartInput): Promise<void>;
  /**
   * The owning `actor_ref` of a run (turn), or `null` when the run is unknown. The loop opens the run
   * row as its FIRST step (before the quota gate), so this is populated for the whole life of a run.
   * Backs the per-actor ownership check on the run routes (stream re-attach, cancel, tool-call
   * approve/reject), so a caller can only act on runs it owns.
   */
  getRunActorRef(runId: string): Promise<string | null>;
  /** Settle a run's outcome (terminal, first-wins). A no-op when the run is unknown or already settled. */
  recordRunEnd(input: RecordRunEndInput): Promise<void>;
}
