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
  RunMessageRow,
  RunReliability,
  RunSummaryRow,
  RunToolCallRow,
  RunTrendPoint,
  RunUsageRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  ToolStatsRange,
  UsageTrendPoint,
} from '../spi/governance-queries.js';
import type { AgentPricingStore, CurrentModelPrice } from '../spi/pricing-store.js';
import { estimateCost } from '../spi/pricing-store.js';
import type { LucidDatabaseLike } from './lucid.js';
import { AGENT_TABLES, ensureAgentTables } from './lucid-schema.js';

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** The `agent_token_usage` shape the aggregations bucket over, normalized off the raw Lucid row. */
interface UsageRow {
  modelId: string;
  actorRef: string;
  threadId: string;
  /** UTC day (`YYYY-MM-DD`) derived from `created_at` (epoch-ms), matching the store's day semantics. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
}

/** Parse a TEXT JSON column back to a value; `undefined` for null/empty/malformed. */
function parseJsonCol(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Default page size + hard cap, mirroring the governance routes' clamp. */
function clampLimit(limit: number | undefined, fallback = 50): number {
  const value =
    limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback;
  return Math.min(value, 200);
}

/** Optional inclusive UTC-day bounds → epoch-ms; each side `undefined` when unbounded. */
function optionalDayBounds(range: ToolStatsRange | undefined): {
  start: number | undefined;
  end: number | undefined;
} {
  return {
    start: range?.from !== undefined ? Date.parse(`${range.from}T00:00:00.000Z`) : undefined,
    end: range?.to !== undefined ? Date.parse(`${range.to}T23:59:59.999Z`) : undefined,
  };
}

/** Options for {@link LucidGovernanceQueries}. */
export interface LucidGovernanceQueriesOptions {
  /**
   * Provision the shared agent tables on first use. Default `true` (the ecosystem convention). The
   * read-model aggregates the six shared tables; auto-provisioning here is what lets the governance
   * routes / dashboard answer on a fresh deploy before the first agent run. Set `false` for the migration.
   */
  autoCreateTables?: boolean;
}

/** Map a raw `agent_run` Lucid row to the read-model {@link RunSummaryRow}. */
function runRowToSummary(row: Record<string, unknown>): RunSummaryRow {
  const startedAt = toInt(row.started_at);
  const finishedAtRaw = row.finished_at;
  const finishedAt =
    finishedAtRaw === null || finishedAtRaw === undefined ? null : toInt(finishedAtRaw);
  return {
    runId: String(row.id),
    threadId: String(row.thread_id),
    actorRef: String(row.actor_ref),
    tenantRef:
      row.tenant_ref === null || row.tenant_ref === undefined ? null : String(row.tenant_ref),
    agentName:
      row.agent_name === null || row.agent_name === undefined ? null : String(row.agent_name),
    status: String(row.status),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
    durationMs: finishedAt === null ? null : finishedAt - startedAt,
    stepCount: toInt(row.step_count),
    inputTokens: toInt(row.input_tokens),
    outputTokens: toInt(row.output_tokens),
    costUsd: toNumOrNull(row.cost_usd),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    durable: toInt(row.durable) !== 0,
  };
}

/** Map a raw `agent_tool_call` Lucid row to the read-model {@link RunToolCallRow}. */
function toolCallRowToDetail(row: Record<string, unknown>): RunToolCallRow {
  return {
    toolCallId: String(row.id),
    toolName: String(row.tool_name),
    toolType: String(row.tool_type),
    status: String(row.status),
    input: parseJsonCol(row.input),
    output: parseJsonCol(row.output),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    executionMs: toNumOrNull(row.execution_ms),
    createdAt: new Date(toInt(row.created_at)).toISOString(),
  };
}

function rowToUsage(row: Record<string, unknown>): UsageRow {
  return {
    modelId: String(row.model_id),
    actorRef: String(row.actor_ref),
    threadId: String(row.thread_id),
    day: new Date(toInt(row.created_at)).toISOString().slice(0, 10),
    inputTokens: toInt(row.input_tokens),
    outputTokens: toInt(row.output_tokens),
    cacheWriteTokens: toNumOrNull(row.cache_write_tokens),
    cacheReadTokens: toNumOrNull(row.cache_read_tokens),
    costUsd: toNumOrNull(row.cost_usd),
  };
}

/**
 * A production {@link AgentGovernanceQueries} — the read/analytics half of the store SPI — backed by
 * AdonisJS **Lucid** (Knex) over the same five agent tables {@link import('./lucid.js').LucidAgentStore}
 * writes. Like the store it touches only the structural {@link LucidDatabaseLike} slice, so
 * `@adonisjs/lucid` stays an *optional peer* (the factory casts the real `db` in).
 *
 * Cost is the token ledger priced against the current prices from the injected {@link AgentPricingStore}
 * (fetched once per query, exactly like the Drizzle/MikroORM references and the loop's cost fold), so a
 * host that binds its own pricing store controls the cost every governance surface reports. A
 * provider-reported `cost_usd` on a usage row always wins; an unpriced model contributes 0 cost (its
 * tokens still count). Omit the pricing store entirely for a zero-cost read-model. Aggregation is
 * in-process (like `quotaToday`) so UTC-day bucketing stays dialect-portable across SQLite/Postgres/MySQL
 * — the behavioral twin of {@link import('../testing/in-memory-governance-queries.js').InMemoryGovernanceQueries}.
 */
export class LucidGovernanceQueries implements AgentGovernanceQueries {
  private readonly autoCreateTables: boolean;

  constructor(
    private readonly db: LucidDatabaseLike,
    private readonly pricingStore?: AgentPricingStore,
    options: LucidGovernanceQueriesOptions = {},
  ) {
    this.autoCreateTables = options.autoCreateTables ?? true;
  }

  /** Provision the shared schema on first use (no-op when disabled), memoized across the stores. */
  private ready(): Promise<void> {
    return this.autoCreateTables ? ensureAgentTables(this.db) : Promise.resolve();
  }

  private async loadPricing(): Promise<Map<string, CurrentModelPrice>> {
    const pricing = new Map<string, CurrentModelPrice>();
    if (this.pricingStore === undefined) return pricing;
    for (const price of await this.pricingStore.listCurrentPrices()) {
      pricing.set(price.modelId, price);
    }
    return pricing;
  }

  /** Provider-reported cost wins per row; otherwise the cache-aware token estimate (0 when unpriced). */
  private rowCost(row: UsageRow, pricing: ReadonlyMap<string, CurrentModelPrice>): number {
    if (row.costUsd !== null) return row.costUsd;
    const price = pricing.get(row.modelId);
    if (price === undefined) return 0;
    return estimateCost(
      {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        ...(row.cacheWriteTokens !== null ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
        ...(row.cacheReadTokens !== null ? { cacheReadTokens: row.cacheReadTokens } : {}),
      },
      price,
    );
  }

  /** The usage ledger rows whose `created_at` falls inside the inclusive UTC-day range. */
  private async usageInRange(range: GovernanceRange): Promise<UsageRow[]> {
    const start = Date.parse(`${range.fromDay}T00:00:00.000Z`);
    const end = Date.parse(`${range.toDay}T23:59:59.999Z`);
    const rows = await this.db
      .from(AGENT_TABLES.tokenUsage)
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select('*');
    return rows.map(rowToUsage);
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    await this.ready();
    const pricing = await this.loadPricing();
    const byModel = new Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
    >();
    for (const row of await this.usageInRange(range)) {
      const bucket = byModel.get(row.modelId) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      bucket.requests += 1;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.costUsd += this.rowCost(row, pricing);
      byModel.set(row.modelId, bucket);
    }
    const result: ModelSpendRow[] = [];
    for (const [modelId, bucket] of byModel) {
      result.push({ modelId, ...bucket });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.modelId.localeCompare(right.modelId),
    );
    return result;
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    await this.ready();
    const pricing = await this.loadPricing();
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const row of await this.usageInRange(range)) {
      const bucket = byActor.get(row.actorRef) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row, pricing);
      byActor.set(row.actorRef, bucket);
    }
    const result: ActorSpendRow[] = [];
    for (const [actorRef, bucket] of byActor) {
      result.push({ actorRef, ...bucket });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.actorRef.localeCompare(right.actorRef),
    );
    return result;
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    await this.ready();
    const pricing = await this.loadPricing();
    const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
    for (const row of await this.usageInRange(range)) {
      const bucket = byDay.get(row.day) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row, pricing);
      byDay.set(row.day, bucket);
    }
    const result: UsageTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  /**
   * Newest-first recent tool calls, capped at `limit`. Resolves each call's `threadId` through its
   * owning message (the structural query slice has no `join`, so it's one lookup per call — bounded by
   * `limit`, mirroring the reference adapters' N+1 for the recent feeds).
   */
  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    await this.ready();
    const calls = await this.db
      .from(AGENT_TABLES.toolCalls)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('*');
    const result: ToolCallActivityRow[] = [];
    for (const call of calls) {
      const message = await this.db
        .from(AGENT_TABLES.messages)
        .where('id', String(call.message_id))
        .first();
      result.push({
        toolCallId: String(call.id),
        toolName: String(call.tool_name),
        toolType: String(call.tool_type),
        status: String(call.status),
        threadId: message === null || message === undefined ? '' : String(message.thread_id),
        createdAt: new Date(toInt(call.created_at)).toISOString(),
      });
    }
    return result;
  }

  /**
   * Newest-first recent threads (soft-deleted excluded, mirroring `listThreads`/the reference), each
   * with its message count and rolled-up token total, capped at `limit`.
   */
  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    await this.ready();
    const threads = await this.db
      .from(AGENT_TABLES.threads)
      .whereNull('deleted_at')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .select('*');
    const result: ThreadActivityRow[] = [];
    for (const thread of threads) {
      const threadId = String(thread.id);
      const messages = await this.db
        .from(AGENT_TABLES.messages)
        .where('thread_id', threadId)
        .select('id');
      const usageRows = await this.db
        .from(AGENT_TABLES.tokenUsage)
        .where('thread_id', threadId)
        .select('input_tokens', 'output_tokens');
      const totalTokens = usageRows.reduce(
        (sum, row) => sum + toInt(row.input_tokens) + toInt(row.output_tokens),
        0,
      );
      result.push({
        threadId,
        title: String(thread.title),
        actorRef: String(thread.actor_ref),
        messageCount: messages.length,
        totalTokens,
        lastActivityAt: new Date(toInt(thread.updated_at)).toISOString(),
      });
    }
    return result;
  }

  // ── Run lifecycle read-model ───────────────────────────────────────────────

  /**
   * Filterable, cursor-paginated run list, newest-first (`started_at` desc, then `id` desc for a
   * stable tiebreak). The cursor is an opaque offset (over the SAME filter set); a page fetches
   * `limit + 1` rows to learn whether a next page exists. A store without recorded runs yields an
   * empty page.
   */
  async listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    await this.ready();
    const limit = clampLimit(filter.limit);
    const offset = ((): number => {
      const parsed = filter.cursor !== undefined ? Number.parseInt(filter.cursor, 10) : 0;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })();

    let query = this.db.from(AGENT_TABLES.runs);
    if (filter.actor !== undefined) query = query.where('actor_ref', filter.actor);
    if (filter.agent !== undefined) query = query.where('agent_name', filter.agent);
    if (filter.status !== undefined) query = query.where('status', filter.status);
    if (filter.from !== undefined) {
      query = query.where('started_at', '>=', Date.parse(`${filter.from}T00:00:00.000Z`));
    }
    if (filter.to !== undefined) {
      query = query.where('started_at', '<=', Date.parse(`${filter.to}T23:59:59.999Z`));
    }
    const rows = await query
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .offset(offset)
      .select('*');

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      runs: page.map(runRowToSummary),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  }

  /**
   * The full trace of one run: the run row plus every message / tool call / usage row stamped with
   * its `run_id` (oldest first), and the subset of tool calls still `pending_approval`. `null` when
   * the run is unknown.
   */
  async runDetail(runId: string): Promise<RunDetail | null> {
    await this.ready();
    const runRow = await this.db.from(AGENT_TABLES.runs).where('id', runId).first();
    if (runRow === null || runRow === undefined) return null;

    const messageRows = await this.db
      .from(AGENT_TABLES.messages)
      .where('run_id', runId)
      .orderBy('created_at', 'asc')
      .select('*');
    const toolCallRows = await this.db
      .from(AGENT_TABLES.toolCalls)
      .where('run_id', runId)
      .orderBy('created_at', 'asc')
      .select('*');
    const usageRows = await this.db
      .from(AGENT_TABLES.tokenUsage)
      .where('run_id', runId)
      .orderBy('created_at', 'asc')
      .select('*');

    const messages: RunMessageRow[] = messageRows.map((row) => ({
      id: String(row.id),
      role: String(row.role),
      content: String(row.content),
      createdAt: new Date(toInt(row.created_at)).toISOString(),
    }));
    const toolCalls = toolCallRows.map(toolCallRowToDetail);
    const usage: RunUsageRow[] = usageRows.map((row) => ({
      modelId: String(row.model_id),
      purpose: String(row.purpose),
      inputTokens: toInt(row.input_tokens),
      outputTokens: toInt(row.output_tokens),
      costUsd: toNumOrNull(row.cost_usd),
      createdAt: new Date(toInt(row.created_at)).toISOString(),
    }));
    return {
      run: runRowToSummary(runRow),
      messages,
      toolCalls,
      approvals: toolCalls.filter((call) => call.status === 'pending_approval'),
      usage,
    };
  }

  /**
   * Tool calls sitting `pending_approval`, oldest first (an inbox drains from the back). Each call's
   * owning actor is resolved through its run (`run_id → agent_run.actor_ref`), falling back to its
   * thread (`message → agent_thread.actor_ref`) for a call recorded before run tracking. The `actor`
   * filter is applied after resolution; `limit` caps the returned inbox.
   */
  async pendingApprovals(filter: PendingApprovalsFilter = {}): Promise<PendingApprovalRow[]> {
    await this.ready();
    const limit = clampLimit(filter.limit);
    const calls = await this.db
      .from(AGENT_TABLES.toolCalls)
      .where('status', 'pending_approval')
      .orderBy('created_at', 'asc')
      .select('*');
    const result: PendingApprovalRow[] = [];
    for (const call of calls) {
      const message = await this.db
        .from(AGENT_TABLES.messages)
        .where('id', String(call.message_id))
        .first();
      const threadId = message === null || message === undefined ? '' : String(message.thread_id);
      const runId =
        call.run_id !== null && call.run_id !== undefined
          ? String(call.run_id)
          : message?.run_id !== null && message?.run_id !== undefined
            ? String(message.run_id)
            : null;
      let actorRef = '';
      if (runId !== null) {
        const run = await this.db.from(AGENT_TABLES.runs).where('id', runId).first();
        if (run !== null && run !== undefined) actorRef = String(run.actor_ref);
      }
      if (actorRef === '' && threadId !== '') {
        const thread = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
        if (thread !== null && thread !== undefined) actorRef = String(thread.actor_ref);
      }
      if (filter.actor !== undefined && actorRef !== filter.actor) continue;
      result.push({
        toolCallId: String(call.id),
        toolName: String(call.tool_name),
        input: parseJsonCol(call.input),
        threadId,
        runId,
        actorRef,
        requestedAt: new Date(toInt(call.created_at)).toISOString(),
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Per-tool call/failure/rejection/latency rollup over the (optional) range, highest call count
   * first. `avgDurationMs` is the mean `execution_ms` across calls that recorded one; `null` when
   * none did.
   */
  async perToolStats(range: ToolStatsRange = {}): Promise<PerToolStatRow[]> {
    await this.ready();
    const { start, end } = optionalDayBounds(range);
    let query = this.db.from(AGENT_TABLES.toolCalls);
    if (start !== undefined) query = query.where('created_at', '>=', start);
    if (end !== undefined) query = query.where('created_at', '<=', end);
    const calls = await query.select('*');

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
    for (const call of calls) {
      const toolName = String(call.tool_name);
      const toolType = String(call.tool_type);
      const key = `${toolName} ${toolType}`;
      const bucket = byTool.get(key) ?? {
        toolName,
        toolType,
        calls: 0,
        failed: 0,
        rejected: 0,
        durationSum: 0,
        durationCount: 0,
      };
      bucket.calls += 1;
      if (String(call.status) === 'failed') bucket.failed += 1;
      if (String(call.status) === 'rejected') bucket.rejected += 1;
      const execMs = toNumOrNull(call.execution_ms);
      if (execMs !== null) {
        bucket.durationSum += execMs;
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

  /**
   * Success / failure / cancel rates + mean settled-run duration over the (optional) range, bucketed
   * on `started_at`, plus a per-agent breakdown and a daily runs/failed trend over the same rows. A
   * store without recorded runs yields all zeros / `null` duration / empty breakdown+trend.
   */
  async runReliability(range: ToolStatsRange = {}): Promise<RunReliability> {
    await this.ready();
    const { start, end } = optionalDayBounds(range);
    let query = this.db.from(AGENT_TABLES.runs);
    if (start !== undefined) query = query.where('started_at', '>=', start);
    if (end !== undefined) query = query.where('started_at', '<=', end);
    const runs = await query.select('*');

    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let running = 0;
    let durationSum = 0;
    let durationCount = 0;
    const byAgent = new Map<string | null, { runs: number; failed: number; completed: number }>();
    const byDay = new Map<string, { runs: number; failed: number }>();
    for (const run of runs) {
      const status = String(run.status);
      if (status === 'completed') completed += 1;
      else if (status === 'failed') failed += 1;
      else if (status === 'cancelled') cancelled += 1;
      else running += 1;
      const finishedAt = run.finished_at;
      if (status !== 'running' && finishedAt !== null && finishedAt !== undefined) {
        durationSum += toInt(finishedAt) - toInt(run.started_at);
        durationCount += 1;
      }

      const agentName =
        run.agent_name === null || run.agent_name === undefined ? null : String(run.agent_name);
      const agentBucket = byAgent.get(agentName) ?? { runs: 0, failed: 0, completed: 0 };
      agentBucket.runs += 1;
      if (status === 'failed') agentBucket.failed += 1;
      if (status === 'completed') agentBucket.completed += 1;
      byAgent.set(agentName, agentBucket);

      const day = new Date(toInt(run.started_at)).toISOString().slice(0, 10);
      const dayBucket = byDay.get(day) ?? { runs: 0, failed: 0 };
      dayBucket.runs += 1;
      if (status === 'failed') dayBucket.failed += 1;
      byDay.set(day, dayBucket);
    }
    const total = runs.length;

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
   * The thread governance drill-down: metadata + a LIFETIME usage rollup (every usage row ever
   * recorded for the thread, not range-scoped) + its most recent runs/messages. `null` when the
   * thread is unknown. Soft-deleted threads still resolve (with `deleted: true`), mirroring
   * `runDetail`'s "the record exists, render it" posture.
   */
  async threadDetail(threadId: string): Promise<GovernanceThreadDetail | null> {
    await this.ready();
    const threadRow = await this.db.from(AGENT_TABLES.threads).where('id', threadId).first();
    if (threadRow === null || threadRow === undefined) return null;

    const pricing = await this.loadPricing();
    const usageRows = await this.db
      .from(AGENT_TABLES.tokenUsage)
      .where('thread_id', threadId)
      .select('*');
    const usage = usageRows.map(rowToUsage);
    const totalTokens = usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const costUsd =
      usage.length === 0 ? null : usage.reduce((sum, row) => sum + this.rowCost(row, pricing), 0);

    const runRows = await this.db
      .from(AGENT_TABLES.runs)
      .where('thread_id', threadId)
      .orderBy('started_at', 'desc')
      .limit(20)
      .select('*');
    const messageRows = await this.db
      .from(AGENT_TABLES.messages)
      .where('thread_id', threadId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .select('*');
    const allRunIds = await this.db
      .from(AGENT_TABLES.runs)
      .where('thread_id', threadId)
      .select('id');
    const allMessageIds = await this.db
      .from(AGENT_TABLES.messages)
      .where('thread_id', threadId)
      .select('id');

    return {
      threadId: String(threadRow.id),
      title: String(threadRow.title),
      actorRef: String(threadRow.actor_ref),
      createdAt: new Date(toInt(threadRow.created_at)).toISOString(),
      updatedAt: new Date(toInt(threadRow.updated_at)).toISOString(),
      deleted: threadRow.deleted_at !== null && threadRow.deleted_at !== undefined,
      usage: {
        totalTokens,
        costUsd,
        runCount: allRunIds.length,
        messageCount: allMessageIds.length,
      },
      runs: runRows.map(runRowToSummary),
      messages: messageRows.map((row) => ({
        id: String(row.id),
        role: String(row.role),
        content: String(row.content),
        createdAt: new Date(toInt(row.created_at)).toISOString(),
      })),
    };
  }
}
