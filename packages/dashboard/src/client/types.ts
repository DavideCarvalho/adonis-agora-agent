/**
 * Wire shapes returned by the `@adonis-agora/agent` provider's read-only governance routes
 * (`/agent/governance/*`) plus the per-actor `quota/today` route. These MIRROR the target's SPI
 * (`AgentGovernanceQueries` in `src/spi/governance-queries.ts`) exactly — the SPA is a pure consumer,
 * so any drift here is a bug against the server contract, not a local choice.
 */

/** Inclusive UTC-day range, each `YYYY-MM-DD`. Sent as `?from=&to=`. */
export interface GovernanceRange {
  fromDay: string;
  toDay: string;
}

/** `GET /agent/governance/spend/model` — spend + token totals for one model over the range. */
export interface ModelSpendRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** `GET /agent/governance/spend/actor` — spend + token totals for one acting ref over the range. */
export interface ActorSpendRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/** `GET /agent/governance/usage/trend` — one point on the daily usage/cost trend. */
export interface UsageTrendPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
}

/** `GET /agent/governance/tool-calls/recent` — a recent tool call for the activity feed. */
export interface ToolCallActivityRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  threadId: string;
  createdAt: string;
}

/** `GET /agent/governance/threads/recent` — a recent thread with rolled-up activity. */
export interface ThreadActivityRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  totalTokens: number;
  lastActivityAt: string;
}

/** `GET /agent/quota/today` — the caller's token spend so far today. */
export interface QuotaToday {
  usedTokens: number;
}

// ── Run lifecycle read-model ─────────────────────────────────────────────────
// These MIRROR the target's SPI run-tracking shapes (`AgentGovernanceQueries` in
// `src/spi/governance-queries.ts`) exactly. The SPA is a pure consumer; drift here is a bug.

/** A run's lifecycle status as the read-model surfaces it. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Filters + cursor for `GET /agent/governance/runs`. All optional; absent = no constraint. */
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
  /** Page size; defaults to 50, clamped to 200 by the server. */
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

/** `GET /agent/governance/runs` — one page, newest-first, with an opaque forward cursor. */
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

/**
 * `GET /agent/governance/runs/:id` — the full trace of one run (run + messages + tool calls +
 * pending approvals + usage), or `null` if unknown.
 */
export interface RunDetail {
  run: RunSummaryRow;
  messages: RunMessageRow[];
  toolCalls: RunToolCallRow[];
  /** The subset of `toolCalls` still `pending_approval`. */
  approvals: RunToolCallRow[];
  usage: RunUsageRow[];
}

/** Filters for `GET /agent/governance/approvals/pending`. */
export interface PendingApprovalsFilter {
  /** Restrict to a single acting ref (the owning run's `actor_ref`). */
  actor?: string;
  /** Cap the inbox; defaults to 50, clamped to 200 by the server. */
  limit?: number;
}

/**
 * `GET /agent/governance/approvals/pending` — one tool call awaiting a HITL decision, for the
 * cross-thread approvals inbox (oldest first).
 */
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

/**
 * `GET /agent/governance/tools/stats` — per-tool call/failure/rejection/latency rollup over a range,
 * highest call count first.
 */
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

/**
 * `GET /agent/governance/reliability` — aggregated run reliability over a range (success / failure /
 * cancel rates + mean settled duration), plus an optional per-agent breakdown and daily trend (an
 * older server may omit both).
 */
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
  /** Run/failure counts grouped by agent, highest call count first. */
  byAgent?: RunAgentBreakdownRow[];
  /** Daily run/failure counts over the same range, oldest first. */
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
  /** Newest-first, capped by the server. */
  runs: RunSummaryRow[];
  /** Newest-first, capped by the server. */
  messages: RunMessageRow[];
}

/** A per-1M-token price for one model, for `POST /agent/governance/pricing`. */
export interface ModelPriceInput {
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  /** Per-1M price for cache-write (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheWritePricePer1m?: number;
  /** Per-1M price for cache-read (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheReadPricePer1m?: number;
}

/** A current price row as read back from `GET /agent/governance/pricing`. */
export interface CurrentModelPrice extends ModelPriceInput {
  effectiveFrom: string;
}
