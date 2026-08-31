import type {
  AgentRunStatus,
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordRunEndInput,
  RecordRunStartInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallStatus,
  UpdateToolCallInput,
} from '../index.js';

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
export class InMemoryAgentStore implements AgentStore {
  private readonly threads = new Map<string, ThreadRow>();
  private readonly toolCalls = new Map<string, ToolCallRow>();
  private readonly usage: UsageRow[] = [];
  private readonly runs = new Map<string, RunRow>();
  /** messageId → runId, so run-detail can gather a run's messages without mutating `StoredMessage`. */
  private readonly messageRunIds = new Map<string, string>();

  private now(): string {
    return new Date().toISOString();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const id = crypto.randomUUID();
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      persona: input.persona,
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
      messages: row.messages,
      ...(row.activeStreamId !== undefined ? { activeStreamId: row.activeStreamId } : {}),
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
      messages: kept.map((message) => ({ ...message })),
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
    };
    row.messages.push(message);
    row.updatedAt = message.createdAt;
    if (input.runId !== undefined) {
      this.messageRunIds.set(message.id, input.runId);
    }
    return message;
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

  async quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }> {
    const usedTokens = this.usage
      .filter((row) => row.actorRef === actorRef && row.day === day)
      .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    return { usedTokens };
  }

  /** Test helper: read the recorded usage rows (modelId + token totals). */
  usageRows(): { actorRef: string; tokens: number; modelId: string }[] {
    return this.usage.map((row) => ({
      actorRef: row.actorRef,
      tokens: row.inputTokens + row.outputTokens,
      modelId: row.modelId,
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
        const runId = this.messageRunIds.get(message.id);
        rows.push({
          id: message.id,
          threadId: thread.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(runId !== undefined ? { runId } : {}),
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
  toolCallRows(): { toolName: string; status: ToolCallStatus; output?: unknown }[] {
    return [...this.toolCalls.values()].map((row) => ({
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
    };
  }
}
