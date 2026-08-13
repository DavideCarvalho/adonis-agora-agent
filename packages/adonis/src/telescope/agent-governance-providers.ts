import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import { getTelescopeGovernanceQueries } from './governance-registry.js';
import type { DataProvider, ExtensionContext } from './telescope-sdk.js';

/**
 * Governance data providers for the "Agent" Telescope tab: spend/usage, run reliability, tool
 * activity, and the pending-approvals inbox. Unlike `data-providers.ts` (which reads the ephemeral,
 * capped `lib:agent` diagnostic entries Telescope's generic bridge records), these read the
 * authoritative, restart-surviving read-model — `AgentGovernanceQueries` — via
 * `governance-registry.ts` (see that file for why a module-internal registry stands in for Nest's
 * DI-resolved `AGENT_GOVERNANCE_QUERIES`).
 *
 * ## Ported from the Nest reference with real gaps, not just renamed fields
 *
 * Adonis's `AgentGovernanceQueries` (`../spi/governance-queries.js`) is NOT the same interface as
 * nestjs-agent-core's — it is a separately-designed SPI that happens to cover the same ground. Some
 * of Nest's governance panels have no Adonis equivalent to bind to, and are deliberately NOT ported
 * here rather than faked against a shape that doesn't exist:
 *
 *  - **Top threads by cost** (`spendByThread`) — no such query on `AgentGovernanceQueries`.
 *  - **Run retries** — `RunReliability` has no retry counter at all (Nest's `RunMetrics.retries`
 *    counts LLM-step retries; Adonis's read-model doesn't aggregate that dimension).
 *  - **Run duration percentiles** — `RunReliability` exposes one `avgDurationMs`, not p50/p95; the
 *    `agent.runs.duration` provider below returns the mean instead of a metric-selectable
 *    percentile (Nest's `query.metric === 'p95'` switch has nothing to switch to here).
 *  - **Failed-run breakdown by error code** — no `RunErrorBreakdownRow`-shaped query exists;
 *    `RunSummaryRow.error` is a per-run message, not an aggregable code.
 *  - **Paged tool-calls / threads / runs tables** (`{ rows, total, page, limit }`, `Panel.paged`) —
 *    `AgentGovernanceQueries` has no page+total query for tool calls or threads at all
 *    (`recentToolCalls`/`recentThreads` are capped lists with no total), and `listRuns` paginates by
 *    an opaque CURSOR, not a page number, so it cannot answer "page 3 of 7" either. `agent.runs.recent`
 *    below uses `listRuns` for its FIRST page only, same as Nest's `recentRuns(limit)` — the capped,
 *    non-paged shape both ecosystems already had before A1's paged-table convention existed.
 *  - **Exact pending-approvals count** — `pendingApprovals` returns an array with no `total`; unlike
 *    Nest's `approvalsPage({ page: 1, pageSize: 1 }).total`, there is no cheap way to ask "how many,
 *    without listing them". `agentPendingApprovalsCountProvider` below is therefore a real
 *    approximation — see its own doc comment.
 *
 * Every provider still degrades to an empty-but-valid shape (0 / `[]`) when the read-model isn't
 * bound, exactly like the Nest reference — governance is optional configuration
 * (`config.governanceQueries`), and telescope must render something sane when it's off.
 */

/** Default trailing window (in days, inclusive) when a panel query omits an explicit range. */
const DEFAULT_TREND_WINDOW_DAYS = 30;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A breakdown-panel segment (Telescope core: `{ segments: Array<{ label, value, color? }> }`). */
interface BreakdownSegment {
  label: string;
  value: number;
}

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_PATTERN.test(value);
}

function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` UTC day by `deltaDays` (negative goes back in time). */
export function shiftUtcDay(day: string, deltaDays: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Derive the query range: honour explicit `fromDay`/`toDay` (validated ISO days), otherwise default
 * to the trailing {@link DEFAULT_TREND_WINDOW_DAYS}-day window ending today (UTC).
 */
export function resolveRange(query: Record<string, unknown> | undefined): {
  fromDay: string;
  toDay: string;
} {
  const toDay = query && isIsoDay(query.toDay) ? query.toDay : todayUtcDay();
  const fromDay =
    query && isIsoDay(query.fromDay)
      ? query.fromDay
      : shiftUtcDay(toDay, -(DEFAULT_TREND_WINDOW_DAYS - 1));
  return { fromDay, toDay };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Read a positive number out of a raw query value — panel queries reach a provider as strings. */
function readPositiveNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Default row count for a "recent …" feed when a panel's query omits `limit`. */
const DEFAULT_RECENT_LIMIT = 50;
/** Hard ceiling on `limit`, regardless of what a panel's query requests. */
const MAX_RECENT_LIMIT = 500;

/** Clamp a panel-supplied `limit` into `[1, MAX_RECENT_LIMIT]`, defaulting when absent/invalid. */
function resolveLimit(query: Record<string, unknown> | undefined, fallback: number): number {
  const value = readPositiveNumber(query?.limit) ?? fallback;
  return Math.min(MAX_RECENT_LIMIT, Math.max(1, Math.trunc(value)));
}

/** Placeholder shown for a table cell whose source value is `null`/unmeasured. */
const NO_VALUE = '—';

/** Cap this many characters before an error message rides into a table cell (matches the DB column's practical display width). */
const ERROR_MESSAGE_CAP = 500;

/** Cap a run's error message to {@link ERROR_MESSAGE_CAP} characters. `resolve()` output bypasses
 * Telescope's entry redaction pipeline (that only runs on Watcher-recorded entries) — this cap is a
 * stopgap so an unbounded stack trace never rides straight into a table cell unbounded. */
export function capErrorMessage(message: string | null): string {
  if (message === null) return NO_VALUE;
  return message.length > ERROR_MESSAGE_CAP ? `${message.slice(0, ERROR_MESSAGE_CAP)}…` : message;
}

// ── Spend / usage ──────────────────────────────────────────────────────────

interface ModelSpendTableRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ActorSpendTableRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

interface UsageTrendTableRow {
  label: string;
  costUsd: number;
  totalTokens: number;
}

/** Build a governance `DataProvider` from a fetch + a format step. Degrades to `format([])` when the
 * read-model isn't bound — the empty-but-valid shape every formatter already yields for `[]`. */
function governanceProvider<TArg, TRow>(
  name: string,
  arg: (query: Record<string, unknown> | undefined) => TArg,
  fetch: (queries: AgentGovernanceQueries, arg: TArg) => Promise<TRow[]>,
  format: (rows: TRow[]) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, _ctx: ExtensionContext) {
      const queries = getTelescopeGovernanceQueries();
      const rows = queries ? await fetch(queries, arg(query)) : [];
      return format(rows);
    },
  };
}

/** stat → authoritative total spend (USD) over the range. */
export function agentSpendTotalProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.totalCost',
    resolveRange,
    (queries, range) => queries.spendByModel(range),
    (rows: { costUsd: number }[]) => ({
      value: roundCents(rows.reduce((sum, row) => sum + row.costUsd, 0)),
    }),
  );
}

/** stat → authoritative total tokens (input + output) over the range. */
export function agentTokensTotalProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.totalTokens',
    resolveRange,
    (queries, range) => queries.spendByModel(range),
    (rows: { inputTokens: number; outputTokens: number }[]) => ({
      value: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
    }),
  );
}

/** breakdown → spend share per model (models with zero cost dropped from the donut). */
export function agentSpendByModelProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.byModel',
    resolveRange,
    (queries, range) => queries.spendByModel(range),
    (rows: { modelId: string; costUsd: number }[]) => ({
      segments: rows
        .filter((row) => row.costUsd > 0)
        .map((row): BreakdownSegment => ({ label: row.modelId, value: roundCents(row.costUsd) })),
    }),
  );
}

/** table → per-model requests / in+out tokens / cost. */
export function agentModelSpendTableProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.byModelTable',
    resolveRange,
    (queries, range) => queries.spendByModel(range),
    (rows: ModelSpendTableRow[]) => ({
      rows: rows.map((row) => ({ ...row, costUsd: roundCents(row.costUsd) })),
    }),
  );
}

/** timeseries → daily spend + tokens trend. */
export function agentUsageTrendProvider(): DataProvider {
  return governanceProvider(
    'agent.usage.trend',
    resolveRange,
    (queries, range) => queries.usageTrend(range),
    (points: { day: string; costUsd: number; totalTokens: number }[]) => ({
      rows: points.map(
        (point): UsageTrendTableRow => ({
          label: point.day,
          costUsd: roundCents(point.costUsd),
          totalTokens: point.totalTokens,
        }),
      ),
    }),
  );
}

/** table → spend per acting ref (user/tenant). */
export function agentActorSpendTableProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.byActor',
    resolveRange,
    (queries, range) => queries.spendByActor(range),
    (rows: ActorSpendTableRow[]) => ({
      rows: rows.map((row) => ({ ...row, costUsd: roundCents(row.costUsd) })),
    }),
  );
}

/** breakdown → spend share per actor (actors with zero cost dropped). */
export function agentSpendByActorProvider(): DataProvider {
  return governanceProvider(
    'agent.spend.byActorShare',
    resolveRange,
    (queries, range) => queries.spendByActor(range),
    (rows: { actorRef: string; costUsd: number }[]) => ({
      segments: rows
        .filter((row) => row.costUsd > 0)
        .map((row): BreakdownSegment => ({ label: row.actorRef, value: roundCents(row.costUsd) })),
    }),
  );
}

// ── Run reliability ─────────────────────────────────────────────────────────

interface RunAgentTableRow {
  agentName: string;
  runs: number;
  failed: number;
}

interface RunTrendTableRow {
  label: string;
  runs: number;
  failed: number;
}

/** Build a `DataProvider` off ONE range-scoped `runReliability` call + a format step — every
 * reliability stat below reuses the same underlying query. Degrades to zeros when unbound. */
function reliabilityProvider(
  name: string,
  format: (metrics: RunReliabilityLike) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, _ctx: ExtensionContext) {
      const queries = getTelescopeGovernanceQueries();
      const metrics = queries
        ? await queries.runReliability(toToolStatsRange(query))
        : EMPTY_RELIABILITY;
      return format(metrics);
    },
  };
}

/** The slice of `RunReliability` these providers read — kept local so this file doesn't need to
 * import the SPI's full type set just to read six fields. */
interface RunReliabilityLike {
  runs: number;
  successRate: number;
  failed: number;
  avgDurationMs: number | null;
  byAgent?: { agentName: string | null; runs: number; failed: number }[];
  trend?: { day: string; runs: number; failed: number }[];
}

const EMPTY_RELIABILITY: RunReliabilityLike = {
  runs: 0,
  successRate: 0,
  failed: 0,
  avgDurationMs: null,
};

/** `runReliability`'s range is `{ from?, to? }` (both optional), not `resolveRange`'s `{ fromDay, toDay }`
 * (both required) — a panel that omits `fromDay`/`toDay` here means "no lower/upper bound", not "default
 * trailing 30 days", matching what an unscoped reliability query already means on the SPI. */
function toToolStatsRange(query: Record<string, unknown> | undefined): {
  from?: string;
  to?: string;
} {
  const from = query && isIsoDay(query.fromDay) ? query.fromDay : undefined;
  const to = query && isIsoDay(query.toDay) ? query.toDay : undefined;
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** stat → total runs over the range. */
export function agentRunsTotalProvider(): DataProvider {
  return reliabilityProvider('agent.runs.total', (metrics) => ({ value: metrics.runs }));
}

/** stat → completed/total success rate over the range. */
export function agentRunsSuccessRateProvider(): DataProvider {
  return reliabilityProvider('agent.runs.successRate', (metrics) => ({
    value: metrics.successRate,
  }));
}

/** stat → failed run count over the range. */
export function agentRunsFailedProvider(): DataProvider {
  return reliabilityProvider('agent.runs.failed', (metrics) => ({ value: metrics.failed }));
}

/**
 * stat → MEAN settled-run duration over the range. Not a percentile: `RunReliability` exposes only
 * `avgDurationMs` (see this file's header) — there is no p50/p95 to select between, unlike the Nest
 * reference's `query.metric` switch. `null` (no settled runs) resolves to 0.
 */
export function agentRunsDurationProvider(): DataProvider {
  return reliabilityProvider('agent.runs.duration', (metrics) => ({
    value: metrics.avgDurationMs ?? 0,
  }));
}

/** table → run/failure rollup per agent (empty when the adapter predates `byAgent`). */
export function agentRunsByAgentTableProvider(): DataProvider {
  return reliabilityProvider('agent.runs.byAgent', (metrics) => ({
    rows: (metrics.byAgent ?? []).map(
      (row): RunAgentTableRow => ({
        agentName: row.agentName ?? NO_VALUE,
        runs: row.runs,
        failed: row.failed,
      }),
    ),
  }));
}

/** timeseries → daily runs + failures trend (empty when the adapter predates `trend`). */
export function agentRunsTrendProvider(): DataProvider {
  return reliabilityProvider('agent.runs.trend', (metrics) => ({
    rows: (metrics.trend ?? []).map(
      (point): RunTrendTableRow => ({ label: point.day, runs: point.runs, failed: point.failed }),
    ),
  }));
}

// ── Recent activity + approvals inbox ───────────────────────────────────────

interface RecentRunTableRow {
  startedAt: string;
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string;
  status: string;
  durationMs: number | string;
  stepCount: number;
  costUsd: number | string;
  error: string;
}

/** The slice of `RunSummaryRow` this table reads. */
interface RunSummaryRowLike {
  startedAt: string;
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string | null;
  status: string;
  durationMs: number | null;
  stepCount: number;
  costUsd: number | null;
  error: string | null;
}

/** table → most recent runs (newest first), via `listRuns`' first page — see this file's header for
 * why this isn't the paged-table protocol. errorMessage capped per {@link capErrorMessage}. */
export function agentRecentRunsTableProvider(): DataProvider {
  return {
    name: 'agent.runs.recent',
    async resolve(query, _ctx: ExtensionContext) {
      const queries = getTelescopeGovernanceQueries();
      if (!queries) return { rows: [] };
      const limit = resolveLimit(query, DEFAULT_RECENT_LIMIT);
      const { runs } = await queries.listRuns({ limit });
      return {
        rows: runs.map(
          (row: RunSummaryRowLike): RecentRunTableRow => ({
            startedAt: row.startedAt,
            runId: row.runId,
            threadId: row.threadId,
            actorRef: row.actorRef,
            agentName: row.agentName ?? NO_VALUE,
            status: row.status,
            durationMs: row.durationMs ?? NO_VALUE,
            stepCount: row.stepCount,
            costUsd: row.costUsd ?? NO_VALUE,
            error: capErrorMessage(row.error),
          }),
        ),
      };
    },
  };
}

/** table → most recent tool calls (newest first), from the durable read-model. */
export function agentRecentToolCallsTableProvider(): DataProvider {
  return governanceProvider(
    'agent.tools.recent',
    (query) => resolveLimit(query, DEFAULT_RECENT_LIMIT),
    (queries, limit) => queries.recentToolCalls(limit),
    (rows) => ({ rows }),
  );
}

/** table → most recently active threads, with rolled-up message/token counts. */
export function agentRecentThreadsTableProvider(): DataProvider {
  return governanceProvider(
    'agent.threads.recent',
    (query) => resolveLimit(query, DEFAULT_RECENT_LIMIT),
    (queries, limit) => queries.recentThreads(limit),
    (rows) => ({ rows }),
  );
}

interface PendingApprovalTableRow {
  toolCallId: string;
  toolName: string;
  threadId: string;
  actorRef: string;
  requestedAt: string;
  runId: string | null;
}

/**
 * stat → an APPROXIMATE count of tool calls sitting `pending_approval`, capped at
 * {@link MAX_RECENT_LIMIT}. `AgentGovernanceQueries.pendingApprovals` has no `total` — unlike the
 * Nest reference's exact `approvalsPage({ page: 1, pageSize: 1 }).total`, there is no cheap "how
 * many, without listing them" query on this SPI (see this file's header). A backlog past the cap
 * undercounts here exactly the way Nest's OLD `pendingApprovals(500).length` did before it got an
 * exact query — that regression is accepted, not fixed, until `AgentGovernanceQueries` grows one.
 */
export function agentPendingApprovalsCountProvider(): DataProvider {
  return {
    name: 'agent.approvals.pending',
    async resolve(_query, _ctx: ExtensionContext) {
      const queries = getTelescopeGovernanceQueries();
      if (!queries) return { value: 0 };
      const rows = await queries.pendingApprovals({ limit: MAX_RECENT_LIMIT });
      return { value: rows.length };
    },
  };
}

/** table → the pending-approvals inbox, oldest request first. */
export function agentPendingApprovalsTableProvider(): DataProvider {
  return governanceProvider(
    'agent.approvals.recent',
    (query) => resolveLimit(query, DEFAULT_RECENT_LIMIT),
    (queries, limit) => queries.pendingApprovals({ limit }),
    (
      rows: {
        toolCallId: string;
        toolName: string;
        threadId: string;
        actorRef: string;
        requestedAt: string;
        runId: string | null;
      }[],
    ) => ({
      rows: rows.map(
        (row): PendingApprovalTableRow => ({
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          threadId: row.threadId,
          actorRef: row.actorRef,
          requestedAt: row.requestedAt,
          runId: row.runId,
        }),
      ),
    }),
  );
}

interface ToolStatTableRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  avgDurationMs: number | string;
}

/** table → per-tool call/failure/rejection/latency rollup over the range. Only ONE latency column
 * (`avgDurationMs`) — `PerToolStatRow` has no p50/p95 split, unlike the Nest reference's table. */
export function agentToolStatsTableProvider(): DataProvider {
  return governanceProvider(
    'agent.tools.stats',
    toToolStatsRange,
    (queries, range) => queries.perToolStats(range),
    (
      rows: {
        toolName: string;
        toolType: string;
        calls: number;
        failed: number;
        rejected: number;
        avgDurationMs: number | null;
      }[],
    ) => ({
      rows: rows.map(
        (row): ToolStatTableRow => ({
          toolName: row.toolName,
          toolType: row.toolType,
          calls: row.calls,
          failed: row.failed,
          rejected: row.rejected,
          avgDurationMs: row.avgDurationMs ?? NO_VALUE,
        }),
      ),
    }),
  );
}
