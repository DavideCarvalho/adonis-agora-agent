import { type GenuiCallRow, type GenuiStats, summarizeGenuiCalls } from '../genui-telemetry.js';
import { summarizeLatency, summarizeRunMetrics } from '../run-metrics.js';
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
import { estimateCost, resolveModelPrice } from '../spi/pricing-store.js';
import { inAppendOrder, type LucidDatabaseLike, toolCallIdOfRow } from './lucid.js';
import { AGENT_TABLES, ensureAgentTables, rowsOf } from './lucid-schema.js';
import { portableSql } from './sql-dialect.js';

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

/** A stored `agent_genui_call` row as the aggregation reads it (NULL → absent). */
function genuiCallRow(row: Record<string, unknown>): GenuiCallRow {
  const text = (value: unknown) =>
    value === null || value === undefined ? undefined : String(value);
  const num = (value: unknown) => {
    const parsed = toNumOrNull(value);
    return parsed === null ? undefined : parsed;
  };
  const agentName = text(row.agent_name);
  const errorCategory = text(row.error_category);
  const errorMessage = text(row.error_message);
  const costUsd = num(row.cost_usd);
  const costSource = text(row.cost_source);
  const firstFrameMs = num(row.first_frame_ms);
  const completeFrameMs = num(row.complete_frame_ms);
  const payload = text(row.payload);
  return {
    toolCallId: String(row.id),
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    actorRef: String(row.actor_ref),
    ...(agentName !== undefined ? { agentName } : {}),
    step: Number(row.step),
    toolName: String(row.tool_name),
    channel: String(row.channel),
    mode: String(row.mode) as GenuiCallRow['mode'],
    modelId: String(row.model_id),
    attempt: Number(row.attempt),
    outcome: String(row.outcome) as GenuiCallRow['outcome'],
    validity: String(row.validity) as GenuiCallRow['validity'],
    ...(errorCategory !== undefined
      ? { errorCategory: errorCategory as NonNullable<GenuiCallRow['errorCategory']> }
      : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costSource !== undefined ? { costSource: costSource as 'provider' | 'estimate' } : {}),
    ...(firstFrameMs !== undefined ? { firstFrameMs } : {}),
    ...(completeFrameMs !== undefined ? { completeFrameMs } : {}),
    payloadBytes: Number(row.payload_bytes),
    ...(payload !== undefined ? { payload } : {}),
    createdAt: new Date(Number(row.created_at)),
  };
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

function toStrOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * `agent_token_usage` summed per model (and per bucket — an actor, a UTC day — when one was asked
 * for). The tokens of the rows WITHOUT a provider-reported cost are summed apart, so the estimate
 * for them is the same sum of per-row estimates the price list would give (an estimate is linear in
 * the tokens).
 */
interface UsageGroup {
  modelId: string;
  /** The bucket's key: an actor ref, or a UTC day (`YYYY-MM-DD`). `''` when not bucketed. */
  bucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the provider-reported costs (rows without one add nothing). */
  reportedCostUsd: number;
  unreported: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}

/** A UTC day in epoch ms, as SQL every dialect evaluates the same: the start of `created_at`'s day. */
const DAY_START_SQL = `"created_at" - ("created_at" % 86400000)`;

/** The message columns a run trace or thread drill-down reports (see `RunMessageRow`). */
const TRACE_MESSAGE_COLUMNS = ['id', 'role', 'content', 'created_at'] as const;

/** Statement-sized slices of an `IN (…)` list. */
function chunked<T>(values: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/** Parse a TEXT JSON column back to a value; `undefined` for null/empty/malformed. */
function parseJsonCol(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A pending call's owning actor in {@link LucidGovernanceQueries.pendingApprovals}'s join: the run's,
 * else (an unknown run, or one with no actor) the thread's, else `''`.
 */
const PENDING_ACTOR_SQL = `COALESCE(NULLIF(r."actor_ref", ''), th."actor_ref", '')`;

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
    parentRunId:
      row.parent_run_id === null || row.parent_run_id === undefined
        ? null
        : String(row.parent_run_id),
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
    ttftMs: toNumOrNull(row.ttft_ms),
    errorCode: toStrOrNull(row.error_code),
    modelId: toStrOrNull(row.model_id),
  };
}

/** Map a raw `agent_tool_call` Lucid row to the read-model {@link RunToolCallRow}. */
function toolCallRowToDetail(row: Record<string, unknown>): RunToolCallRow {
  return {
    toolCallId: toolCallIdOfRow(row),
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
 * tokens still count). Omit the pricing store entirely for a zero-cost read-model. Usage is summed in
 * the database, per model, with UTC days bucketed by integer arithmetic on the epoch-ms `created_at`
 * (the same on SQLite/Postgres/MySQL), and priced here — the behavioral twin of
 * {@link import('../testing/in-memory-governance-queries.js').InMemoryGovernanceQueries}.
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

  /** Provision the shared schema now (what the agent provider calls at app start). Idempotent. */
  ensureSchema(): Promise<void> {
    return this.ready();
  }

  private async loadPricing(): Promise<Map<string, CurrentModelPrice>> {
    const pricing = new Map<string, CurrentModelPrice>();
    if (this.pricingStore === undefined) return pricing;
    for (const price of await this.pricingStore.listCurrentPrices()) {
      pricing.set(price.modelId, price);
    }
    return pricing;
  }

  /**
   * Provider-reported cost wins per row; the rest are priced by the cache-aware token estimate (0
   * when the model is unpriced).
   */
  private groupCost(group: UsageGroup, pricing: ReadonlyMap<string, CurrentModelPrice>): number {
    const price = resolveModelPrice(pricing, group.modelId);
    if (price === undefined) return group.reportedCostUsd;
    return group.reportedCostUsd + estimateCost(group.unreported, price);
  }

  /**
   * The usage ledger summed in the database — per model, and per `by` when given — over the
   * inclusive UTC-day `range` and/or one thread. A dashboard's ranges span every row of a month or
   * more; summing them is the database's job, not a page of rows shipped to the process per chart.
   */
  private async usageGroups(
    filter: { range?: GovernanceRange; threadId?: string },
    by?: 'actor' | 'day',
  ): Promise<UsageGroup[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (filter.range !== undefined) {
      where.push(`"created_at" >= ?`, `"created_at" <= ?`);
      bindings.push(
        Date.parse(`${filter.range.fromDay}T00:00:00.000Z`),
        Date.parse(`${filter.range.toDay}T23:59:59.999Z`),
      );
    }
    if (filter.threadId !== undefined) {
      where.push(`"thread_id" = ?`);
      bindings.push(filter.threadId);
    }
    const bucket = by === 'actor' ? `"actor_ref"` : by === 'day' ? DAY_START_SQL : undefined;
    const unreported = (column: string) =>
      `SUM(CASE WHEN "cost_usd" IS NULL THEN COALESCE("${column}", 0) ELSE 0 END)`;
    const rows = rowsOf(
      await this.db.rawQuery(
        portableSql(
          this.db,
          `SELECT "model_id" AS model_id, ${bucket !== undefined ? `${bucket} AS bucket, ` : ''}` +
            `COUNT(*) AS requests, SUM("input_tokens") AS input_tokens, ` +
            `SUM("output_tokens") AS output_tokens, SUM("cost_usd") AS reported_cost, ` +
            `${unreported('input_tokens')} AS unreported_input, ` +
            `${unreported('output_tokens')} AS unreported_output, ` +
            `${unreported('cache_write_tokens')} AS unreported_cache_write, ` +
            `${unreported('cache_read_tokens')} AS unreported_cache_read ` +
            `FROM "${AGENT_TABLES.tokenUsage}"` +
            (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
            ` GROUP BY "model_id"${bucket !== undefined ? `, ${bucket}` : ''}`,
        ),
        bindings,
      ),
    );
    return rows.map((row) => ({
      modelId: String(row.model_id),
      bucket:
        by === 'day'
          ? new Date(toInt(row.bucket)).toISOString().slice(0, 10)
          : by === 'actor'
            ? String(row.bucket)
            : '',
      requests: toInt(row.requests),
      inputTokens: toInt(row.input_tokens),
      outputTokens: toInt(row.output_tokens),
      reportedCostUsd: toNumOrNull(row.reported_cost) ?? 0,
      unreported: {
        inputTokens: toInt(row.unreported_input),
        outputTokens: toInt(row.unreported_output),
        cacheWriteTokens: toInt(row.unreported_cache_write),
        cacheReadTokens: toInt(row.unreported_cache_read),
      },
    }));
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    await this.ready();
    const pricing = await this.loadPricing();
    const result: ModelSpendRow[] = (await this.usageGroups({ range })).map((group) => ({
      modelId: group.modelId,
      requests: group.requests,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      costUsd: this.groupCost(group, pricing),
    }));
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.modelId.localeCompare(right.modelId),
    );
    return result;
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    await this.ready();
    const pricing = await this.loadPricing();
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const group of await this.usageGroups({ range }, 'actor')) {
      const bucket = byActor.get(group.bucket) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += group.requests;
      bucket.totalTokens += group.inputTokens + group.outputTokens;
      bucket.costUsd += this.groupCost(group, pricing);
      byActor.set(group.bucket, bucket);
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
    for (const group of await this.usageGroups({ range }, 'day')) {
      const bucket = byDay.get(group.bucket) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += group.inputTokens + group.outputTokens;
      bucket.costUsd += this.groupCost(group, pricing);
      byDay.set(group.bucket, bucket);
    }
    const result: UsageTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  /** `thread_id → value` for one aggregate over `table`'s rows of `threadIds`. */
  private async perThread(
    table: string,
    aggregate: string,
    threadIds: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const chunk of chunked(threadIds)) {
      const rows = rowsOf(
        await this.db.rawQuery(
          portableSql(
            this.db,
            `SELECT "thread_id" AS thread_id, ${aggregate} AS value FROM "${table}" ` +
              `WHERE "thread_id" IN (${placeholders(chunk)}) GROUP BY "thread_id"`,
          ),
          chunk,
        ),
      );
      for (const row of rows) out.set(String(row.thread_id), toInt(row.value));
    }
    return out;
  }

  /** How many of `table`'s rows belong to `threadId`. */
  private async countForThread(table: string, threadId: string): Promise<number> {
    const [row] = rowsOf(
      await this.db.rawQuery(
        portableSql(this.db, `SELECT COUNT(*) AS n FROM "${table}" WHERE "thread_id" = ?`),
        [threadId],
      ),
    );
    return toInt(row?.n);
  }

  /**
   * Newest-first recent tool calls, capped at `limit`. Each call's `threadId` is its owning
   * message's, read for the whole page at once.
   */
  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    await this.ready();
    const calls = await this.db
      .from(AGENT_TABLES.toolCalls)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('*');
    const threadOf = new Map<string, string>();
    const messageIds = [...new Set(calls.map((call) => String(call.message_id)))];
    for (const chunk of chunked(messageIds)) {
      const messages = await this.db
        .from(AGENT_TABLES.messages)
        .whereIn('id', chunk)
        .select('id', 'thread_id');
      for (const message of messages) threadOf.set(String(message.id), String(message.thread_id));
    }
    return calls.map((call) => ({
      toolCallId: toolCallIdOfRow(call),
      toolName: String(call.tool_name),
      toolType: String(call.tool_type),
      status: String(call.status),
      threadId: threadOf.get(String(call.message_id)) ?? '',
      createdAt: new Date(toInt(call.created_at)).toISOString(),
    }));
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
    const threadIds = threads.map((thread) => String(thread.id));
    const messageCounts = await this.perThread(AGENT_TABLES.messages, 'COUNT(*)', threadIds);
    const tokenTotals = await this.perThread(
      AGENT_TABLES.tokenUsage,
      'SUM("input_tokens" + "output_tokens")',
      threadIds,
    );
    return threads.map((thread) => {
      const threadId = String(thread.id);
      return {
        threadId,
        title: String(thread.title),
        actorRef: String(thread.actor_ref),
        messageCount: messageCounts.get(threadId) ?? 0,
        totalTokens: tokenTotals.get(threadId) ?? 0,
        lastActivityAt: new Date(toInt(thread.updated_at)).toISOString(),
      };
    });
  }

  // ── Run lifecycle read-model ───────────────────────────────────────────────

  /**
   * Filterable, cursor-paginated run list, newest-first (`started_at` desc, then `id` desc for a
   * stable tiebreak). `after` is an opaque cursor (over the SAME filter set); a page fetches
   * `first + 1` rows to learn whether a next page exists. A store without recorded runs yields an
   * empty page.
   *
   * Forward-only, so the returned {@link CursorPage} always carries `prevCursor: null` /
   * `hasPrev: false` — see `src/pagination.ts`.
   */
  async listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    await this.ready();
    const limit = clampLimit(filter.first);
    const offset = ((): number => {
      const parsed = filter.after !== undefined ? Number.parseInt(filter.after, 10) : 0;
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
      items: page.map(runRowToSummary),
      nextCursor: hasMore ? String(offset + limit) : null,
      prevCursor: null,
      hasNext: hasMore,
      hasPrev: false,
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

    // Projected to what a trace row shows: a message's tool payloads, reasoning and UI stay put.
    const messageRows = await inAppendOrder(
      this.db.from(AGENT_TABLES.messages).where('run_id', runId),
      'asc',
    ).select(...TRACE_MESSAGE_COLUMNS);
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
   * `FROM … WHERE …` over the calls sitting `pending_approval`, each joined to the actor that owns
   * it: its run's (`run_id`, or its message's, `→ agent_run.actor_ref`), else its thread's
   * (`message → agent_thread.actor_ref`) for a call recorded before run tracking, else `''`. Joined
   * rather than looked up per call, so the `actor` filter runs in the database and an inbox costs
   * one statement however long the backlog.
   */
  private pendingApprovalsFrom(actor: string | undefined): { sql: string; bindings: unknown[] } {
    const t = AGENT_TABLES;
    return {
      sql:
        `FROM "${t.toolCalls}" c ` +
        `LEFT JOIN "${t.messages}" m ON m."id" = c."message_id" ` +
        `LEFT JOIN "${t.runs}" r ON r."id" = COALESCE(c."run_id", m."run_id") ` +
        `LEFT JOIN "${t.threads}" th ON th."id" = m."thread_id" ` +
        `WHERE c."status" = 'pending_approval'` +
        (actor !== undefined ? ` AND ${PENDING_ACTOR_SQL} = ?` : ''),
      bindings: actor !== undefined ? [actor] : [],
    };
  }

  /** Tool calls sitting `pending_approval`, oldest first; `actor` filters, `limit` caps the inbox. */
  async pendingApprovals(filter: PendingApprovalsFilter = {}): Promise<PendingApprovalRow[]> {
    await this.ready();
    const limit = clampLimit(filter.limit);
    const from = this.pendingApprovalsFrom(filter.actor);
    const rows = rowsOf(
      await this.db.rawQuery(
        portableSql(
          this.db,
          `SELECT c.*, m."thread_id" AS pending_thread_id, m."run_id" AS pending_message_run_id, ` +
            `${PENDING_ACTOR_SQL} AS pending_actor_ref ${from.sql} ` +
            `ORDER BY c."created_at" ASC LIMIT ${limit}`,
        ),
        from.bindings,
      ),
    );
    return rows.map((call) => {
      const runId =
        call.run_id !== null && call.run_id !== undefined
          ? String(call.run_id)
          : call.pending_message_run_id !== null && call.pending_message_run_id !== undefined
            ? String(call.pending_message_run_id)
            : null;
      return {
        toolCallId: toolCallIdOfRow(call),
        toolName: String(call.tool_name),
        input: parseJsonCol(call.input),
        threadId:
          call.pending_thread_id === null || call.pending_thread_id === undefined
            ? ''
            : String(call.pending_thread_id),
        runId,
        actorRef: String(call.pending_actor_ref ?? ''),
        requestedAt: new Date(toInt(call.created_at)).toISOString(),
      };
    });
  }

  async countPendingApprovals(filter: Pick<PendingApprovalsFilter, 'actor'> = {}): Promise<number> {
    await this.ready();
    const from = this.pendingApprovalsFrom(filter.actor);
    const [row] = rowsOf(
      await this.db.rawQuery(
        portableSql(this.db, `SELECT COUNT(*) AS n ${from.sql}`),
        from.bindings,
      ),
    );
    return toInt(row?.n);
  }

  /**
   * Per-tool call/failure/rejection/latency rollup over the (optional) range, highest call count
   * first. `avgDurationMs` is the mean `execution_ms` across calls that recorded one; `null` when
   * none did.
   */
  async genuiStats(range: GovernanceRange): Promise<GenuiStats> {
    await this.ready();
    const start = Date.parse(`${range.fromDay}T00:00:00.000Z`);
    const end = Date.parse(`${range.toDay}T23:59:59.999Z`);
    const rows = await this.db
      .from(AGENT_TABLES.genuiCalls)
      .where('created_at', '>=', start)
      .where('created_at', '<=', end)
      .select('*');
    return summarizeGenuiCalls(rows.map(genuiCallRow));
  }

  async perToolStats(range: ToolStatsRange = {}): Promise<PerToolStatRow[]> {
    await this.ready();
    const { start, end } = optionalDayBounds(range);
    let query = this.db.from(AGENT_TABLES.toolCalls);
    if (start !== undefined) query = query.where('created_at', '>=', start);
    if (end !== undefined) query = query.where('created_at', '<=', end);
    // The four columns the stats are built from: every call in the range is read, and its input and
    // output payloads (often the bulk of the row) have no part in a count or a latency.
    const calls = await query.select('tool_name', 'tool_type', 'status', 'execution_ms');

    const byTool = new Map<
      string,
      {
        toolName: string;
        toolType: string;
        calls: number;
        failed: number;
        rejected: number;
        durations: number[];
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
        durations: [],
      };
      bucket.calls += 1;
      if (String(call.status) === 'failed') bucket.failed += 1;
      if (String(call.status) === 'rejected') bucket.rejected += 1;
      const execMs = toNumOrNull(call.execution_ms);
      if (execMs !== null) bucket.durations.push(execMs);
      byTool.set(key, bucket);
    }
    const result: PerToolStatRow[] = [];
    for (const bucket of byTool.values()) {
      const execution = summarizeLatency(bucket.durations);
      result.push({
        toolName: bucket.toolName,
        toolType: bucket.toolType,
        calls: bucket.calls,
        failed: bucket.failed,
        rejected: bucket.rejected,
        avgDurationMs:
          bucket.durations.length === 0
            ? null
            : bucket.durations.reduce((a, b) => a + b, 0) / bucket.durations.length,
        p50ExecutionMs: execution.p50Ms,
        p95ExecutionMs: execution.p95Ms,
      });
    }
    result.sort(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );
    return result;
  }

  /**
   * Success / failure / cancel rates + mean settled-run duration over the (optional) range, bucketed
   * on `started_at`, plus a per-agent breakdown, a daily runs/failed trend, turn latency and failures
   * by code over the same rows. A store without recorded runs yields all zeros / `null` duration /
   * empty breakdown+trend+codes.
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
      ...summarizeRunMetrics(
        runs.map((run) => ({
          status: String(run.status),
          parentRunId: toStrOrNull(run.parent_run_id),
          startedAt: toInt(run.started_at),
          finishedAt:
            run.finished_at === null || run.finished_at === undefined
              ? null
              : toInt(run.finished_at),
          ttftMs: toNumOrNull(run.ttft_ms),
          errorCode: toStrOrNull(run.error_code),
        })),
      ),
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
    const usage = await this.usageGroups({ threadId });
    const totalTokens = usage.reduce(
      (sum, group) => sum + group.inputTokens + group.outputTokens,
      0,
    );
    const costUsd =
      usage.length === 0
        ? null
        : usage.reduce((sum, group) => sum + this.groupCost(group, pricing), 0);

    const runRows = await this.db
      .from(AGENT_TABLES.runs)
      .where('thread_id', threadId)
      .orderBy('started_at', 'desc')
      .limit(20)
      .select('*');
    const messageRows = await inAppendOrder(
      this.db.from(AGENT_TABLES.messages).where('thread_id', threadId),
      'desc',
    )
      .limit(50)
      .select(...TRACE_MESSAGE_COLUMNS);
    const runCount = await this.countForThread(AGENT_TABLES.runs, threadId);
    const messageCount = await this.countForThread(AGENT_TABLES.messages, threadId);

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
        runCount,
        messageCount,
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
