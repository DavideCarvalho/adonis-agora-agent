/**
 * A read-model over the persisted agent data (usage ⋈ pricing, tool calls, threads) for the
 * governance surfaces — the standalone `-dashboard` SPA and the `-telescope` "Agent" tab both
 * consume this ONE interface, so cost/usage aggregation lives in a single place.
 *
 * Separate from {@link AgentStore} on purpose: that SPI owns the write/thread path, this owns the
 * read/analytics path. A store adapter implements both. Consumers inject via
 * `AGENT_GOVERNANCE_QUERIES`.
 *
 * Live activity (in-flight runs, streaming tool calls, delegations, forbidden attempts) is NOT here
 * — that comes off the `aviary:agent:*` diagnostics channel. This interface is the durable, restart-
 * surviving history.
 */

/** Inclusive UTC day range, each `YYYY-MM-DD`. */
export interface GovernanceRange {
  fromDay: string;
  toDay: string;
}

/** Spend + token totals for one model over a range. */
export interface ModelSpendRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Spend + token totals for one acting ref (user/tenant) over a range. */
export interface ActorSpendRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/** One point on the daily usage/cost trend. */
export interface UsageTrendPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
}

/** A recent tool-call for the activity feed. */
export interface ToolCallActivityRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  threadId: string;
  createdAt: string;
}

/** A recent thread with rolled-up activity. */
export interface ThreadActivityRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  totalTokens: number;
  lastActivityAt: string;
}

// ── Run lifecycle read-model ─────────────────────────────────────────────────

/** A run's lifecycle status as the read-model surfaces it. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Filters + cursor for {@link AgentGovernanceQueries.listRuns}. All optional; absent = no constraint. */
export interface ListRunsFilter {
  /** Exact `actor_ref`. */
  actor?: string;
  /** Exact `agent_name`. */
  agent?: string;
  status?: RunStatus;
  /** Inclusive UTC-day lower bound on `started_at`, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive UTC-day upper bound on `started_at`, `YYYY-MM-DD`. */
  to?: string;
  /** Opaque cursor from a prior page's {@link ListRunsResult.nextCursor}; omit for the first page. */
  cursor?: string;
  /** Page size; defaults to 50, clamped to 200 by the adapter. */
  limit?: number;
}

/** A run row for the governance list + detail. Newest-first in {@link ListRunsResult}. */
export interface RunSummaryRow {
  runId: string;
  threadId: string;
  actorRef: string;
  tenantRef: string | null;
  agentName: string | null;
  status: string;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp, `null` while still running. */
  finishedAt: string | null;
  /** `finishedAt - startedAt` in ms, `null` while still running. */
  durationMs: number | null;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  durable: boolean;
}

/** One page of {@link AgentGovernanceQueries.listRuns}, newest-first, with an opaque forward cursor. */
export interface ListRunsResult {
  runs: RunSummaryRow[];
  /** Pass back as {@link ListRunsFilter.cursor} for the next page; `null` when the last page was returned. */
  nextCursor: string | null;
}

/** A message belonging to a run, for {@link RunDetail}. */
export interface RunMessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

/** A tool call belonging to a run, for {@link RunDetail} (and the approvals subset). */
export interface RunToolCallRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  executionMs: number | null;
  createdAt: string;
}

/** A usage ledger row belonging to a run, for {@link RunDetail}. */
export interface RunUsageRow {
  modelId: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  createdAt: string;
}

/** The full trace of one run: the run row plus its messages, tool calls, pending approvals and usage. */
export interface RunDetail {
  run: RunSummaryRow;
  messages: RunMessageRow[];
  toolCalls: RunToolCallRow[];
  /** The subset of `toolCalls` still `pending_approval`. */
  approvals: RunToolCallRow[];
  usage: RunUsageRow[];
}

/** Filters for {@link AgentGovernanceQueries.pendingApprovals}. */
export interface PendingApprovalsFilter {
  /** Restrict to a single acting ref (the owning run's `actor_ref`). */
  actor?: string;
  /** Cap the inbox; defaults to 50, clamped to 200 by the adapter. */
  limit?: number;
}

/** One tool call awaiting a HITL decision, for the cross-thread approvals inbox (oldest first). */
export interface PendingApprovalRow {
  toolCallId: string;
  toolName: string;
  input: unknown;
  threadId: string;
  /** The run this call belongs to, for a trace deep-link; `null` for a call recorded before run tracking. */
  runId: string | null;
  /** Who asked — the owning run's (or thread's) actor. */
  actorRef: string;
  /** ISO timestamp the call was recorded (requested). */
  requestedAt: string;
}

/** Inclusive UTC-day range for the run/tool aggregates; each bound `YYYY-MM-DD`, both optional. */
export interface ToolStatsRange {
  /** Lower bound on the row's `created_at`/`started_at`; omit for no lower bound. */
  from?: string;
  /** Upper bound; omit for no upper bound. */
  to?: string;
}

/** Per-tool call/failure/rejection/latency rollup over a range, highest call count first. */
export interface PerToolStatRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  /** Mean `executionMs` across calls that recorded one; `null` when none did. */
  avgDurationMs: number | null;
}

/** Run count + failure count for one agent, part of {@link RunReliability.byAgent}. */
export interface RunAgentBreakdownRow {
  /** `"—"`-free; a run recorded before agent tracking (or with no agent set) is grouped as `null`. */
  agentName: string | null;
  runs: number;
  failed: number;
  /** completed / runs for this agent, 0 when runs = 0. */
  successRate: number;
}

/** One day's run volume + failure count, part of {@link RunReliability.trend}. */
export interface RunTrendPoint {
  day: string;
  runs: number;
  failed: number;
}

/** Aggregated run reliability over a range — success / failure / cancel rates. */
export interface RunReliability {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  /** completed / runs, 0 when runs = 0. */
  successRate: number;
  /** failed / runs, 0 when runs = 0. */
  failureRate: number;
  /** cancelled / runs, 0 when runs = 0. */
  cancelRate: number;
  /** Mean duration of settled (completed/failed/cancelled) runs in ms; `null` when none settled. */
  avgDurationMs: number | null;
  /**
   * Run/failure counts grouped by `agentName`, highest call count first. Optional: an adapter that
   * predates this breakdown may omit it; the dashboard renders an empty section when absent.
   */
  byAgent?: RunAgentBreakdownRow[];
  /** Daily run/failure counts over the same range, oldest first. Optional, same reason as {@link byAgent}. */
  trend?: RunTrendPoint[];
}

/** Thread metadata + LIFETIME usage rollup (not range-scoped) for the thread governance drill-down. */
export interface GovernanceThreadDetail {
  threadId: string;
  title: string;
  actorRef: string;
  createdAt: string;
  updatedAt: string;
  /** `true` when the thread has been soft-deleted (the record is still readable here). */
  deleted: boolean;
  usage: {
    totalTokens: number;
    /** `null` when the thread has no priced usage at all (not the same as a $0 total). */
    costUsd: number | null;
    runCount: number;
    messageCount: number;
  };
  /** Newest-first, capped by the adapter (mirrors {@link ListRunsResult} page sizing). */
  runs: RunSummaryRow[];
  /** Newest-first, capped by the adapter. */
  messages: RunMessageRow[];
}

/**
 * The governance read-model. Cost is `inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 *
 * outputPricePer1m` against the current pricing row per model; an unpriced model contributes 0 cost
 * (its tokens still count).
 */
export interface AgentGovernanceQueries {
  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]>;
  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]>;
  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]>;
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]>;
  recentThreads(limit: number): Promise<ThreadActivityRow[]>;

  // ── Run lifecycle governance. An adapter backed by a store without run recording returns an empty
  // page / null / zeros from these.
  /** Filterable, cursor-paginated run list, newest-first. */
  listRuns(filter?: ListRunsFilter): Promise<ListRunsResult>;
  /** The full trace of one run (run + messages + tool calls + approvals + usage), or `null` if unknown. */
  runDetail(runId: string): Promise<RunDetail | null>;
  /** Tool calls sitting `pending_approval`, oldest first (an inbox drains from the back). */
  pendingApprovals(filter?: PendingApprovalsFilter): Promise<PendingApprovalRow[]>;
  /** Per-tool call/failure/rejection/latency rollup over the range, highest call count first. */
  perToolStats(range?: ToolStatsRange): Promise<PerToolStatRow[]>;
  /** Success/failure/cancel rates + mean settled duration over the range. */
  runReliability(range?: ToolStatsRange): Promise<RunReliability>;
  /**
   * The thread governance drill-down: metadata + lifetime usage rollup + recent runs/messages, or
   * `null` when unknown. Optional — an adapter that predates this method leaves the route unmounted
   * with a `501` rather than the dashboard breaking on a missing function.
   */
  threadDetail?(threadId: string): Promise<GovernanceThreadDetail | null>;
}
