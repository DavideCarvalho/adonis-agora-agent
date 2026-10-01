import type { ToolCallOutcome } from '../dangling-tool-calls.js';
import type {
  AgentRunStatus,
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  MessageFeedback,
  RecordRunEndInput,
  RecordRunStartInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallApproval,
  ToolCallStatus,
  ToolResult,
  UpdateThreadInput,
  UpdateToolCallInput,
} from '../index.js';
import { type ToolCallApprovalState, toolCallApprovalFromRow } from '../spi/approval-policy.js';
import type {
  ChatQueueStore,
  EnqueueMessageInput,
  QueuedMessage,
  QueuedMessagePatch,
  QueuePause,
} from '../spi/chat-queue.js';
import type { AgentUiComponent } from '../stream-events.js';
import type { ToolConfirmation } from '../tool-presentation.js';

interface ThreadRow extends ThreadSummary {
  actorRef: string;
  activeStreamId?: string;
  messages: StoredMessage[];
}

interface ToolCallRow {
  toolCallId: string;
  messageId: string;
  threadId: string;
  runId?: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  output?: unknown;
  status: ToolCallStatus;
  error?: string;
  executionMs?: number;
  createdAt: string;
  executedByRef?: string;
  confirmation?: ToolConfirmation;
  approver?: string;
  expiresAt?: string;
  remember?: boolean;
  decidedVia?: string;
}

interface UsageRow {
  actorRef: string;
  threadId: string;
  runId?: string;
  modelId: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  day: string;
  createdAt: string;
}

interface RunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  tenantRef?: string;
  agentName?: string;
  /** The run that delegated this one; unset for a turn a person started. */
  parentRunId?: string;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  error?: string;
  durable: boolean;
}

/** A recorded usage row exposed to the governance read-model (input/output split + thread/day). */
export interface GovernanceUsageRow {
  actorRef: string;
  threadId: string;
  runId?: string;
  modelId: string;
  purpose?: string;
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` written to the prompt cache this turn; undefined when not reported. */
  cacheWriteTokens?: number;
  /** Subset of `inputTokens` served from the prompt cache this turn; undefined when not reported. */
  cacheReadTokens?: number;
  /** Provider-reported actual cost for the turn, when known; undefined → estimate from pricing. */
  costUsd?: number;
  day: string;
  createdAt: string;
}

/** A recorded tool call exposed to the governance read-model (thread resolved, with timestamp). */
export interface GovernanceToolCallRow {
  toolCallId: string;
  toolName: string;
  toolType: 'read' | 'action';
  status: ToolCallStatus;
  threadId: string;
  runId?: string;
  input: unknown;
  output?: unknown;
  error?: string;
  executionMs?: number;
  createdAt: string;
}

/** A recorded run exposed to the governance read-model (full lifecycle + rollups). */
export interface GovernanceRunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  tenantRef?: string;
  agentName?: string;
  /** The run that delegated this one; unset for a turn a person started. */
  parentRunId?: string;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  error?: string;
  durable: boolean;
}

/** A recorded message exposed to the governance read-model (for run-detail assembly). */
export interface GovernanceMessageRow {
  id: string;
  threadId: string;
  runId?: string;
  role: string;
  content: string;
  createdAt: string;
}

/** Thread metadata exposed to the governance read-model (title/actor/count/last activity). */
export interface GovernanceThreadRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  updatedAt: string;
}

/** A fully in-memory `AgentStore` for tests and the offline demo. */
export class InMemoryAgentStore implements AgentStore, ChatQueueStore {
  private readonly threads = new Map<string, ThreadRow>();
  /** Each thread's waiting messages, in run order. */
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly pauses = new Map<string, QueuePause>();
  private readonly toolCalls = new Map<string, ToolCallRow>();
  private readonly usage: UsageRow[] = [];
  private readonly runs = new Map<string, RunRow>();

  private now(): string {
    return new Date().toISOString();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const id = input.id ?? crypto.randomUUID();
    if (this.threads.has(id)) {
      throw new Error(`thread ${id} already exists`);
    }
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      persona: input.persona !== undefined && input.persona.length > 0 ? input.persona : null,
      transient: input.transient ?? false,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
    };
    this.threads.set(id, row);
    return this.toSummary(row);
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return null;
    }
    return {
      ...this.toSummary(row),
      messages: row.messages.map((message) => this.withApprovals(message)),
    };
  }

  async getThreadActorRef(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.actorRef ?? null;
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    return [...this.threads.values()]
      .filter((row) => row.actorRef === actorRef && !row.transient)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((row) => this.toSummary(row));
  }

  async promoteThread(threadId: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row?.transient === true) {
      row.transient = false;
      row.updatedAt = this.now();
    }
  }

  async softDeleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    const source = this.threads.get(threadId);
    if (source === undefined) {
      throw new Error(`thread ${threadId} not found`);
    }
    const cutoff = source.messages.findIndex((message) => message.id === fromMessageId);
    const kept = cutoff >= 0 ? source.messages.slice(0, cutoff + 1) : [...source.messages];
    const id = crypto.randomUUID();
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: source.actorRef,
      title: source.title,
      persona: source.persona,
      transient: false,
      createdAt: ts,
      updatedAt: ts,
      // Feedback rates a message in ITS thread; a fork starts unrated.
      messages: kept.map(({ feedback: _feedback, ...message }) => ({ ...message })),
      ...(source.model != null ? { model: source.model } : {}),
      ...(source.defaultAgent != null ? { defaultAgent: source.defaultAgent } : {}),
    };
    this.threads.set(id, row);
    return this.toSummary(row);
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      row.title = title;
      row.updatedAt = this.now();
    }
  }

  async updateThread(threadId: string, patch: UpdateThreadInput): Promise<void> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return;
    }
    if (patch.title !== undefined) {
      row.title = patch.title;
    }
    if (patch.model !== undefined) {
      row.model = patch.model;
    }
    if (patch.defaultAgent !== undefined) {
      row.defaultAgent = patch.defaultAgent;
    }
    if (patch.persona !== undefined) {
      row.persona = patch.persona;
    }
    row.updatedAt = this.now();
  }

  async defaultAgentForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.defaultAgent ?? null;
  }

  async personaForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.persona ?? null;
  }

  async clearActiveStream(threadId: string, runId: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined && row.activeStreamId === runId) {
      delete row.activeStreamId;
    }
  }

  async activeRunForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.activeStreamId ?? null;
  }

  async threadHeldByRun(runId: string): Promise<string | null> {
    for (const [threadId, row] of this.threads) {
      if (row.activeStreamId === runId) {
        return threadId;
      }
    }
    return null;
  }

  async claimActiveStream(
    threadId: string,
    runId: string,
    options: { replacing?: string } = {},
  ): Promise<boolean> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return false;
    }
    const holder = row.activeStreamId;
    if (holder !== undefined && holder !== runId && holder !== options.replacing) {
      return false;
    }
    row.activeStreamId = runId;
    return true;
  }

  async releaseActiveStream(threadId: string, runId: string): Promise<boolean> {
    const row = this.threads.get(threadId);
    if (row?.activeStreamId !== runId) {
      return false;
    }
    delete row.activeStreamId;
    return true;
  }

  async enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage> {
    const ts = this.now();
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      actor: input.actor,
      content: input.content,
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.interrupt === true ? { interrupt: true } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    const queue = this.queues.get(input.threadId) ?? [];
    if (input.at === 'head') {
      queue.unshift(message);
    } else {
      queue.push(message);
    }
    this.queues.set(input.threadId, queue);
    return { ...message };
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    return (this.queues.get(threadId) ?? []).map((message) => ({ ...message }));
  }

  async getQueuedMessage(id: string): Promise<QueuedMessage | null> {
    const found = this.findQueued(id);
    return found === undefined ? null : { ...found.message };
  }

  async updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return null;
    }
    const { message } = found;
    if (patch.content !== undefined) {
      message.content = patch.content;
    }
    if (patch.attachments !== undefined) {
      if (patch.attachments === null || patch.attachments.length === 0) {
        delete message.attachments;
      } else {
        message.attachments = patch.attachments;
      }
    }
    if (patch.interrupt === true) {
      message.interrupt = true;
    } else if (patch.interrupt === false) {
      delete message.interrupt;
    }
    message.updatedAt = this.now();
    return { ...message };
  }

  async moveQueuedMessage(id: string, index: number): Promise<boolean> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return false;
    }
    const { queue, position, message } = found;
    queue.splice(position, 1);
    const target = Math.max(0, Math.min(queue.length, Math.trunc(index)));
    queue.splice(target, 0, message);
    return true;
  }

  async removeQueuedMessage(id: string): Promise<boolean> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return false;
    }
    found.queue.splice(found.position, 1);
    return true;
  }

  async clearQueue(threadId: string): Promise<number> {
    const count = this.queues.get(threadId)?.length ?? 0;
    this.queues.delete(threadId);
    return count;
  }

  async queuePause(threadId: string): Promise<QueuePause | null> {
    return this.pauses.get(threadId) ?? null;
  }

  async setQueuePause(threadId: string, pause: QueuePause | null): Promise<void> {
    if (pause === null) {
      this.pauses.delete(threadId);
    } else {
      this.pauses.set(threadId, pause);
    }
  }

  private findQueued(
    id: string,
  ): { queue: QueuedMessage[]; position: number; message: QueuedMessage } | undefined {
    for (const queue of this.queues.values()) {
      const position = queue.findIndex((message) => message.id === id);
      const message = queue[position];
      if (message !== undefined) {
        return { queue, position, message };
      }
    }
    return undefined;
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      if (runId === null) {
        delete row.activeStreamId;
      } else {
        row.activeStreamId = runId;
      }
    }
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    const row = this.threads.get(input.threadId);
    if (row === undefined) {
      throw new Error(`thread ${input.threadId} not found`);
    }
    const message: StoredMessage = {
      id: crypto.randomUUID(),
      role: input.role,
      content: input.content,
      createdAt: this.now(),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolResults !== undefined ? { toolResults: input.toolResults } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.reasoningMs !== undefined ? { reasoningMs: input.reasoningMs } : {}),
      ...(input.ui !== undefined ? { ui: input.ui } : {}),
    };
    row.messages.push(message);
    row.updatedAt = message.createdAt;
    return message;
  }

  async setMessageUi(messageId: string, ui: AgentUiComponent[]): Promise<void> {
    for (const row of this.threads.values()) {
      const index = row.messages.findIndex((candidate) => candidate.id === messageId);
      const message = row.messages[index];
      if (message !== undefined) {
        row.messages[index] = { ...message, ui };
        return;
      }
    }
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    for (const row of this.threads.values()) {
      const message = row.messages.find((candidate) => candidate.id === messageId);
      if (message !== undefined) {
        message.toolResults = results;
        return;
      }
    }
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return;
    }
    const cutoff = row.messages.findIndex((message) => message.id === messageId);
    if (cutoff >= 0) {
      row.messages = row.messages.slice(0, cutoff);
    }
  }

  /**
   * Of `mediaIds`, the ones a surviving (or queued) message in one of this actor's threads still
   * carries. Re-derived from the messages each call, so a media whose message was truncated away reads as
   * unreferenced again.
   */
  async referencedMediaIds(actorRef: string, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const thread of this.threads.values()) {
      if (thread.actorRef !== actorRef) {
        continue;
      }
      // A message waiting in the thread's queue carries its attachments too: it has been sent, it
      // just has not run yet — collecting its media would fail the turn it is waiting to start.
      const queued = this.queues.get(thread.id) ?? [];
      for (const message of [...thread.messages, ...queued]) {
        for (const attachment of message.attachments ?? []) {
          if (wanted.has(attachment.mediaId)) {
            found.add(attachment.mediaId);
          }
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async threadOfMessage(messageId: string): Promise<string | null> {
    return this.threadIdForMessage(messageId) ?? null;
  }

  async setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<void> {
    for (const row of this.threads.values()) {
      const index = row.messages.findIndex((candidate) => candidate.id === messageId);
      const message = row.messages[index];
      if (message !== undefined) {
        const { feedback: _previous, ...rest } = message;
        row.messages[index] = feedback !== null ? { ...rest, feedback } : rest;
        return;
      }
    }
  }

  async toolCallInput(toolCallId: string): Promise<unknown> {
    return this.toolCalls.get(toolCallId)?.input ?? null;
  }

  async getToolCallRunId(toolCallId: string): Promise<string | null> {
    return this.toolCalls.get(toolCallId)?.runId ?? null;
  }

  async toolCallOutcomes(toolCallIds: string[]): Promise<ToolCallOutcome[]> {
    const outcomes: ToolCallOutcome[] = [];
    for (const id of toolCallIds) {
      const row = this.toolCalls.get(id);
      if (row !== undefined) {
        outcomes.push({
          id,
          status: row.status,
          ...(row.output !== undefined ? { output: row.output } : {}),
          ...(row.error !== undefined ? { error: row.error } : {}),
        });
      }
    }
    return outcomes;
  }

  async failUnsettledToolCalls(runId: string, error: string): Promise<number> {
    let settled = 0;
    for (const row of this.toolCalls.values()) {
      if (row.runId === runId && row.status === 'pending_approval') {
        row.status = 'failed';
        row.error = error;
        settled += 1;
      }
    }
    return settled;
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    this.toolCalls.set(input.toolCallId, {
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      threadId: this.threadIdForMessage(input.messageId) ?? '',
      toolName: input.toolName,
      toolType: input.toolType,
      input: input.input,
      status: input.status,
      createdAt: this.now(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.confirmation !== undefined ? { confirmation: { ...input.confirmation } } : {}),
      ...(input.approver !== undefined ? { approver: input.approver } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    const row = this.toolCalls.get(input.toolCallId);
    if (row === undefined) {
      return;
    }
    row.status = input.status;
    if (input.output !== undefined) {
      row.output = input.output;
    }
    if (input.error !== undefined) {
      row.error = input.error;
    }
    if (input.executionMs !== undefined) {
      row.executionMs = input.executionMs;
    }
    if (input.executedByRef !== undefined) {
      row.executedByRef = input.executedByRef;
    }
    if (input.remember !== undefined) {
      row.remember = input.remember;
    }
    if (input.decidedVia !== undefined) {
      row.decidedVia = input.decidedVia;
    }
  }

  async rememberedApprovals(threadId: string): Promise<string[]> {
    const names = new Set<string>();
    for (const call of this.toolCalls.values()) {
      if (call.threadId === threadId && call.remember === true) {
        names.add(call.toolName);
      }
    }
    return [...names];
  }

  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    const call = this.toolCalls.get(toolCallId);
    if (call === undefined) {
      return null;
    }
    return {
      status: call.status,
      approver: call.approver ?? null,
      expiresAt: call.expiresAt ?? null,
    };
  }

  /** A message with the approval record of every call on it that was put to a person. */
  private withApprovals(message: StoredMessage): StoredMessage {
    const approvals: ToolCallApproval[] = [];
    for (const call of this.toolCalls.values()) {
      if (call.messageId !== message.id) {
        continue;
      }
      const approval = toolCallApprovalFromRow({
        toolCallId: call.toolCallId,
        status: call.status,
        approver: call.approver,
        confirmation: call.confirmation,
        expiresAt: call.expiresAt,
        remember: call.remember,
        executedByRef: call.executedByRef,
        decidedVia: call.decidedVia,
        error: call.error,
      });
      if (approval !== null) {
        approvals.push(approval);
      }
    }
    return approvals.length > 0 ? { ...message, approvals } : message;
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    const createdAt = this.now();
    this.usage.push({
      actorRef: input.actorRef,
      threadId: input.threadId,
      modelId: input.modelId,
      purpose: input.purpose,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      day: createdAt.slice(0, 10),
      createdAt,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: input.usage.cacheWriteTokens }
        : {}),
      ...(input.usage.cacheReadTokens !== undefined
        ? { cacheReadTokens: input.usage.cacheReadTokens }
        : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    });
  }

  async getRunActorRef(runId: string): Promise<string | null> {
    return this.runs.get(runId)?.actorRef ?? null;
  }

  async recordRunStart(input: RecordRunStartInput): Promise<void> {
    this.runs.set(input.runId, {
      runId: input.runId,
      threadId: input.threadId,
      actorRef: input.actor.id,
      status: 'running',
      startedAt: this.now(),
      stepCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      durable: input.durable ?? false,
      ...(input.actor.tenantRef !== undefined ? { tenantRef: input.actor.tenantRef } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    });
  }

  async recordRunEnd(input: RecordRunEndInput): Promise<void> {
    const row = this.runs.get(input.runId);
    // First terminal wins: a no-op when the run is unknown or already settled (mirrors the Lucid twin).
    if (row === undefined || row.status !== 'running') {
      return;
    }
    row.status = input.status;
    row.finishedAt =
      input.finishedAt !== undefined ? new Date(input.finishedAt).toISOString() : this.now();
    if (input.stepCount !== undefined) row.stepCount = input.stepCount;
    if (input.inputTokens !== undefined) row.inputTokens = input.inputTokens;
    if (input.outputTokens !== undefined) row.outputTokens = input.outputTokens;
    if (input.costUsd !== undefined) row.costUsd = input.costUsd;
    if (input.error !== undefined) row.error = input.error;
  }

  async usageBetween(
    actorRef: string,
    fromDay: string,
    toDay: string,
  ): Promise<{ usedTokens: number; costUsd: number }> {
    let usedTokens = 0;
    let costUsd = 0;
    for (const row of this.usage) {
      if (row.actorRef === actorRef && row.day >= fromDay && row.day <= toDay) {
        usedTokens += row.inputTokens + row.outputTokens;
        costUsd += row.costUsd ?? 0;
      }
    }
    return { usedTokens, costUsd };
  }

  async quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }> {
    const usedTokens = this.usage
      .filter((row) => row.actorRef === actorRef && row.day === day)
      .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    return { usedTokens };
  }

  /** Test helper: read the recorded usage rows (modelId + purpose + token totals). */
  usageRows(): { actorRef: string; tokens: number; modelId: string; purpose: string }[] {
    return this.usage.map((row) => ({
      actorRef: row.actorRef,
      tokens: row.inputTokens + row.outputTokens,
      modelId: row.modelId,
      purpose: row.purpose,
    }));
  }

  /** Governance read-model feed: recorded usage rows with the input/output split + thread/day. */
  governanceUsage(): GovernanceUsageRow[] {
    return this.usage.map((row) => ({
      actorRef: row.actorRef,
      threadId: row.threadId,
      modelId: row.modelId,
      purpose: row.purpose,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      day: row.day,
      createdAt: row.createdAt,
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
      ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
      ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {}),
      ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    }));
  }

  /** Governance read-model feed: recorded tool calls with the resolved thread + timestamp. */
  governanceToolCalls(): GovernanceToolCallRow[] {
    return [...this.toolCalls.values()].map((row) => ({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolType: row.toolType,
      status: row.status,
      threadId: row.threadId,
      input: row.input,
      createdAt: row.createdAt,
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
      ...(row.output !== undefined ? { output: row.output } : {}),
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.executionMs !== undefined ? { executionMs: row.executionMs } : {}),
    }));
  }

  /** Governance read-model feed: recorded runs (full lifecycle + rollups). */
  governanceRuns(): GovernanceRunRow[] {
    return [...this.runs.values()].map((row) => ({ ...row }));
  }

  /** Governance read-model feed: recorded messages with their thread + run correlation. */
  governanceMessages(): GovernanceMessageRow[] {
    const rows: GovernanceMessageRow[] = [];
    for (const thread of this.threads.values()) {
      for (const message of thread.messages) {
        rows.push({
          id: message.id,
          threadId: thread.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.runId !== undefined ? { runId: message.runId } : {}),
        });
      }
    }
    return rows;
  }

  /** Governance read-model feed: thread metadata (title/actor/message count/last activity). */
  governanceThreads(): GovernanceThreadRow[] {
    return [...this.threads.values()].map((row) => ({
      threadId: row.id,
      title: row.title,
      actorRef: row.actorRef,
      messageCount: row.messages.length,
      updatedAt: row.updatedAt,
    }));
  }

  private threadIdForMessage(messageId: string): string | undefined {
    for (const [threadId, row] of this.threads) {
      if (row.messages.some((message) => message.id === messageId)) {
        return threadId;
      }
    }
    return undefined;
  }

  /** Test helper: read the recorded tool-call rows. */
  toolCallRows(): {
    toolCallId: string;
    runId?: string;
    toolName: string;
    status: ToolCallStatus;
    output?: unknown;
  }[] {
    return [...this.toolCalls.values()].map((row) => ({
      toolCallId: row.toolCallId,
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
      toolName: row.toolName,
      status: row.status,
      ...(row.output !== undefined ? { output: row.output } : {}),
    }));
  }

  private toSummary(row: ThreadRow): ThreadSummary {
    const last = row.messages[row.messages.length - 1];
    return {
      id: row.id,
      title: row.title,
      persona: row.persona,
      transient: row.transient,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.pinnedAt !== undefined ? { pinnedAt: row.pinnedAt } : {}),
      ...(last !== undefined ? { lastMessagePreview: last.content.slice(0, 120) } : {}),
      model: row.model ?? null,
      defaultAgent: row.defaultAgent ?? null,
      activeRunId: row.activeStreamId ?? null,
    };
  }
}
