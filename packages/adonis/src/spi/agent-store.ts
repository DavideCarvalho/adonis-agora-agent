import type { ToolCallOutcome } from '../dangling-tool-calls.js';
import type { AgentUiComponent } from '../stream-events.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type {
  Actor,
  MessageAttachment,
  MessageFeedback,
  MessageUsage,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallRequest,
  ToolCallStatus,
  ToolResult,
  UsagePurpose,
} from '../types.js';
import type { ActionProposalOutcome } from './action-proposal-outcome-store.js';
import type { ToolCallApprovalState } from './approval-policy.js';

export interface CreateThreadInput {
  actor: Actor;
  /**
   * The persona pinned on the thread from its first turn — the one that send named. Omitted (or
   * empty) → none pinned. See {@link ThreadSummary.persona}.
   */
  persona?: string;
  /** A scratch thread: left out of `listThreads` until {@link AgentStore.promoteThread} keeps it. */
  transient?: boolean;
  title?: string;
  /**
   * Create the thread under THIS id instead of a generated one — for a caller whose protocol names
   * the conversation itself (AG-UI's `threadId`). OPTIONAL to honour: a store that ignores it still
   * creates a thread, under an id of its own, and the caller reads the id off the result. A store
   * that honours it rejects an id already taken (soft-deleted threads included).
   */
  id?: string;
}

/** Patch applied by {@link AgentStore.updateThread}. An omitted key leaves that field untouched. */
export interface UpdateThreadInput {
  title?: string;
  /** `null` unpins the thread's model (turns run on the provider default). */
  model?: string | null;
  /** The agent a send that names none runs as; `null` → the configured default agent. */
  defaultAgent?: string | null;
  /** The persona a send that names none runs under; `null` clears it (the agent's default applies). */
  persona?: string | null;
}

export interface AppendMessageInput {
  actionProposalOutcome?: ActionProposalOutcome;
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
  /** The agent that wrote it, when it is not the thread's own turn. See {@link StoredMessage.agentName}. */
  agentName?: string;
  /** The step's streamed thinking. See {@link StoredMessage.reasoning}. */
  reasoning?: string;
  /** Time spent thinking in this step, in ms. See {@link StoredMessage.reasoningMs}. */
  reasoningMs?: number;
  /** Components pushed during this step. See {@link StoredMessage.ui}. */
  ui?: AgentUiComponent[];
}

export interface RecordToolCallInput {
  proposalId?: string;
  confirmation?: ToolConfirmation;
  toolCallId: string;
  messageId: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  status: ToolCallStatus;
  /** The run (turn) this tool call belongs to, for run-detail assembly + trace deep-links. */
  runId?: string;
  /**
   * Who has to approve this call (`'requester'` or a role), from the turn's `ApprovalPolicy`. Set on
   * an action call that was put to a person — or approved by a remembered decision — and never
   * otherwise; persisted as `null` when absent.
   */
  approver?: string;
  /** ISO-8601 instant the approval request lapses. Absent → it never does. */
  expiresAt?: string;
}

export interface UpdateToolCallInput {
  toolCallId: string;
  status: ToolCallStatus;
  output?: unknown;
  error?: string;
  executionMs?: number;
  executedByRef?: string;
  /** The approval asked for later calls of this tool in this thread to run without asking. */
  remember?: boolean;
  /** The surface the decision came through. See {@link import('../types.js').Decision.decidedVia}. */
  decidedVia?: string;
}

export interface RecordUsageInput {
  threadId: string;
  actorRef: string;
  messageId?: string;
  modelId: string;
  purpose: UsagePurpose;
  usage: MessageUsage;
  /**
   * The turn's USD cost, when known: reported by the provider (a gateway), or estimated by the loop
   * from the pricing table. {@link costSource} says which. Absent → unpriced (`cost_usd` NULL).
   */
  costUsd?: number;
  /**
   * Where {@link costUsd} came from: `'provider'` (the provider reported it; the real figure) or
   * `'estimate'` (tokens × the price row in effect for the turn, frozen at write time). Absent with a
   * `costUsd` → treat as `'provider'` (rows written before the column existed only held reported cost).
   */
  costSource?: CostSource;
  /** The run (turn) this usage row belongs to, for run-detail assembly + trace deep-links. */
  runId?: string;
}

/** Where a usage row's `cost_usd` came from. See {@link RecordUsageInput.costSource}. */
export type CostSource = 'provider' | 'estimate';

/**
 * An actor's spend over a window. `costUsd` sums every row's `cost_usd`, provider-reported AND
 * estimated; `estimatedCostUsd` is the estimated share of it (`0` when none), so a reader that wants
 * reported cost only takes `costUsd - estimatedCostUsd`. A store written before estimates were
 * persisted may omit it (read as `0`).
 */
export interface UsageTotals {
  usedTokens: number;
  costUsd: number;
  estimatedCostUsd?: number;
}

/** {@link UsageTotals} over usage rows: the one summing rule every store shares. */
export function sumUsage(
  rows: readonly {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number | null;
    costSource?: string | null;
  }[],
): UsageTotals {
  let usedTokens = 0;
  let costUsd = 0;
  let estimatedCostUsd = 0;
  for (const row of rows) {
    usedTokens += row.inputTokens + row.outputTokens;
    const cost = row.costUsd === null || row.costUsd === undefined ? 0 : Number(row.costUsd);
    costUsd += cost;
    if (row.costSource === 'estimate') estimatedCostUsd += cost;
  }
  return { usedTokens, costUsd, estimatedCostUsd };
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
  /**
   * OPTIONAL: patch a thread's settings. Needed to pin a model on a thread (`PATCH <path>/threads/:id
   * { model }` answers `501` without it); a title alone still goes through {@link setTitle}.
   */
  updateThread?(threadId: string, patch: UpdateThreadInput): Promise<void>;
  /**
   * OPTIONAL: the thread's own default agent (`UpdateThreadInput.defaultAgent`), or `null` when it
   * has none or does not exist. Read on every send that names no agent, so it is one scalar rather
   * than {@link getThread}'s whole transcript; a store without it is read through `getThread`.
   */
  defaultAgentForThread?(threadId: string): Promise<string | null>;
  /**
   * OPTIONAL: the thread's pinned persona (`UpdateThreadInput.persona`), or `null` when it has none
   * or does not exist — one scalar, like {@link defaultAgentForThread}, read on a send that names no
   * persona to an agent that has some. A store without it is read through `getThread`.
   */
  personaForThread?(threadId: string): Promise<string | null>;
  /**
   * OPTIONAL: make a transient thread a regular one, listed by `listThreads` from then on. A thread
   * that is not transient is left as it is. Absent → `POST <path>/threads/:id/promote` answers `501`.
   */
  promoteThread?(threadId: string): Promise<void>;
  setActiveStream(threadId: string, runId: string | null): Promise<void>;
  /**
   * OPTIONAL: clear the thread's active run only if it is still `runId` — so a turn that ends after
   * a newer one started on the same thread does not blank the newer one's pointer. Absent →
   * `setActiveStream(threadId, null)`.
   */
  clearActiveStream?(threadId: string, runId: string): Promise<void>;

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
  /**
   * OPTIONAL: replace the components persisted on a message (`StoredMessage.ui`) — what the step's
   * tools pushed through `ctx.emitUi`, merged after what the model turn streamed. Written once the
   * step's tools settle, from values its checkpoints hold, so a replay writes the same list. Absent →
   * tool-pushed components stream live but are not persisted.
   */
  setMessageUi?(messageId: string, ui: AgentUiComponent[]): Promise<void>;
  truncateFrom(threadId: string, messageId: string): Promise<void>;
  /**
   * OPTIONAL: of `mediaIds`, the ones a message that still exists in one of `actorRef`'s threads
   * carries as an attachment — each id at most once, in the order asked.
   *
   * DERIVED, not tracked: {@link truncateFrom} deletes messages (which is what regenerating a turn
   * does), so a reference can disappear, and a flag set at send time would never be unset. Scoped
   * to one actor, like every read on this surface: a reference only ANOTHER actor's thread holds is
   * reported as none, so this can never probe someone else's conversation.
   *
   * What lets `attachmentStores.media()` serve a file a message in the actor's own thread already
   * carries (a fork, a regenerate) even when the actor did not upload it. Absent → only the
   * uploader (and `canAccess`) may use a file.
   */
  referencedMediaIds?(actorRef: string, mediaIds: readonly string[]): Promise<string[]>;
  /**
   * OPTIONAL: the thread a message belongs to, or `null` when there is no such message. The
   * authorization seam for message-scoped routes (feedback): the route resolves the thread's owner
   * from it. Implement it together with {@link setMessageFeedback}.
   */
  threadOfMessage?(messageId: string): Promise<string | null>;
  /**
   * OPTIONAL: set (or, with `null`, clear) the rating on a message — see
   * {@link import('../types.js').StoredMessage.feedback}. Absent → `POST <path>/messages/:id/feedback`
   * answers `501`.
   */
  setMessageFeedback?(messageId: string, feedback: MessageFeedback | null): Promise<void>;

  recordToolCall(input: RecordToolCallInput): Promise<void>;
  updateToolCall(input: UpdateToolCallInput): Promise<void>;
  /**
   * The run a tool call belongs to, or `null` when the call is unknown. Lets the approve / reject /
   * answer / skip routes accept a body naming the call alone (`{ toolCallId }`), which is what the
   * shared React client sends. Optional: without it those routes still take an explicit `runId`.
   */
  getToolCallRunId?(toolCallId: string): Promise<string | null>;
  /**
   * What is recorded about each of these calls — its status, and the output or error it settled
   * with. Read when a thread's history holds a tool call its message has no result for (the turn
   * died mid-step), so the next turn can be told what actually happened instead of being handed a
   * call answered by nothing. Unknown ids are left out. Absent → such a call is put to the model as
   * never completed.
   */
  toolCallOutcomes?(toolCallIds: string[]): Promise<ToolCallOutcome[]>;
  /**
   * Settle every call of `runId` still awaiting a decision as `failed` with `error`, and answer how
   * many there were. Called when the run ends without settling them — it failed, or it was found
   * dead — so an approval card never waits on a run that will not come back. Calls already settled
   * are left alone.
   */
  failUnsettledToolCalls?(runId: string, error: string): Promise<number>;
  /**
   * OPTIONAL: the names of the tools whose approval someone asked to REMEMBER in this thread — an
   * approved call persisted with `remember: true`. The loop approves a later call of one of them
   * without asking, inside that call's own `persist:toolcall` checkpoint. Absent → nothing is ever
   * remembered, and every call asks.
   */
  rememberedApprovals?(threadId: string): Promise<string[]>;
  /**
   * OPTIONAL: a call's approval state, or `null` when the call is unknown. Read by the approve/reject
   * routes to enforce the recorded approver and refuse a decision on a request that already
   * expired. Absent → every call is treated as the requester's, with no expiry (the old behaviour).
   */
  toolCallApproval?(toolCallId: string): Promise<ToolCallApprovalState | null>;
  /**
   * OPTIONAL: the input a call was recorded with, or `null` when the call is unknown. Read by the
   * answer route to check a reply against the questions it answers (a typed question's rules, a
   * `required` one left empty) before it is signalled. Absent → answers are checked for shape only,
   * and the loop drops what it cannot settle.
   */
  toolCallInput?(toolCallId: string): Promise<unknown>;

  recordUsage(input: RecordUsageInput): Promise<void>;
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }>;
  /**
   * OPTIONAL: the actor's usage over the UTC days `fromDay`..`toDay` (`YYYY-MM-DD`, inclusive) —
   * tokens and recorded spend, provider-reported and estimated (see {@link UsageTotals}). Feeds the
   * month window (and the day window's spend) of `GET <path>/quota`; absent → the month window is left
   * out and spend reads `0`.
   */
  usageBetween?(actorRef: string, fromDay: string, toDay: string): Promise<UsageTotals>;

  /** Open a run (turn) row at start. Replay-safe: the loop calls it under a durable step. */
  recordRunStart(input: RecordRunStartInput): Promise<void>;
  /**
   * The owning `actor_ref` of a run (turn), or `null` when the run is unknown. The loop opens the run
   * row as its FIRST step (before the quota gate), so this is populated for the whole life of a run.
   * Backs the per-actor ownership check on the run routes (stream re-attach, cancel, tool-call
   * approve/reject), so a caller can only act on runs it owns.
   */
  getRunActorRef(runId: string): Promise<string | null>;
  /**
   * OPTIONAL: the thread whose active run is `runId`, or `null` — the reverse of the admission
   * pointer (`activeRunId` on a thread read).
   *
   * A run is admitted to its thread BEFORE it starts executing: a send claims the thread and then
   * starts the run; a queue drain claims it for the next message and then starts that. Under a
   * durable runner the body runs in a worker, so there is a window — the time a worker takes to
   * pick the run up — in which the run holds a thread and has no run row yet. A client attaches in
   * exactly that window (it was just told the run started), so the routes that address a run read
   * its owner off the thread it holds when there is no row. Absent → those routes answer `404`
   * until the run has started.
   */
  threadHeldByRun?(runId: string): Promise<string | null>;
  /** Settle a run's outcome (terminal, first-wins). A no-op when the run is unknown or already settled. */
  recordRunEnd(input: RecordRunEndInput): Promise<void>;
}

/** Clear `threadId`'s active run if it is still `runId` (see {@link AgentStore.clearActiveStream}). */
export async function clearActiveRun(
  store: AgentStore,
  threadId: string,
  runId: string,
): Promise<void> {
  if (store.clearActiveStream !== undefined) {
    await store.clearActiveStream(threadId, runId);
    return;
  }
  await store.setActiveStream(threadId, null);
}
