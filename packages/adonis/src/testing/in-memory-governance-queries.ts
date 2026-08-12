import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  GovernanceThreadDetail,
  ListRunsFilter,
  ListRunsResult,
  ModelSpendRow,
  PendingApprovalRow,
  PendingApprovalsFilter,
  PerToolStatRow,
  RunAgentBreakdownRow,
  RunDetail,
  RunReliability,
  RunSummaryRow,
  RunToolCallRow,
  RunTrendPoint,
  ThreadActivityRow,
  ToolCallActivityRow,
  ToolStatsRange,
  UsageTrendPoint,
} from '../index.js';
import type {
  GovernanceRunRow,
  GovernanceToolCallRow,
  GovernanceUsageRow,
  InMemoryAgentStore,
} from './in-memory-store.js';

/** Default page size + hard cap, mirroring the governance routes' clamp. */
function clampLimit(limit: number | undefined, fallback = 50): number {
  const value =
    limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback;
  return Math.min(value, 200);
}

/** Whether a run's/tool-call's day falls within an optional (both-sides-optional) day range. */
function withinOptionalRange(day: string, range: ToolStatsRange | undefined): boolean {
  if (range?.from !== undefined && day < range.from) return false;
  if (range?.to !== undefined && day > range.to) return false;
  return true;
}

/** Map an in-memory run row to the read-model {@link RunSummaryRow}. */
function runToSummary(run: GovernanceRunRow): RunSummaryRow {
  const finishedAtMs = run.finishedAt !== undefined ? Date.parse(run.finishedAt) : null;
  const startedAtMs = Date.parse(run.startedAt);
  return {
    runId: run.runId,
    threadId: run.threadId,
    actorRef: run.actorRef,
    tenantRef: run.tenantRef ?? null,
    agentName: run.agentName ?? null,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: finishedAtMs === null ? null : finishedAtMs - startedAtMs,
    stepCount: run.stepCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd ?? null,
    error: run.error ?? null,
    durable: run.durable,
  };
}

/** Map an in-memory tool-call feed row to the read-model {@link RunToolCallRow}. */
function toolCallToDetail(row: GovernanceToolCallRow): RunToolCallRow {
  return {
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    toolType: row.toolType,
    status: row.status,
    input: row.input,
    output: row.output ?? null,
    error: row.error ?? null,
    executionMs: row.executionMs ?? null,
    createdAt: row.createdAt,
  };
}

/** The current per-1M token prices for one model; cache rates fall back to the input rate. */
export interface InMemoryModelPrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheWritePricePer1m?: number | null;
  cacheReadPricePer1m?: number | null;
}

/**
 * Token-ledger estimate for one usage row against the supplied pricing map: the uncached input at
 * the input rate, cache-write/cache-read tokens at their own rates (falling back to the input rate
 * when unpriced), plus output at the output rate. An unpriced model (missing from the map)
 * contributes 0 — so the default empty map yields 0 cost everywhere while still counting tokens.
 * Cache token counts are subsets of `inputTokens`, so the uncached remainder is the difference.
 */
function estimateFromTokens(
  pricing: ReadonlyMap<string, InMemoryModelPrice>,
  row: GovernanceUsageRow,
): number {
  const price = pricing.get(row.modelId);
  if (price === undefined) {
    return 0;
  }
  const cacheWriteTokens = row.cacheWriteTokens ?? 0;
  const cacheReadTokens = row.cacheReadTokens ?? 0;
  const uncachedInputTokens = row.inputTokens - cacheWriteTokens - cacheReadTokens;
  return (
    (uncachedInputTokens / 1_000_000) * price.inputPricePer1m +
    (cacheWriteTokens / 1_000_000) * (price.cacheWritePricePer1m ?? price.inputPricePer1m) +
    (cacheReadTokens / 1_000_000) * (price.cacheReadPricePer1m ?? price.inputPricePer1m) +
    (row.outputTokens / 1_000_000) * price.outputPricePer1m
  );
}

/**
 * A fully in-memory {@link AgentGovernanceQueries} for unit tests and the offline demo. Aggregates
 * the usage/tool-call/thread rows recorded on an {@link InMemoryAgentStore}. Pricing is an optional
 * map keyed by `modelId`; omit it (default empty) for a zero-cost read-model that still reports
 * token usage. Mirrors the SQL adapters' cost formula and inclusive-day semantics.
 */
export class InMemoryGovernanceQueries implements AgentGovernanceQueries {
  constructor(
    private readonly store: InMemoryAgentStore,
    private readonly pricing: ReadonlyMap<string, InMemoryModelPrice> = new Map(),
  ) {}

  private inRange(day: string, range: GovernanceRange): boolean {
    return day >= range.fromDay && day <= range.toDay;
  }

  /** Provider-reported cost wins per row; otherwise the cache-aware token estimate. */
  private rowCost(row: GovernanceUsageRow): number {
    return row.costUsd ?? estimateFromTokens(this.pricing, row);
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const byModel = new Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
    >();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byModel.get(row.modelId) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      bucket.requests += 1;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.costUsd += this.rowCost(row);
      byModel.set(row.modelId, bucket);
    }
    const result: ModelSpendRow[] = [];
    for (const [modelId, bucket] of byModel) {
      result.push({
        modelId,
        requests: bucket.requests,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        costUsd: bucket.costUsd,
      });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.modelId.localeCompare(right.modelId),
    );
    return result;
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byActor.get(row.actorRef) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row);
      byActor.set(row.actorRef, bucket);
    }
    const result: ActorSpendRow[] = [];
    for (const [actorRef, bucket] of byActor) {
      result.push({
        actorRef,
        requests: bucket.requests,
        totalTokens: bucket.totalTokens,
        costUsd: bucket.costUsd,
      });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.actorRef.localeCompare(right.actorRef),
    );
    return result;
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byDay.get(row.day) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row);
      byDay.set(row.day, bucket);
    }
    const result: UsageTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return [...this.store.governanceToolCalls()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((row) => ({
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        toolType: row.toolType,
        status: row.status,
        threadId: row.threadId,
        createdAt: row.createdAt,
      }));
  }

  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    const usage = this.store.governanceUsage();
    return [...this.store.governanceThreads()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((thread) => {
        const totalTokens = usage
          .filter((row) => row.threadId === thread.threadId)
          .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
        return {
          threadId: thread.threadId,
          title: thread.title,
          actorRef: thread.actorRef,
          messageCount: thread.messageCount,
          totalTokens,
          lastActivityAt: thread.updatedAt,
        };
      });
  }

  // ── Run lifecycle read-model (behavioral twin of LucidGovernanceQueries) ────

  async listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    const limit = clampLimit(filter.limit);
    const offset = ((): number => {
      const parsed = filter.cursor !== undefined ? Number.parseInt(filter.cursor, 10) : 0;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })();

    const matched = this.store
      .governanceRuns()
      .filter((run) => {
        if (filter.actor !== undefined && run.actorRef !== filter.actor) return false;
        if (filter.agent !== undefined && (run.agentName ?? '') !== filter.agent) return false;
        if (filter.status !== undefined && run.status !== filter.status) return false;
        const day = run.startedAt.slice(0, 10);
        if (filter.from !== undefined && day < filter.from) return false;
        if (filter.to !== undefined && day > filter.to) return false;
        return true;
      })
      // Newest-first, `runId` desc for a stable tiebreak (mirrors the Lucid ordering).
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId),
      );

    const page = matched.slice(offset, offset + limit);
    const hasMore = matched.length > offset + limit;
    return {
      runs: page.map(runToSummary),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  }

  async runDetail(runId: string): Promise<RunDetail | null> {
    const run = this.store.governanceRuns().find((candidate) => candidate.runId === runId);
    if (run === undefined) return null;

    const messages = this.store
      .governanceMessages()
      .filter((message) => message.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }));
    const toolCalls = this.store
      .governanceToolCalls()
      .filter((call) => call.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(toolCallToDetail);
    const usage = this.store
      .governanceUsage()
      .filter((row) => row.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((row) => ({
        modelId: row.modelId,
        purpose: row.purpose ?? 'chat',
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd ?? null,
        createdAt: row.createdAt,
      }));
    return {
      run: runToSummary(run),
      messages,
      toolCalls,
      approvals: toolCalls.filter((call) => call.status === 'pending_approval'),
      usage,
    };
  }

  async pendingApprovals(filter: PendingApprovalsFilter = {}): Promise<PendingApprovalRow[]> {
    const limit = clampLimit(filter.limit);
    const runByThreadActor = new Map<string, string>(
      this.store.governanceRuns().map((run) => [run.runId, run.actorRef]),
    );
    const threadActor = new Map<string, string>(
      this.store.governanceThreads().map((thread) => [thread.threadId, thread.actorRef]),
    );
    const result: PendingApprovalRow[] = [];
    const pending = this.store
      .governanceToolCalls()
      .filter((call) => call.status === 'pending_approval')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const call of pending) {
      const actorRef =
        (call.runId !== undefined ? runByThreadActor.get(call.runId) : undefined) ??
        threadActor.get(call.threadId) ??
        '';
      if (filter.actor !== undefined && actorRef !== filter.actor) continue;
      result.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        threadId: call.threadId,
        runId: call.runId ?? null,
        actorRef,
        requestedAt: call.createdAt,
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  async perToolStats(range: ToolStatsRange = {}): Promise<PerToolStatRow[]> {
    const byTool = new Map<
      string,
      {
        toolName: string;
        toolType: string;
        calls: number;
        failed: number;
        rejected: number;
        durationSum: number;
        durationCount: number;
      }
    >();
    for (const call of this.store.governanceToolCalls()) {
      if (!withinOptionalRange(call.createdAt.slice(0, 10), range)) continue;
      const key = `${call.toolName} ${call.toolType}`;
      const bucket = byTool.get(key) ?? {
        toolName: call.toolName,
        toolType: call.toolType,
        calls: 0,
        failed: 0,
        rejected: 0,
        durationSum: 0,
        durationCount: 0,
      };
      bucket.calls += 1;
      if (call.status === 'failed') bucket.failed += 1;
      if (call.status === 'rejected') bucket.rejected += 1;
      if (call.executionMs !== undefined) {
        bucket.durationSum += call.executionMs;
        bucket.durationCount += 1;
      }
      byTool.set(key, bucket);
    }
    const result: PerToolStatRow[] = [];
    for (const bucket of byTool.values()) {
      result.push({
        toolName: bucket.toolName,
        toolType: bucket.toolType,
        calls: bucket.calls,
        failed: bucket.failed,
        rejected: bucket.rejected,
        avgDurationMs:
          bucket.durationCount === 0 ? null : bucket.durationSum / bucket.durationCount,
      });
    }
    result.sort(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );
    return result;
  }

  async runReliability(range: ToolStatsRange = {}): Promise<RunReliability> {
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let running = 0;
    let durationSum = 0;
    let durationCount = 0;
    let total = 0;
    const byAgent = new Map<string | null, { runs: number; failed: number; completed: number }>();
    const byDay = new Map<string, { runs: number; failed: number }>();
    for (const run of this.store.governanceRuns()) {
      if (!withinOptionalRange(run.startedAt.slice(0, 10), range)) continue;
      total += 1;
      if (run.status === 'completed') completed += 1;
      else if (run.status === 'failed') failed += 1;
      else if (run.status === 'cancelled') cancelled += 1;
      else running += 1;
      if (run.status !== 'running' && run.finishedAt !== undefined) {
        durationSum += Date.parse(run.finishedAt) - Date.parse(run.startedAt);
        durationCount += 1;
      }

      const agentName = run.agentName ?? null;
      const agentBucket = byAgent.get(agentName) ?? { runs: 0, failed: 0, completed: 0 };
      agentBucket.runs += 1;
      if (run.status === 'failed') agentBucket.failed += 1;
      if (run.status === 'completed') agentBucket.completed += 1;
      byAgent.set(agentName, agentBucket);

      const day = run.startedAt.slice(0, 10);
      const dayBucket = byDay.get(day) ?? { runs: 0, failed: 0 };
      dayBucket.runs += 1;
      if (run.status === 'failed') dayBucket.failed += 1;
      byDay.set(day, dayBucket);
    }

    const byAgentRows: RunAgentBreakdownRow[] = [...byAgent.entries()]
      .map(([agentName, bucket]) => ({
        agentName,
        runs: bucket.runs,
        failed: bucket.failed,
        successRate: bucket.runs === 0 ? 0 : bucket.completed / bucket.runs,
      }))
      .sort(
        (left, right) =>
          right.runs - left.runs || (left.agentName ?? '').localeCompare(right.agentName ?? ''),
      );
    const trend: RunTrendPoint[] = [...byDay.entries()]
      .map(([day, bucket]) => ({ day, runs: bucket.runs, failed: bucket.failed }))
      .sort((left, right) => left.day.localeCompare(right.day));

    return {
      runs: total,
      completed,
      failed,
      cancelled,
      running,
      successRate: total === 0 ? 0 : completed / total,
      failureRate: total === 0 ? 0 : failed / total,
      cancelRate: total === 0 ? 0 : cancelled / total,
      avgDurationMs: durationCount === 0 ? null : durationSum / durationCount,
      byAgent: byAgentRows,
      trend,
    };
  }

  /**
   * The thread governance drill-down (behavioral twin of `LucidGovernanceQueries.threadDetail`):
   * metadata + a LIFETIME usage rollup + the most recent runs/messages. `null` when unknown. The
   * in-memory store never returns a soft-deleted thread from `governanceThreads()` at all, so
   * `deleted` is always `false` here — mirroring the store's own delete semantics.
   */
  async threadDetail(threadId: string): Promise<GovernanceThreadDetail | null> {
    const thread = this.store.governanceThreads().find((t) => t.threadId === threadId);
    if (thread === undefined) return null;

    const usage = this.store.governanceUsage().filter((row) => row.threadId === threadId);
    const totalTokens = usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const costUsd =
      usage.length === 0 ? null : usage.reduce((sum, row) => sum + this.rowCost(row), 0);

    const runs = this.store
      .governanceRuns()
      .filter((run) => run.threadId === threadId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const messages = this.store
      .governanceMessages()
      .filter((message) => message.threadId === threadId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      threadId: thread.threadId,
      title: thread.title,
      actorRef: thread.actorRef,
      // GovernanceThreadRow carries no separate createdAt — updatedAt is the closest fact the
      // in-memory store tracks, unlike the Lucid twin which reads the real thread row.
      createdAt: thread.updatedAt,
      updatedAt: thread.updatedAt,
      deleted: false,
      usage: {
        totalTokens,
        costUsd,
        runCount: runs.length,
        messageCount: messages.length,
      },
      runs: runs.slice(0, 20).map(runToSummary),
      messages: messages.slice(0, 50).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    };
  }
}
