import { resolveApiBase } from './api-base.js';
import type {
  ActorSpendRow,
  CurrentModelPrice,
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

type FetchLike = typeof fetch;

export interface AgentClientOptions {
  /** Agent API base (e.g. `/agent`). Defaults to the injected/derived base for the current page. */
  baseUrl?: string;
  /** Injectable `fetch` (tests pass a stub). Defaults to the global. */
  fetch?: FetchLike;
  /** Cap for the `recent*` feeds; the server clamps to 200. Defaults to 50. */
  limit?: number;
}

/**
 * A framework-free browser client for the `@adonis-agora/agent` provider's READ surface: the five
 * `/agent/governance/*` rollups plus the per-actor `quota/today`. Same-origin, `credentials:
 * 'same-origin'` so the host's actor/auth cookie gates every call exactly as it gates the routes
 * server-side. No third-party HTTP dependency.
 */
export class AgentClient {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly limit: number;

  constructor(options: AgentClientOptions = {}) {
    this.base = (options.baseUrl ?? resolveApiBase()).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.limit = options.limit ?? 50;
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
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
    const response = await this.doFetch(`${this.base}${path}`, {
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

  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    return this.get<UsageTrendPoint[]>('/governance/usage/trend', {
      from: range.fromDay,
      to: range.toDay,
    });
  }

  recentToolCalls(limit = this.limit): Promise<ToolCallActivityRow[]> {
    return this.get<ToolCallActivityRow[]>('/governance/tool-calls/recent', {
      limit: String(limit),
    });
  }

  recentThreads(limit = this.limit): Promise<ThreadActivityRow[]> {
    return this.get<ThreadActivityRow[]>('/governance/threads/recent', { limit: String(limit) });
  }

  /** `GET /agent/governance/threads/:id` — one thread's governance drill-down, or `null` if unknown. */
  threadDetail(threadId: string): Promise<GovernanceThreadDetail | null> {
    return this.get<GovernanceThreadDetail | null>(
      `/governance/threads/${encodeURIComponent(threadId)}`,
    );
  }

  quotaToday(): Promise<QuotaToday> {
    return this.get<QuotaToday>('/quota/today');
  }

  // ── Run lifecycle governance (the run-tracking read-model). ─────────────────

  /** `GET /agent/governance/runs` — filterable, cursor-paginated run list, newest-first. */
  listRuns(filter: ListRunsFilter = {}): Promise<ListRunsResult> {
    const query: Record<string, string> = { limit: String(filter.limit ?? this.limit) };
    if (filter.actor) query.actor = filter.actor;
    if (filter.agent) query.agent = filter.agent;
    if (filter.status) query.status = filter.status;
    if (filter.from) query.from = filter.from;
    if (filter.to) query.to = filter.to;
    if (filter.cursor) query.cursor = filter.cursor;
    return this.get<ListRunsResult>('/governance/runs', query);
  }

  /** `GET /agent/governance/runs/:id` — one run's full trace, or `null` if unknown. */
  runDetail(runId: string): Promise<RunDetail | null> {
    return this.get<RunDetail | null>(`/governance/runs/${encodeURIComponent(runId)}`);
  }

  /** `GET /agent/governance/approvals/pending` — cross-thread HITL inbox, oldest first. */
  pendingApprovals(filter: PendingApprovalsFilter = {}): Promise<PendingApprovalRow[]> {
    const query: Record<string, string> = { limit: String(filter.limit ?? this.limit) };
    if (filter.actor) query.actor = filter.actor;
    return this.get<PendingApprovalRow[]>('/governance/approvals/pending', query);
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

  // ── Model pricing — mounted only when the server binds a pricing store alongside governance. ──

  /** `GET /agent/governance/pricing` — every model's current per-1M rates. */
  pricing(): Promise<CurrentModelPrice[]> {
    return this.get<CurrentModelPrice[]>('/governance/pricing');
  }

  /** `POST /agent/governance/pricing` — upsert one model's rate (atomic supersede). */
  upsertPrice(input: ModelPriceInput): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>('/governance/pricing', input);
  }
}
