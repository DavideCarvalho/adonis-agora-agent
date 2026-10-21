/**
 * Wire shapes returned by the `@adonis-agora/agent` provider's read-only governance routes
 * (`/agent/governance/*`) plus the per-actor `quota` route. These MIRROR the target's SPI
 * (`AgentGovernanceQueries` in `src/spi/governance-queries.ts`) exactly — the SPA is a pure consumer,
 * so any drift here is a bug against the server contract, not a local choice.
 */

// ── Cursor pagination vocabulary ─────────────────────────────────────────────
// These two types MIRROR `@adonis-agora/filter`'s `CursorParams`/`CursorPage<T>` structurally — the
// one pagination interface every `@adonis-agora/*` package speaks — and are the same declarations the
// target package carries in `src/pagination.ts`. Duplicated rather than imported for the same reason
// as everything else in this file: the SPA is a pure wire-shape consumer with no runtime dependency
// on the server package (nor on `@adonis-agora/filter`). Drift here is a bug.

/**
 * Cursor pagination parameters. **Forward-only** — the server's backends (Qdrant's scroll, the runs
 * read-model's opaque forward cursor) have no backward token, so `@adonis-agora/filter`'s
 * `before`/`last` are deliberately absent rather than declared-and-ignored.
 */
export interface CursorParams {
  /** Opaque cursor from a prior page's {@link CursorPage.nextCursor}; omit for the first page. */
  after?: string;
  /** Page size. */
  first?: number;
}

/**
 * One page of cursor-paginated results. `prevCursor`/`hasPrev` are always `null`/`false` here (see
 * {@link CursorParams}); they exist so this is the SAME shape as `@adonis-agora/filter`'s
 * `CursorPage`, and so a surface that later gains backward paging fills them in without breaking.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

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

/** The day window of `GET /agent/quota` — the caller's token spend so far today. */
export interface QuotaToday {
  usedTokens: number;
}

// ── Run lifecycle read-model ─────────────────────────────────────────────────
// These MIRROR the target's SPI run-tracking shapes (`AgentGovernanceQueries` in
// `src/spi/governance-queries.ts`) exactly. The SPA is a pure consumer; drift here is a bug.

/** A run's lifecycle status as the read-model surfaces it. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Filters + cursor for `GET /agent/governance/runs`. All optional; absent = no constraint.
 *
 * Pagination is {@link CursorParams} — sent as `?after=&first=`.
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
  /** Opaque cursor from a prior page's {@link ListRunsResult.nextCursor}; omit for the first page. */
  after?: string;
  /** Page size; defaults to 50, clamped to 200 by the server. */
  first?: number;
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
  /** Turn start → first text frame, on a completed run; absent from an older server. */
  ttftMs?: number | null;
  /** A failed run's stable stream error code; absent from an older server. */
  errorCode?: string | null;
  /** The completed run's last model; absent from an older server. */
  modelId?: string | null;
}

/**
 * `GET /agent/governance/runs` — one page, newest-first, with an opaque forward cursor. Exactly
 * {@link CursorPage} of {@link RunSummaryRow}: rows under `items`, and the constant `prevCursor:
 * null` / `hasPrev: false` of a forward-only backend.
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
  /** Nearest-rank median / 95th percentile of the same samples; absent from an older server. */
  p50ExecutionMs?: number | null;
  p95ExecutionMs?: number | null;
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
 * cancel rates + mean settled duration), plus an optional per-agent breakdown, daily trend, turn
 * latency and failures by code (an older server may omit them).
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
  /** Time to first token and turn duration of completed, person-started turns; absent from an older server. */
  latency?: { ttft: Latency; duration: Latency };
  /** Failed runs by stream error code, most frequent first; absent from an older server. */
  failuresByCode?: RunFailureCodeRow[];
}

/** How many failed runs ended under one stream error code (`'unknown'` before codes were recorded). */
export interface RunFailureCodeRow {
  code: string;
  count: number;
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

// ── Generative-UI telemetry (`GET /agent/governance/genui`) ──────────────────
// Mirrors `GenuiStats` and its rows in the target's `src/genui-telemetry.ts`. Absent on the server
// (an adapter without `genuiStats`) → the route answers `501` (an `AgentApiError` with that status).

/** First-try success for one UI tool and model. */
export interface GenuiToolModelRow {
  toolName: string;
  modelId: string;
  mode: string;
  calls: number;
  /** Turns whose first UI attempt used this tool. */
  firstAttempts: number;
  firstTrySuccesses: number;
  /** `firstTrySuccesses / firstAttempts`; `null` when there is none. */
  firstTryRate: number | null;
  retried: number;
  failed: number;
  costUsd: number | null;
}

/** One recurring UI tool error (category + scrubbed message + tool). */
export interface GenuiErrorRow {
  category: string;
  /** The (scrubbed) message, as recorded. */
  message: string;
  toolName: string;
  count: number;
  lastAt: string;
}

export interface GenuiDayRow {
  day: string;
  calls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  firstTryRate: number | null;
}

/** A latency distribution: sample count and nearest-rank p50 / p95, `null` when there are no samples. */
export interface Latency {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export type GenuiLatency = Latency;

/** What the console's Generative UI page shows. */
export interface GenuiStats {
  totals: {
    calls: number;
    turns: number;
    firstAttempts: number;
    firstTrySuccesses: number;
    firstTryRate: number | null;
    retried: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
  byToolModel: GenuiToolModelRow[];
  /** Most frequent first, at most 20. */
  errors: GenuiErrorRow[];
  byDay: GenuiDayRow[];
  /** UI cost per turn (turns with at least one UI call). */
  costPerTurn: {
    turns: number;
    avgUsd: number | null;
    p50Usd: number | null;
    p95Usd: number | null;
  };
  /** Per turn: turn start → its first UI frame, and → the first complete UI frame. */
  latency: { firstFrame: GenuiLatency; complete: GenuiLatency };
}
