import { FilterQueryBuilder, filterQuery } from '@adonis-agora/filter-client';
import { resolveApiBase } from './api-base.js';
import type {
  ActorSpendRow,
  CurrentModelPrice,
  CursorPageResponse,
  CursorParams,
  FeatureSpendRow,
  GenuiStats,
  GovernanceRange,
  GovernanceThreadDetail,
  ListRunsFilter,
  ListRunsResult,
  ModelPriceInput,
  ModelSpendRow,
  PendingApprovalRow,
  PendingApprovalsFilter,
  PerToolStatRow,
  QuotaToday,
  RunDetail,
  RunReliability,
  ThreadActivityRow,
  ToolCallActivityRow,
  ToolStatsRange,
  UsageTrendPoint,
} from './types.js';

/** Thrown on a non-2xx governance response, carrying the HTTP status for the UI to branch on. */
export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

/**
 * `true` when the error is the server saying the bound governance adapter does not implement an
 * OPTIONAL read (`501` — e.g. `genuiStats`, `threadDetail`, or no pricing store bound): an expected
 * state the UI renders as "not available here", distinct from a network/auth failure.
 */
export function isUnsupported(error: unknown): boolean {
  return error instanceof AgentApiError && error.status === 501;
}

/**
 * `true` when the server does not offer a read at all: {@link isUnsupported} (`501`), or a `404`
 * from an older agent server that has no such route (`/governance/spend/feature` before 0.93,
 * `/governance/pricing` without a pricing store before 1.0). Only for collection reads whose route
 * takes no id, where a `404` cannot mean "that record does not exist".
 */
export function isUnavailable(error: unknown): boolean {
  return isUnsupported(error) || (error instanceof AgentApiError && error.status === 404);
}

type FetchLike = typeof fetch;

export interface AgentClientOptions {
  /** Agent API base (e.g. `/agent`). Defaults to the injected/derived base for the current page. */
  baseUrl?: string;
  /** Injectable `fetch` (tests pass a stub). Defaults to the global. */
  fetch?: FetchLike;
  /** Page size of the list reads when a call passes no `first`; the server caps it at 200. Default 50. */
  pageSize?: number;
  /**
   * The organization every governance read is scoped to (`?tenant=`), with tenancy on. Defaults to
   * the page's own `?tenant=`; `null` = every organization the viewer may see.
   */
  tenant?: () => string | null;
}

/** The `?tenant=` of the page, or `null`. */
export function pageTenant(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('tenant');
  return value === null || value === '' ? null : value;
}

/**
 * A framework-free browser client for the `@adonis-agora/agent` provider's READ surface: the five
 * `/agent/governance/*` rollups plus the per-actor `quota`. Same-origin, `credentials:
 * 'same-origin'` so the host's actor/auth cookie gates every call exactly as it gates the routes
 * server-side. No third-party HTTP dependency.
 */
export class AgentClient {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly pageSize: number;
  private readonly tenant: () => string | null;

  constructor(options: AgentClientOptions = {}) {
    this.base = (options.baseUrl ?? resolveApiBase()).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pageSize = options.pageSize ?? 50;
    this.tenant = options.tenant ?? pageTenant;
  }

  private async get<T>(
    path: string,
    query: Record<string, string> | FilterQueryBuilder = {},
  ): Promise<T> {
    const tenant = path.startsWith('/governance/') ? this.tenant() : null;
    const params = new URLSearchParams(
      query instanceof FilterQueryBuilder ? query.toQueryString() : query,
    );
    if (tenant !== null) params.set('tenant', tenant);
    const search = params.toString();
    const url = `${this.base}${path}${search ? `?${search}` : ''}`;
    const response = await this.doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new AgentApiError(`GET ${path} failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const tenant = path.startsWith('/governance/') ? this.tenant() : null;
    const url = `${this.base}${path}${tenant !== null ? `?${new URLSearchParams({ tenant })}` : ''}`;
    const response = await this.doFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new AgentApiError(`POST ${path} failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  }

  /** The organizations this viewer may pick (tenancy), from `GET /governance/tenants`. */
  tenants(): Promise<ConsoleTenantsView> {
    return this.get<ConsoleTenantsView>('/governance/tenants');
  }

  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    return this.get<ModelSpendRow[]>('/governance/spend/model', {
      from: range.fromDay,
      to: range.toDay,
    });
  }

  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    return this.get<ActorSpendRow[]>('/governance/spend/actor', {
      from: range.fromDay,
      to: range.toDay,
    });
  }

  /**
   * `GET /agent/governance/spend/feature` — spend per feature, agent turns and recorded usage side by
   * side. Rejects with a `501` or `404` {@link AgentApiError} (see {@link isUnavailable}) on an older
   * server.
   */
  spendByFeature(range: GovernanceRange): Promise<FeatureSpendRow[]> {
    return this.get<FeatureSpendRow[]>('/governance/spend/feature', {
      from: range.fromDay,
      to: range.toDay,
    });
  }

  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    return this.get<UsageTrendPoint[]>('/governance/usage/trend', {
      from: range.fromDay,
      to: range.toDay,
    });
  }

  /** The paging half of a list request, as a filter-client builder. */
  private page(params: CursorParams): FilterQueryBuilder {
    const query = filterQuery().first(params.first ?? this.pageSize);
    if (params.after) query.after(params.after);
    return query;
  }

  /** `GET /agent/governance/tool-calls/recent` — one page of the newest-first tool-call feed. */
  recentToolCalls(page: CursorParams = {}): Promise<CursorPageResponse<ToolCallActivityRow>> {
    return this.get('/governance/tool-calls/recent', this.page(page));
  }

  /** `GET /agent/governance/threads/recent` — one page of the newest-first thread feed. */
  recentThreads(page: CursorParams = {}): Promise<CursorPageResponse<ThreadActivityRow>> {
    return this.get('/governance/threads/recent', this.page(page));
  }

  /** `GET /agent/governance/threads/:id` — one thread's governance drill-down, or `null` if unknown. */
  threadDetail(threadId: string): Promise<GovernanceThreadDetail | null> {
    return this.get<GovernanceThreadDetail | null>(
      `/governance/threads/${encodeURIComponent(threadId)}`,
    );
  }

  /**
   * `GET /agent/governance/genui` — generative-UI telemetry over the range. Rejects with a `501`
   * {@link AgentApiError} (see {@link isUnsupported}) when the store does not record it.
   */
  genuiStats(range: GovernanceRange): Promise<GenuiStats> {
    return this.get<GenuiStats>('/governance/genui', { from: range.fromDay, to: range.toDay });
  }

  /** Today's window of `GET /agent/quota` — the caller's token spend so far today. */
  async quotaToday(): Promise<QuotaToday> {
    const report = await this.get<{ windows?: { period: string; usedTokens?: number }[] }>(
      '/quota',
    );
    const day = report.windows?.find((window) => window.period === 'day');
    return { usedTokens: day?.usedTokens ?? 0 };
  }

  // ── Run lifecycle governance (the run-tracking read-model). ─────────────────

  /**
   * `GET /agent/governance/runs` — one page of the run list, newest first, filtered by actor, agent,
   * status and the UTC days it started on. Pass `meta.nextCursor` back as `after`.
   */
  listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    const query = this.page(filter);
    if (filter.actor) query.where('actor', 'equals', filter.actor);
    if (filter.agent) query.where('agent', 'equals', filter.agent);
    if (filter.status) query.where('status', 'equals', filter.status);
    if (filter.from && filter.to) query.where('startedAt', 'between', [filter.from, filter.to]);
    else if (filter.from) query.where('startedAt', 'gte', filter.from);
    else if (filter.to) query.where('startedAt', 'lte', filter.to);
    return this.get<ListRunsResult>('/governance/runs', query);
  }

  /** `GET /agent/governance/runs/:id` — one run's full trace, or `null` if unknown. */
  runDetail(runId: string): Promise<RunDetail | null> {
    return this.get<RunDetail | null>(`/governance/runs/${encodeURIComponent(runId)}`);
  }

  /** `GET /agent/governance/approvals/pending` — one page of the cross-thread HITL inbox, oldest first. */
  pendingApprovals(
    filter: PendingApprovalsFilter = {},
  ): Promise<CursorPageResponse<PendingApprovalRow>> {
    const query = this.page(filter);
    if (filter.actor) query.where('actor', 'equals', filter.actor);
    return this.get('/governance/approvals/pending', query);
  }

  /** `GET /agent/governance/tools/stats` — per-tool call/failure/rejection/latency rollup. */
  perToolStats(range: ToolStatsRange = {}): Promise<PerToolStatRow[]> {
    const query: Record<string, string> = {};
    if (range.from) query.from = range.from;
    if (range.to) query.to = range.to;
    return this.get<PerToolStatRow[]>('/governance/tools/stats', query);
  }

  /** `GET /agent/governance/reliability` — success/failure/cancel rates + mean settled duration. */
  runReliability(range: ToolStatsRange = {}): Promise<RunReliability> {
    const query: Record<string, string> = {};
    if (range.from) query.from = range.from;
    if (range.to) query.to = range.to;
    return this.get<RunReliability>('/governance/reliability', query);
  }

  // ── HITL decisions — the EXISTING mutating routes the approvals inbox wires to. ──

  /** `POST /agent/tool-call/approve` — release a `pending_approval` tool call. */
  approveToolCall(runId: string, toolCallId: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>('/tool-call/approve', { runId, toolCallId });
  }

  /** `POST /agent/tool-call/reject` — deny a `pending_approval` tool call, with an optional reason. */
  rejectToolCall(runId: string, toolCallId: string, reason?: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>('/tool-call/reject', {
      runId,
      toolCallId,
      ...(reason ? { reason } : {}),
    });
  }

  // ── Model pricing — `501` (an older server: `404`) when the server binds no pricing store. ──

  /** `GET /agent/governance/pricing` — every model's current per-1M rates. */
  pricing(): Promise<CurrentModelPrice[]> {
    return this.get<CurrentModelPrice[]>('/governance/pricing');
  }

  /** `POST /agent/governance/pricing` — upsert one model's rate (atomic supersede). */
  upsertPrice(input: ModelPriceInput): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>('/governance/pricing', input);
  }
}

/** What `GET /governance/tenants` answers. */
export interface ConsoleTenantsView {
  /** Tenancy is on for the agent. Off → no organization control. */
  enabled: boolean;
  /** The viewer may see every organization (and data with none). */
  all: boolean;
  /** The viewer's own active organization, when they have one. */
  own?: string | null;
  tenants: Array<{ id: string; label: string }>;
  /** The organization the page is scoped to (`?tenant=`), when valid. */
  selected: string | null;
}
