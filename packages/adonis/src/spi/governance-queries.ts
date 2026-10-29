import type { GenuiStats } from '../genui-telemetry.js';
import type { Latency, RunFailureCodeRow } from '../run-metrics.js';
import type { RunTimings } from './agent-store.js';

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

import type { CursorPage, CursorParams } from '../pagination.js';

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
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. See {@link ActorSpendRow.actorRef}. */
  actorLabel?: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Spend for one feature over a range — agent turns and usage recorded outside them
 * (`AgentService.recordUsage`) side by side. An agent-turn row recorded before features existed is
 * reported under `agent`.
 */
export interface FeatureSpendRow {
  feature: string;
  /**
   * `'agent'` for rows an agent turn wrote, `'external'` for rows recorded through
   * `AgentService.recordUsage`. A feature recorded both ways is two rows.
   */
  source: 'agent' | 'external';
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Seconds of audio billed; `0` when none. */
  audioSeconds: number;
  /** Characters billed; `0` when none. */
  characters: number;
  /** Provider-reported plus estimated cost (an unpriced row's tokens priced from the pricing table). */
  costUsd: number;
}

/**
 * One actor's spend on one feature over a range — the report "cost by actor and by feature". Group
 * the rows by `actorRef` or by `feature` for either total. Platform cost (`actorRef: null` on
 * `recordUsage`) is the actor `@platform`.
 */
export interface UsageBreakdownRow {
  actorRef: string;
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. */
  actorLabel?: string;
  feature: string;
  source: 'agent' | 'external';
  requests: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  characters: number;
  costUsd: number;
  /** The part of `costUsd` that is an estimate (recorded as one, or priced here from tokens). */
  estimatedCostUsd: number;
}

/** Filters for {@link AgentGovernanceQueries.usageBreakdown}, on top of the day range. */
export interface UsageBreakdownFilter {
  /** Exact `actor_ref`. */
  actor?: string;
  /** Exact feature (`agent` matches the rows from before features too). */
  feature?: string;
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
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. */
  actorLabel?: string;
  messageCount: number;
  totalTokens: number;
  lastActivityAt: string;
}

// ── Run lifecycle read-model ─────────────────────────────────────────────────

/** A run's lifecycle status as the read-model surfaces it. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Filters + cursor for {@link AgentGovernanceQueries.listRuns}. All optional; absent = no constraint.
 *
 * The pagination half is {@link CursorParams} — the ecosystem-wide `{ after, first }` shape mirroring
 * `@adonis-agora/filter`'s `CursorParams`. Forward-only: no `before`/`last`.
 */
export interface ListRunsFilter extends CursorParams {
  /** Exact `actor_ref`. */
  actor?: string;
  /** Exact `agent_name`. */
  agent?: string;
  status?: RunStatus;
  /** Inclusive UTC-day lower bound on `started_at`, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive UTC-day upper bound on `started_at`, `YYYY-MM-DD`. */
  to?: string;
  /**
   * Opaque cursor from a prior page's {@link ListRunsResult.nextCursor}; omit for the first page.
   * (Inherited from {@link CursorParams}, restated for the doc site.)
   */
  after?: string;
  /** Page size; defaults to 50, clamped to 200 by the adapter. (Inherited from {@link CursorParams}.) */
  first?: number;
}

/** A run row for the governance list + detail. Newest-first in {@link ListRunsResult}. */
export interface RunSummaryRow {
  runId: string;
  threadId: string;
  actorRef: string;
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. */
  actorLabel?: string;
  tenantRef: string | null;
  agentName: string | null;
  /**
   * The run that delegated this one, or `null` for a turn a person started. Without it a delegation's
   * spend reads as an orphan turn on every surface built over these rows.
   */
  parentRunId: string | null;
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
  /**
   * Turn start → first text frame, for a completed run that streamed text. Optional: an adapter that
   * predates it omits it; `null` when the run didn't record one.
   */
  ttftMs?: number | null;
  /** A failed run's stable stream error code (`quota_exceeded`, `run_failed`…); optional, as `ttftMs`. */
  errorCode?: string | null;
  /** The completed run's last model; optional, as `ttftMs`. */
  modelId?: string | null;
  /**
   * Enqueue → body start (see `RecordRunStartInput.queueMs`); optional, as `ttftMs`; `null` when the
   * run did not record one.
   */
  queueMs?: number | null;
  /** The completed run's model time, summed over its model calls; optional, as `ttftMs`. */
  modelMs?: number | null;
  /** The completed run's tool time, wall-clock (parallel calls once); optional, as `ttftMs`. */
  toolsMs?: number | null;
  /** Model calls the completed run measured; optional, as `ttftMs`. */
  modelCalls?: number | null;
  /** Tool calls the completed run measured; optional, as `ttftMs`. */
  toolCalls?: number | null;
}

/**
 * One page of {@link AgentGovernanceQueries.listRuns}, newest-first, with an opaque forward cursor.
 *
 * This is exactly {@link CursorPage} of {@link RunSummaryRow}: the rows are under `items` (not
 * `runs`), `nextCursor` goes back as {@link ListRunsFilter.after}, and — the read-model being
 * forward-only — `prevCursor` is always `null` and `hasPrev` always `false`.
 */
export type ListRunsResult = CursorPage<RunSummaryRow>;

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
  /** What the row was for (`agent`, `agent:<name>`, or an app's feature); optional for old adapters. */
  feature?: string | null;
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
  /**
   * Where the run's time went, step by step — what the completed run persisted (see
   * {@link RunTimings}). `null` for a run that did not complete or predates timings; optional for an
   * adapter that predates it.
   */
  timings?: RunTimings | null;
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
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. */
  actorLabel?: string;
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
  /**
   * Nearest-rank median / 95th percentile of the same `executionMs` samples; `null` when none did.
   * Optional: an adapter that predates them omits them.
   */
  p50ExecutionMs?: number | null;
  p95ExecutionMs?: number | null;
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
  /**
   * Time to first token and turn duration of the range's completed turns — a person's turns only, a
   * delegation's child run is part of its parent's. Optional, same reason as {@link byAgent}.
   */
  latency?: { ttft: Latency; duration: Latency };
  /**
   * Failed runs by their stream error code, most frequent first; a failure recorded before codes
   * were is `'unknown'`. Optional, same reason as {@link byAgent}.
   */
  failuresByCode?: RunFailureCodeRow[];
}

/** Thread metadata + LIFETIME usage rollup (not range-scoped) for the thread governance drill-down. */
export interface GovernanceThreadDetail {
  threadId: string;
  title: string;
  actorRef: string;
  /** Display label for `actorRef`, when an `actorDirectory` is bound and knows one. */
  actorLabel?: string;
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
 * The governance read-model.
 *
 * Cost per row: a provider-reported `costUsd` always wins. Otherwise it is the same cache-aware
 * estimate {@link import('./pricing-store.js').estimateCost} computes against the model's current
 * pricing row — the UNCACHED input (`inputTokens - cacheWriteTokens - cacheReadTokens`) at
 * `inputPricePer1m`, each cache bucket at its own per-1M rate (falling back to the input rate when
 * unpriced), plus output at `outputPricePer1m`, each divided by 1e6.
 *
 * A model with no pricing row contributes 0 to the ROLLUPS ({@link ModelSpendRow},
 * {@link ActorSpendRow}, {@link UsageTrendPoint}, whose `costUsd` is non-nullable) while its tokens
 * still count. The per-row ledger keeps the distinction: {@link RunSummaryRow.costUsd} and
 * {@link RunUsageRow.costUsd} stay `null` when nothing priced them.
 *
 * The `actorLabel` on every row carrying an `actorRef` is filled by the HTTP layer from the
 * configured `actorDirectory` — an adapter never sets it.
 */
export interface AgentGovernanceQueries {
  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]>;
  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]>;
  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]>;
  /**
   * OPTIONAL: spend per feature over the range, agent turns and recorded usage side by side,
   * costliest first. Absent → `GET <path>/governance/spend/feature` answers `501`.
   */
  spendByFeature?(range: GovernanceRange): Promise<FeatureSpendRow[]>;
  /**
   * OPTIONAL: spend per actor × feature over the range, costliest first — the report behind "cost by
   * actor and by feature". Absent → `GET <path>/governance/usage/breakdown` answers `501`.
   */
  usageBreakdown?(
    range: GovernanceRange,
    filter?: UsageBreakdownFilter,
  ): Promise<UsageBreakdownRow[]>;
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]>;
  recentThreads(limit: number): Promise<ThreadActivityRow[]>;

  // ── Run lifecycle governance. An adapter backed by a store without run recording returns an empty
  // page / null / zeros from these.
  /**
   * Filterable, cursor-paginated run list, newest-first. Pagination is the ecosystem's forward-only
   * cursor interface: `{ after, first }` in, {@link CursorPage} out (`items` / `nextCursor`, with
   * `prevCursor: null` and `hasPrev: false`).
   */
  listRuns(filter?: ListRunsFilter): Promise<ListRunsResult>;
  /** The full trace of one run (run + messages + tool calls + approvals + usage), or `null` if unknown. */
  runDetail(runId: string): Promise<RunDetail | null>;
  /** Tool calls sitting `pending_approval`, oldest first (an inbox drains from the back). */
  pendingApprovals(filter?: PendingApprovalsFilter): Promise<PendingApprovalRow[]>;
  /**
   * OPTIONAL: how many tool calls sit `pending_approval` (for `actor` alone, when given) — the exact
   * total {@link pendingApprovals} would page through, without listing them. Absent → a count stat
   * reads the capped inbox's length instead.
   */
  countPendingApprovals?(filter?: Pick<PendingApprovalsFilter, 'actor'>): Promise<number>;
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
  /**
   * OPTIONAL: generative-UI telemetry over the range — first-try success per tool and model, common
   * errors, UI cost per turn and per day, time to first and complete frame (the dashboard's
   * "Generative UI" page). Absent → `GET <governance>/genui` answers `501`.
   */
  genuiStats?(range: GovernanceRange): Promise<GenuiStats>;
}
