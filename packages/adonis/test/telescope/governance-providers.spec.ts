import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ListRunsFilter,
  ListRunsResult,
  ModelSpendRow,
  PendingApprovalRow,
  PendingApprovalsFilter,
  PerToolStatRow,
  RunDetail,
  RunReliability,
  RunSummaryRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  ToolStatsRange,
  UsageTrendPoint,
} from '../../src/spi/governance-queries.js';
import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentPendingApprovalsCountProvider,
  agentPendingApprovalsTableProvider,
  agentRecentRunsTableProvider,
  agentRecentThreadsTableProvider,
  agentRecentToolCallsTableProvider,
  agentRunsByAgentTableProvider,
  agentRunsDurationProvider,
  agentRunsFailedProvider,
  agentRunsSuccessRateProvider,
  agentRunsTotalProvider,
  agentRunsTrendProvider,
  agentSpendByActorProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentTokensTotalProvider,
  agentToolStatsTableProvider,
  agentUsageTrendProvider,
  capErrorMessage,
  resolveRange,
  shiftUtcDay,
} from '../../src/telescope/agent-governance-providers.js';
import {
  getTelescopeGovernanceQueries,
  setTelescopeGovernanceQueries,
} from '../../src/telescope/governance-registry.js';
import type { ExtensionContext } from '../../src/telescope/telescope-sdk.js';

/** A minimal ExtensionContext — the governance providers never touch `store`/`config`. */
const ctx: ExtensionContext = {
  store: { list: async () => [] },
  container: { make: async () => undefined as never },
  config: {},
};

/** A hand-built `AgentGovernanceQueries` fake with canned, overridable responses per method. */
function fakeQueries(overrides: Partial<AgentGovernanceQueries> = {}): AgentGovernanceQueries {
  return {
    spendByModel: async (_range: GovernanceRange): Promise<ModelSpendRow[]> => [],
    spendByActor: async (_range: GovernanceRange): Promise<ActorSpendRow[]> => [],
    usageTrend: async (_range: GovernanceRange): Promise<UsageTrendPoint[]> => [],
    recentToolCalls: async (_limit: number): Promise<ToolCallActivityRow[]> => [],
    recentThreads: async (_limit: number): Promise<ThreadActivityRow[]> => [],
    listRuns: async (_filter?: ListRunsFilter): Promise<ListRunsResult> => ({
      runs: [],
      nextCursor: null,
    }),
    runDetail: async (_runId: string): Promise<RunDetail | null> => null,
    pendingApprovals: async (_filter?: PendingApprovalsFilter): Promise<PendingApprovalRow[]> => [],
    perToolStats: async (_range?: ToolStatsRange): Promise<PerToolStatRow[]> => [],
    runReliability: async (_range?: ToolStatsRange): Promise<RunReliability> => ({
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      successRate: 0,
      failureRate: 0,
      cancelRate: 0,
      avgDurationMs: null,
    }),
    ...overrides,
  };
}

afterEach(() => {
  setTelescopeGovernanceQueries(undefined);
});

describe('governance-registry', () => {
  it('is undefined until set, and reset back to undefined', () => {
    expect(getTelescopeGovernanceQueries()).toBeUndefined();
    const q = fakeQueries();
    setTelescopeGovernanceQueries(q);
    expect(getTelescopeGovernanceQueries()).toBe(q);
    setTelescopeGovernanceQueries(undefined);
    expect(getTelescopeGovernanceQueries()).toBeUndefined();
  });
});

describe('range helpers', () => {
  it('shiftUtcDay shifts by whole UTC days', () => {
    expect(shiftUtcDay('2026-01-05', -4)).toBe('2026-01-01');
    expect(shiftUtcDay('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('resolveRange honours explicit fromDay/toDay', () => {
    expect(resolveRange({ fromDay: '2026-01-01', toDay: '2026-01-10' })).toEqual({
      fromDay: '2026-01-01',
      toDay: '2026-01-10',
    });
  });

  it('resolveRange defaults to a trailing 30-day window ending today when omitted', () => {
    const range = resolveRange(undefined);
    expect(range.toDay).toBe(new Date().toISOString().slice(0, 10));
    expect(shiftUtcDay(range.toDay, -29)).toBe(range.fromDay);
  });

  it('resolveRange ignores a malformed fromDay/toDay', () => {
    const range = resolveRange({ fromDay: 'not-a-day', toDay: 12345 });
    expect(range.toDay).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('capErrorMessage', () => {
  it('passes short messages through unchanged', () => {
    expect(capErrorMessage('boom')).toBe('boom');
  });

  it('renders the placeholder for null', () => {
    expect(capErrorMessage(null)).toBe('—');
  });

  it('truncates long messages with an ellipsis', () => {
    const long = 'x'.repeat(600);
    const capped = capErrorMessage(long);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.length).toBe(501);
  });
});

describe('providers degrade to empty/zero when governance is unbound', () => {
  it('every provider returns its empty-but-valid shape', async () => {
    expect(await agentSpendTotalProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentTokensTotalProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentSpendByModelProvider().resolve(undefined, ctx)).toEqual({ segments: [] });
    expect(await agentModelSpendTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentUsageTrendProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentActorSpendTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentSpendByActorProvider().resolve(undefined, ctx)).toEqual({ segments: [] });
    expect(await agentRunsTotalProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentRunsSuccessRateProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentRunsFailedProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentRunsDurationProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await agentRunsByAgentTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentRunsTrendProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentRecentRunsTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentRecentToolCallsTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentRecentThreadsTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentPendingApprovalsCountProvider().resolve(undefined, ctx)).toEqual({
      value: 0,
    });
    expect(await agentPendingApprovalsTableProvider().resolve(undefined, ctx)).toEqual({
      rows: [],
    });
    expect(await agentToolStatsTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
  });
});

describe('spend/usage providers', () => {
  const modelRows: ModelSpendRow[] = [
    { modelId: 'gpt-5', requests: 10, inputTokens: 1000, outputTokens: 500, costUsd: 1.2345 },
    { modelId: 'claude', requests: 5, inputTokens: 200, outputTokens: 100, costUsd: 0 },
  ];

  it('spendTotal sums costUsd across models, rounded to cents', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ spendByModel: async () => modelRows }));
    expect(await agentSpendTotalProvider().resolve(undefined, ctx)).toEqual({ value: 1.23 });
  });

  it('tokensTotal sums input+output tokens across models', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ spendByModel: async () => modelRows }));
    expect(await agentTokensTotalProvider().resolve(undefined, ctx)).toEqual({ value: 1800 });
  });

  it('spendByModel drops zero-cost models from the breakdown', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ spendByModel: async () => modelRows }));
    const res = (await agentSpendByModelProvider().resolve(undefined, ctx)) as {
      segments: Array<{ label: string; value: number }>;
    };
    expect(res.segments).toEqual([{ label: 'gpt-5', value: 1.23 }]);
  });

  it('spendByModelTable rounds cost but keeps token counts exact', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ spendByModel: async () => modelRows }));
    const res = (await agentModelSpendTableProvider().resolve(undefined, ctx)) as {
      rows: ModelSpendRow[];
    };
    expect(res.rows[0]).toMatchObject({ modelId: 'gpt-5', inputTokens: 1000, costUsd: 1.23 });
  });

  it('usageTrend maps day → label', async () => {
    setTelescopeGovernanceQueries(
      fakeQueries({
        usageTrend: async () => [{ day: '2026-01-01', totalTokens: 100, costUsd: 0.5 }],
      }),
    );
    const res = (await agentUsageTrendProvider().resolve(undefined, ctx)) as {
      rows: Array<{ label: string; totalTokens: number; costUsd: number }>;
    };
    expect(res.rows).toEqual([{ label: '2026-01-01', totalTokens: 100, costUsd: 0.5 }]);
  });

  it('spendByActor table + breakdown drop zero-cost actors from the donut only', async () => {
    const actorRows: ActorSpendRow[] = [
      { actorRef: 'u-1', requests: 3, totalTokens: 400, costUsd: 2 },
      { actorRef: 'u-2', requests: 1, totalTokens: 10, costUsd: 0 },
    ];
    setTelescopeGovernanceQueries(fakeQueries({ spendByActor: async () => actorRows }));
    const table = (await agentActorSpendTableProvider().resolve(undefined, ctx)) as {
      rows: ActorSpendRow[];
    };
    expect(table.rows).toHaveLength(2);
    const breakdown = (await agentSpendByActorProvider().resolve(undefined, ctx)) as {
      segments: Array<{ label: string }>;
    };
    expect(breakdown.segments).toEqual([{ label: 'u-1', value: 2 }]);
  });
});

describe('run reliability providers', () => {
  const reliability: RunReliability = {
    runs: 10,
    completed: 8,
    failed: 2,
    cancelled: 0,
    running: 0,
    successRate: 0.8,
    failureRate: 0.2,
    cancelRate: 0,
    avgDurationMs: 1500,
    byAgent: [{ agentName: 'root', runs: 7, failed: 1, successRate: 6 / 7 }],
    trend: [{ day: '2026-01-01', runs: 10, failed: 2 }],
  };

  it('runsTotal/successRate/failed/duration read runReliability', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ runReliability: async () => reliability }));
    expect(await agentRunsTotalProvider().resolve(undefined, ctx)).toEqual({ value: 10 });
    expect(await agentRunsSuccessRateProvider().resolve(undefined, ctx)).toEqual({ value: 0.8 });
    expect(await agentRunsFailedProvider().resolve(undefined, ctx)).toEqual({ value: 2 });
    expect(await agentRunsDurationProvider().resolve(undefined, ctx)).toEqual({ value: 1500 });
  });

  it('runsDuration resolves to 0 when avgDurationMs is null (no settled runs)', async () => {
    setTelescopeGovernanceQueries(
      fakeQueries({ runReliability: async () => ({ ...reliability, avgDurationMs: null }) }),
    );
    expect(await agentRunsDurationProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
  });

  it('runsByAgent maps the optional byAgent breakdown, null agentName → placeholder', async () => {
    setTelescopeGovernanceQueries(
      fakeQueries({
        runReliability: async () => ({
          ...reliability,
          byAgent: [{ agentName: null, runs: 3, failed: 1, successRate: 2 / 3 }],
        }),
      }),
    );
    const res = (await agentRunsByAgentTableProvider().resolve(undefined, ctx)) as {
      rows: Array<{ agentName: string; runs: number; failed: number }>;
    };
    expect(res.rows).toEqual([{ agentName: '—', runs: 3, failed: 1 }]);
  });

  it('runsByAgent/runsTrend degrade to empty when the adapter omits byAgent/trend', async () => {
    const { byAgent: _byAgent, trend: _trend, ...bare } = reliability;
    setTelescopeGovernanceQueries(fakeQueries({ runReliability: async () => bare }));
    expect(await agentRunsByAgentTableProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
    expect(await agentRunsTrendProvider().resolve(undefined, ctx)).toEqual({ rows: [] });
  });

  it('runsTrend maps day → label', async () => {
    setTelescopeGovernanceQueries(fakeQueries({ runReliability: async () => reliability }));
    const res = (await agentRunsTrendProvider().resolve(undefined, ctx)) as {
      rows: Array<{ label: string; runs: number; failed: number }>;
    };
    expect(res.rows).toEqual([{ label: '2026-01-01', runs: 10, failed: 2 }]);
  });
});

describe('recent activity + approvals inbox providers', () => {
  const run: RunSummaryRow = {
    runId: 'r-1',
    threadId: 't-1',
    actorRef: 'u-1',
    tenantRef: null,
    agentName: null,
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    durationMs: 5000,
    stepCount: 3,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: null,
    error: 'boom',
    durable: false,
  };

  it('recentRuns maps listRuns rows, null agentName → placeholder, error capped', async () => {
    setTelescopeGovernanceQueries(
      fakeQueries({ listRuns: async () => ({ runs: [run], nextCursor: null }) }),
    );
    const res = (await agentRecentRunsTableProvider().resolve(undefined, ctx)) as {
      rows: Array<{ runId: string; agentName: string; costUsd: string; error: string }>;
    };
    expect(res.rows[0]).toMatchObject({
      runId: 'r-1',
      agentName: '—',
      costUsd: '—',
      error: 'boom',
    });
  });

  it('recentRuns forwards the panel-requested limit', async () => {
    let seenLimit: number | undefined;
    setTelescopeGovernanceQueries(
      fakeQueries({
        listRuns: async (filter) => {
          seenLimit = filter?.limit;
          return { runs: [], nextCursor: null };
        },
      }),
    );
    await agentRecentRunsTableProvider().resolve({ limit: 5 }, ctx);
    expect(seenLimit).toBe(5);
  });

  it('recentToolCalls/recentThreads pass rows through unchanged', async () => {
    const toolCall: ToolCallActivityRow = {
      toolCallId: 'tc-1',
      toolName: 'search',
      toolType: 'read',
      status: 'executed',
      threadId: 't-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const thread: ThreadActivityRow = {
      threadId: 't-1',
      title: 'Hello',
      actorRef: 'u-1',
      messageCount: 4,
      totalTokens: 300,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    };
    setTelescopeGovernanceQueries(
      fakeQueries({
        recentToolCalls: async () => [toolCall],
        recentThreads: async () => [thread],
      }),
    );
    expect(await agentRecentToolCallsTableProvider().resolve(undefined, ctx)).toEqual({
      rows: [toolCall],
    });
    expect(await agentRecentThreadsTableProvider().resolve(undefined, ctx)).toEqual({
      rows: [thread],
    });
  });

  it('pendingApprovalsCount is the length of pendingApprovals(limit)', async () => {
    const rows: PendingApprovalRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'refund',
        input: {},
        threadId: 't-1',
        runId: 'r-1',
        actorRef: 'u-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        toolCallId: 'c2',
        toolName: 'ship',
        input: {},
        threadId: 't-2',
        runId: null,
        actorRef: 'u-2',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    setTelescopeGovernanceQueries(fakeQueries({ pendingApprovals: async () => rows }));
    expect(await agentPendingApprovalsCountProvider().resolve(undefined, ctx)).toEqual({
      value: 2,
    });
  });

  it('pendingApprovalsTable drops `input` and keeps the rest', async () => {
    const rows: PendingApprovalRow[] = [
      {
        toolCallId: 'c1',
        toolName: 'refund',
        input: { secret: true },
        threadId: 't-1',
        runId: 'r-1',
        actorRef: 'u-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    setTelescopeGovernanceQueries(fakeQueries({ pendingApprovals: async () => rows }));
    const res = (await agentPendingApprovalsTableProvider().resolve(undefined, ctx)) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(res.rows[0]).not.toHaveProperty('input');
    expect(res.rows[0]).toMatchObject({ toolCallId: 'c1', toolName: 'refund', runId: 'r-1' });
  });

  it('toolStats maps avgDurationMs, falling back to the placeholder when null', async () => {
    const rows: PerToolStatRow[] = [
      {
        toolName: 'search',
        toolType: 'read',
        calls: 5,
        failed: 1,
        rejected: 0,
        avgDurationMs: 120.4,
      },
      {
        toolName: 'refund',
        toolType: 'action',
        calls: 2,
        failed: 0,
        rejected: 1,
        avgDurationMs: null,
      },
    ];
    setTelescopeGovernanceQueries(fakeQueries({ perToolStats: async () => rows }));
    const res = (await agentToolStatsTableProvider().resolve(undefined, ctx)) as {
      rows: Array<{ toolName: string; avgDurationMs: number | string }>;
    };
    expect(res.rows[0]).toMatchObject({ toolName: 'search', avgDurationMs: 120.4 });
    expect(res.rows[1]).toMatchObject({ toolName: 'refund', avgDurationMs: '—' });
  });
});
