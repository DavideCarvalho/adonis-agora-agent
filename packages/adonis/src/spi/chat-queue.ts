import type { Actor, MessageAttachment, PageContext } from '../types.js';
import { type AgentStore, clearActiveRun } from './agent-store.js';

// The SPI is `@dudousxd/nestjs-agent-core`'s `spi/chat-queue.ts`, copied (neither repo depends on the
// other). The wire it backs is its `docs/stream-protocol.md`, *Message queue*.

/**
 * Why a thread's queue stopped draining. A paused queue keeps its messages; nothing starts until
 * someone resumes it (`POST <base>/threads/:id/queue/resume`, `chat.queue.resume()`).
 *
 *  - `run_failed`     the turn before it failed — the next message would likely fail the same way,
 *                     and the person should see the error before more of their messages are spent.
 *  - `cancelled`      someone pressed Stop. Stop means stop: the queue does not start behind it.
 *                     An interrupt (`mode: 'interrupt'`) is the exception — its message starts.
 *  - `quota_exceeded` the next message's actor is over budget; resuming later retries the check.
 *  - `start_failed`   the next message could not be started (the runner refused it).
 */
export type QueuePauseReason = 'run_failed' | 'cancelled' | 'quota_exceeded' | 'start_failed';

export interface QueuePause {
  reason: QueuePauseReason;
  /** Human-facing detail (the failure, the quota window), when there is one. */
  message?: string;
  /** ISO-8601 instant the queue paused. */
  at: string;
}

/**
 * A message a person sent while a turn was still running on the thread, waiting its turn. It is not
 * part of the transcript until it starts: the loop appends it as the turn's user message, exactly as
 * if it had been sent then. Everything a send carries is captured at enqueue time, resolved and
 * checked there (agent, model, attachments), so a queued message starts with no request around it.
 */
export interface QueuedMessage {
  id: string;
  threadId: string;
  /** Who queued it. The turn it starts runs as this actor. */
  actor: Actor;
  content: string;
  attachments?: MessageAttachment[];
  agentName?: string;
  /**
   * The persona its send resolved — named, the thread's pin, or the agent's default — which the turn
   * it starts runs under. Absent on a message queued before personas were persisted: it resolves one
   * as it starts.
   */
  persona?: string;
  model?: string;
  pageContext?: PageContext;
  /**
   * Queued by an interrupt (`POST chat { mode: 'interrupt' }`): the running turn was cancelled to
   * make room for it, so the cancel starts it instead of pausing the queue.
   */
  interrupt?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A queued message as the wire shows it — {@link QueuedMessage} without the actor or thread. */
export interface QueuedMessageView {
  id: string;
  content: string;
  attachments?: MessageAttachment[];
  agentName?: string;
  persona?: string;
  model?: string;
  interrupt?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A thread's queue: its waiting messages in the order they will run, and whether it is draining.
 * What `GET <base>/threads/:id/queue` answers, what `ThreadDetail.queue` carries, and what every
 * `queue` stream frame snapshots.
 */
export interface ChatQueueState {
  items: QueuedMessageView[];
  paused: QueuePause | null;
}

export interface EnqueueMessageInput {
  threadId: string;
  actor: Actor;
  content: string;
  attachments?: MessageAttachment[];
  agentName?: string;
  persona?: string;
  model?: string;
  pageContext?: PageContext;
  interrupt?: boolean;
  /** `'tail'` (default) runs it after everything already waiting; `'head'` runs it next. */
  at?: 'tail' | 'head';
}

/** What `PATCH <base>/queue/:messageId` may change. An omitted key leaves the field as it is. */
export interface QueuedMessagePatch {
  content?: string;
  /** `null` drops every attachment. */
  attachments?: MessageAttachment[] | null;
  /**
   * Mark (or unmark) the message as an interrupt — what `POST <path>/queue/:messageId/interrupt`
   * does to a message that is already waiting, before it cancels the running turn for it.
   */
  interrupt?: boolean;
}

/**
 * A store that can hold a thread's queue of waiting messages, and admit ONE run per thread at a time.
 *
 * Probed STRUCTURALLY ({@link isChatQueueStore}), like `ThreadTurnReader`: a store that predates it
 * keeps the old behaviour (a send on a busy thread starts a second, concurrent run). All members or
 * none — a queue without the admission primitives cannot be drained safely across processes.
 *
 * Admission is the thread's active run (`activeRunId` on a thread read), compare-and-set:
 *  - {@link claimActiveStream} sets it to `runId` only when it is free, already `runId` (a retried
 *    claim is idempotent), or held by `replacing` (a handoff from the run that is settling, or a
 *    takeover from a holder the runner reports dead). Exactly one of two racing claims wins.
 *  - {@link releaseActiveStream} clears it only when `runId` still holds it — so a run that settles
 *    after it handed the thread to the next one cannot clear the next one's claim.
 */
export interface ChatQueueStore {
  enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage>;
  /** The thread's waiting messages, in run order (the head first). */
  listQueue(threadId: string): Promise<QueuedMessage[]>;
  getQueuedMessage(id: string): Promise<QueuedMessage | null>;
  /** `null` when there is no such message (it started, or was removed). */
  updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null>;
  /** Move a message to `index` (clamped) in its thread's run order. `false` when it is gone. */
  moveQueuedMessage(id: string, index: number): Promise<boolean>;
  /**
   * Remove a message. `false` when it was already gone — which is also how a drain learns that the
   * head it was about to start was deleted under it, so it must be a real conditional delete.
   */
  removeQueuedMessage(id: string): Promise<boolean>;
  /** Remove every waiting message on the thread; answers how many there were. */
  clearQueue(threadId: string): Promise<number>;
  queuePause(threadId: string): Promise<QueuePause | null>;
  setQueuePause(threadId: string, pause: QueuePause | null): Promise<void>;
  /** The run currently holding the thread, or `null`. */
  activeRunForThread(threadId: string): Promise<string | null>;
  claimActiveStream(
    threadId: string,
    runId: string,
    options?: { replacing?: string },
  ): Promise<boolean>;
  releaseActiveStream(threadId: string, runId: string): Promise<boolean>;
}

const CHAT_QUEUE_METHODS = [
  'enqueueMessage',
  'listQueue',
  'getQueuedMessage',
  'updateQueuedMessage',
  'moveQueuedMessage',
  'removeQueuedMessage',
  'clearQueue',
  'queuePause',
  'setQueuePause',
  'activeRunForThread',
  'claimActiveStream',
  'releaseActiveStream',
] as const satisfies readonly (keyof ChatQueueStore)[];

/** Whether `store` implements every {@link ChatQueueStore} member. */
export function isChatQueueStore(store: AgentStore): store is AgentStore & ChatQueueStore {
  const candidate = store as unknown as Record<string, unknown>;
  return CHAT_QUEUE_METHODS.every((method) => typeof candidate[method] === 'function');
}

/**
 * Release the thread `runId` was streaming — conditionally when the store can compare, so a run
 * that already handed the thread to the next queued turn does not clear that turn's claim; the old
 * unconditional clear on a store that cannot.
 */
export async function releaseThreadRun(
  store: AgentStore,
  threadId: string,
  runId: string,
): Promise<void> {
  if (isChatQueueStore(store)) {
    await store.releaseActiveStream(threadId, runId);
    return;
  }
  await clearActiveRun(store, threadId, runId);
}

/** The wire view of a queued message. */
export function queuedMessageView(message: QueuedMessage): QueuedMessageView {
  return {
    id: message.id,
    content: message.content,
    ...(message.attachments !== undefined && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
    ...(message.agentName !== undefined ? { agentName: message.agentName } : {}),
    ...(message.persona !== undefined ? { persona: message.persona } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
    ...(message.interrupt === true ? { interrupt: true } : {}),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}
