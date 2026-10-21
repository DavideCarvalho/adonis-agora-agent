import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '../client/agent-client.js';
import { AgentApiError } from '../client/agent-client.js';
import type {
  ActorSpendRow,
  CurrentModelPrice,
  GenuiStats,
  GovernanceThreadDetail,
  ListRunsResult,
  ModelSpendRow,
  PendingApprovalRow,
  PerToolStatRow,
  RunDetail,
  RunReliability,
  RunSummaryRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '../client/types.js';
import { ApprovalsSection } from './ApprovalsSection.js';
import { GenuiSection } from './GenuiSection.js';
import { Overview } from './Overview.js';
import { PricingSection } from './PricingSection.js';
import { ReliabilitySection } from './ReliabilitySection.js';
import { RunDetailView } from './RunDetailView.js';
import { RunsSection } from './RunsSection.js';
import { ThreadDetailView } from './ThreadDetailView.js';
import { ThreadsSection } from './ThreadsSection.js';
import { ToolCallsSection } from './ToolCallsSection.js';
import { ToolsSection } from './ToolsSection.js';
import { AgentClientContext } from './use-governance.js';

const RANGE = { fromDay: '2026-03-01', toDay: '2026-03-07' };

const modelRows: ModelSpendRow[] = [
  { modelId: 'gpt-4o', requests: 4, inputTokens: 4000, outputTokens: 1000, costUsd: 12.5 },
  {
    modelId: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-haiku',
    requests: 9,
    inputTokens: 8000,
    outputTokens: 800,
    costUsd: 3.2,
  },
];
const actorRows: ActorSpendRow[] = [
  { actorRef: 'user:alice', requests: 7, totalTokens: 9000, costUsd: 10 },
  { actorRef: 'user:bob', requests: 6, totalTokens: 4600, costUsd: 5.7 },
];
const trendPoints: UsageTrendPoint[] = [
  { day: '2026-03-01', totalTokens: 3000, costUsd: 4 },
  { day: '2026-03-02', totalTokens: 5800, costUsd: 8 },
];
const threadRows: ThreadActivityRow[] = [
  {
    threadId: 'thread-abc12345',
    title: 'Refund request',
    actorRef: 'user:alice',
    messageCount: 5,
    totalTokens: 4200,
    lastActivityAt: '2026-03-07T10:00:00.000Z',
  },
];
const toolCallRows: ToolCallActivityRow[] = [
  {
    toolCallId: 'call-1',
    toolName: 'search_orders',
    toolType: 'function',
    status: 'completed',
    threadId: 'thread-abc12345',
    createdAt: '2026-03-07T10:01:00.000Z',
  },
];

const runRows: RunSummaryRow[] = [
  {
    runId: 'run-abc12345',
    threadId: 'thread-abc12345',
    actorRef: 'user:alice',
    tenantRef: null,
    agentName: 'support',
    status: 'completed',
    startedAt: '2026-03-07T10:00:00.000Z',
    finishedAt: '2026-03-07T10:00:05.000Z',
    durationMs: 5000,
    stepCount: 3,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.42,
    error: null,
    durable: true,
  },
];
const runDetail: RunDetail = {
  run: runRows[0]!,
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Where is my order?',
      createdAt: '2026-03-07T10:00:00.000Z',
    },
  ],
  toolCalls: [
    {
      toolCallId: 'tc1',
      toolName: 'search_orders',
      toolType: 'function',
      status: 'completed',
      input: { q: 'order' },
      output: { found: true },
      error: null,
      executionMs: 120,
      createdAt: '2026-03-07T10:00:01.000Z',
    },
  ],
  approvals: [],
  usage: [
    {
      modelId: 'gpt-4o',
      purpose: 'chat',
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.42,
      createdAt: '2026-03-07T10:00:02.000Z',
    },
  ],
};
const pendingRows: PendingApprovalRow[] = [
  {
    toolCallId: 'call-1',
    toolName: 'refund_order',
    input: { orderId: 'o-9' },
    threadId: 'thread-abc12345',
    runId: 'run-1',
    actorRef: 'user:alice',
    requestedAt: '2026-03-07T10:05:00.000Z',
  },
];
const toolStatRows: PerToolStatRow[] = [
  {
    toolName: 'search_orders',
    toolType: 'function',
    calls: 40,
    failed: 2,
    rejected: 0,
    avgDurationMs: 130,
    p50ExecutionMs: 110,
    p95ExecutionMs: 420,
  },
  {
    toolName: 'refund_order',
    toolType: 'function',
    calls: 8,
    failed: 1,
    rejected: 3,
    avgDurationMs: 900,
  },
];
const reliability: RunReliability = {
  runs: 100,
  completed: 82,
  failed: 10,
  cancelled: 5,
  running: 3,
  successRate: 0.82,
  failureRate: 0.1,
  cancelRate: 0.05,
  avgDurationMs: 4200,
};
const threadDetail: GovernanceThreadDetail = {
  threadId: 'thread-abc12345',
  title: 'Refund request',
  actorRef: 'user:alice',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-07T10:00:00.000Z',
  deleted: false,
  usage: { totalTokens: 9000, costUsd: 12.5, runCount: 3, messageCount: 5 },
  runs: runRows,
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Where is my order?',
      createdAt: '2026-03-07T10:00:00.000Z',
    },
  ],
};
const prices: CurrentModelPrice[] = [
  {
    modelId: 'gpt-4o',
    inputPricePer1m: 3,
    outputPricePer1m: 15,
    effectiveFrom: '2026-03-01T00:00:00.000Z',
  },
];

const genuiStats: GenuiStats = {
  totals: {
    calls: 12,
    turns: 8,
    firstAttempts: 8,
    firstTrySuccesses: 6,
    firstTryRate: 0.75,
    retried: 2,
    failed: 4,
    inputTokens: 24000,
    outputTokens: 6000,
    costUsd: 0.48,
  },
  byToolModel: [
    {
      toolName: 'ui__render',
      modelId: 'gpt-4o',
      mode: 'tree',
      calls: 9,
      firstAttempts: 6,
      firstTrySuccesses: 5,
      firstTryRate: 5 / 6,
      retried: 1,
      failed: 3,
      costUsd: 0.36,
    },
    {
      toolName: 'ui__sandbox',
      modelId: 'claude-haiku',
      mode: 'sandbox',
      calls: 3,
      firstAttempts: 2,
      firstTrySuccesses: 1,
      firstTryRate: 0.5,
      retried: 1,
      failed: 1,
      costUsd: null,
    },
  ],
  errors: [
    {
      category: 'unknown-component',
      message: 'invalid sandbox code: "…" is not a kit component',
      toolName: 'ui__sandbox',
      count: 3,
      lastAt: '2026-03-06T09:15:00.000Z',
    },
    {
      category: 'shape',
      message: 'invalid UI tree: props.rows: expected array',
      toolName: 'ui__render',
      count: 1,
      lastAt: '2026-03-05T12:00:00.000Z',
    },
  ],
  byDay: [
    {
      day: '2026-03-05',
      calls: 5,
      turns: 3,
      inputTokens: 10000,
      outputTokens: 2000,
      costUsd: 0.2,
      firstTryRate: 2 / 3,
    },
    {
      day: '2026-03-06',
      calls: 7,
      turns: 5,
      inputTokens: 14000,
      outputTokens: 4000,
      costUsd: 0.28,
      firstTryRate: 0.8,
    },
  ],
  costPerTurn: { turns: 8, avgUsd: 0.06, p50Usd: 0.05, p95Usd: 0.12 },
  latency: {
    firstFrame: { samples: 8, p50Ms: 420, p95Ms: 1300 },
    complete: { samples: 7, p50Ms: 2100, p95Ms: 5600 },
  },
};

const emptyGenuiStats: GenuiStats = {
  totals: {
    calls: 0,
    turns: 0,
    firstAttempts: 0,
    firstTrySuccesses: 0,
    firstTryRate: null,
    retried: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  },
  byToolModel: [],
  errors: [],
  byDay: [],
  costPerTurn: { turns: 0, avgUsd: null, p50Usd: null, p95Usd: null },
  latency: {
    firstFrame: { samples: 0, p50Ms: null, p95Ms: null },
    complete: { samples: 0, p50Ms: null, p95Ms: null },
  },
};

function fakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    spendByModel: vi.fn().mockResolvedValue(modelRows),
    spendByActor: vi.fn().mockResolvedValue(actorRows),
    usageTrend: vi.fn().mockResolvedValue(trendPoints),
    recentThreads: vi.fn().mockResolvedValue(threadRows),
    recentToolCalls: vi.fn().mockResolvedValue(toolCallRows),
    quotaToday: vi.fn().mockResolvedValue({ usedTokens: 123 }),
    listRuns: vi.fn().mockResolvedValue({
      items: runRows,
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    } as ListRunsResult),
    runDetail: vi.fn().mockResolvedValue(runDetail),
    threadDetail: vi.fn().mockResolvedValue(threadDetail),
    pendingApprovals: vi.fn().mockResolvedValue(pendingRows),
    perToolStats: vi.fn().mockResolvedValue(toolStatRows),
    runReliability: vi.fn().mockResolvedValue(reliability),
    approveToolCall: vi.fn().mockResolvedValue({ ok: true }),
    rejectToolCall: vi.fn().mockResolvedValue({ ok: true }),
    pricing: vi.fn().mockResolvedValue(prices),
    upsertPrice: vi.fn().mockResolvedValue({ ok: true }),
    genuiStats: vi.fn().mockResolvedValue(genuiStats),
    ...overrides,
  } as unknown as AgentClient;
}

function renderWith(client: AgentClient, ui: ReactNode) {
  return render(
    <StrictMode>
      <AgentClientContext.Provider value={client}>{ui}</AgentClientContext.Provider>
    </StrictMode>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('Overview', () => {
  it('renders spend-by-model, trend, and spend-by-actor from mocked governance responses', async () => {
    const client = fakeClient();
    renderWith(client, <Overview range={RANGE} />);

    // Spend-by-model shows the plain id and the shortened Bedrock label (each appears in both the
    // legend and the table, hence getAllByText).
    await waitFor(() => expect(screen.getAllByText('gpt-4o').length).toBeGreaterThan(0));
    expect(screen.getAllByText('claude-haiku').length).toBeGreaterThan(0);

    // Headline total spend = 12.5 + 3.2 = $15.70 (appears in the stat and donut center).
    expect(screen.getAllByText('$15.70').length).toBeGreaterThan(0);

    // Spend-by-actor rows.
    expect(screen.getByText('user:alice')).toBeTruthy();
    expect(screen.getByText('user:bob')).toBeTruthy();

    // Called the real routes with the selected range.
    expect(client.spendByModel).toHaveBeenCalledWith(RANGE);
    expect(client.usageTrend).toHaveBeenCalledWith(RANGE);
    expect(client.spendByActor).toHaveBeenCalledWith(RANGE);
  });

  it('shows an empty state when there is no usage', async () => {
    const client = fakeClient({
      spendByModel: vi.fn().mockResolvedValue([]),
      spendByActor: vi.fn().mockResolvedValue([]),
      usageTrend: vi.fn().mockResolvedValue([]),
    } as Partial<AgentClient>);
    renderWith(client, <Overview range={RANGE} />);
    await waitFor(() => expect(screen.getByText('No usage recorded in this range.')).toBeTruthy());
  });

  it('surfaces a load error', async () => {
    const client = fakeClient({
      spendByModel: vi.fn().mockRejectedValue(new Error('boom')),
    } as Partial<AgentClient>);
    renderWith(client, <Overview range={RANGE} />);
    await waitFor(() => expect(screen.getByText(/Failed to load: boom/)).toBeTruthy());
  });
});

describe('ThreadsSection', () => {
  it('lists recent threads from threads/recent', async () => {
    const client = fakeClient();
    renderWith(client, <ThreadsSection />);
    await waitFor(() => expect(screen.getByText('Refund request')).toBeTruthy());
    expect(client.recentThreads).toHaveBeenCalled();
  });

  it('opens a thread detail on row click', async () => {
    const client = fakeClient();
    renderWith(client, <ThreadsSection />);
    await waitFor(() => expect(screen.getByText('Refund request')).toBeTruthy());

    fireEvent.click(screen.getByText('Refund request'));
    await waitFor(() => expect(screen.getByText('Where is my order?')).toBeTruthy());
    expect(client.threadDetail).toHaveBeenCalledWith('thread-abc12345');
    expect(screen.getByText('← Back to threads')).toBeTruthy();
  });
});

describe('ThreadDetailView', () => {
  it('assembles the lifetime usage rollup, recent runs and recent messages', async () => {
    const client = fakeClient();
    renderWith(client, <ThreadDetailView threadId="thread-abc12345" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Where is my order?')).toBeTruthy());
    expect(client.threadDetail).toHaveBeenCalledWith('thread-abc12345');
    expect(screen.getByText('Lifetime tokens')).toBeTruthy();
    expect(screen.getByText('support')).toBeTruthy();
  });

  it('shows a deleted-thread banner', async () => {
    const client = fakeClient({
      threadDetail: vi.fn().mockResolvedValue({ ...threadDetail, deleted: true }),
    } as Partial<AgentClient>);
    renderWith(client, <ThreadDetailView threadId="thread-abc12345" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/has been deleted/)).toBeTruthy());
  });

  it('shows an empty state when the thread is unknown', async () => {
    const client = fakeClient({
      threadDetail: vi.fn().mockResolvedValue(null),
    } as Partial<AgentClient>);
    renderWith(client, <ThreadDetailView threadId="nope" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Thread not found.')).toBeTruthy());
  });
});

describe('ToolCallsSection', () => {
  it('lists recent tool calls with a status pill', async () => {
    const client = fakeClient();
    renderWith(client, <ToolCallsSection />);
    await waitFor(() => expect(screen.getByText('search_orders')).toBeTruthy());
    expect(screen.getByText('completed')).toBeTruthy();
    expect(client.recentToolCalls).toHaveBeenCalled();
  });
});

describe('RunsSection', () => {
  it('lists runs from governance/runs and opens a run detail on row click', async () => {
    const client = fakeClient();
    renderWith(client, <RunsSection />);

    await waitFor(() => expect(screen.getByText('support')).toBeTruthy());
    expect(client.listRuns).toHaveBeenCalled();

    // Click the run row → the detail trace assembles (messages + tool calls + usage).
    fireEvent.click(screen.getByText('run-abc1…'));
    await waitFor(() => expect(screen.getByText('Where is my order?')).toBeTruthy());
    expect(client.runDetail).toHaveBeenCalledWith('run-abc12345');
    expect(screen.getByText('← Back to runs')).toBeTruthy();
  });

  it('re-queries with the status filter', async () => {
    const client = fakeClient();
    renderWith(client, <RunsSection />);
    await waitFor(() => expect(screen.getByText('support')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('status filter'), { target: { value: 'failed' } });
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' })),
    );
  });

  it('paginates by appending the next page from nextCursor', async () => {
    const page2Run: RunSummaryRow = { ...runRows[0]!, runId: 'run-def67890', agentName: 'billing' };
    const listRuns = vi.fn().mockImplementation((filter?: { after?: string }) =>
      Promise.resolve(
        filter?.after
          ? ({
              items: [page2Run],
              nextCursor: null,
              prevCursor: null,
              hasNext: false,
              hasPrev: false,
            } as ListRunsResult)
          : ({
              items: runRows,
              nextCursor: 'cursor-1',
              prevCursor: null,
              hasNext: true,
              hasPrev: false,
            } as ListRunsResult),
      ),
    );
    const client = fakeClient({ listRuns } as Partial<AgentClient>);
    renderWith(client, <RunsSection />);

    await waitFor(() => expect(screen.getByText('support')).toBeTruthy());
    fireEvent.click(screen.getByText('Load more'));
    await waitFor(() => expect(screen.getByText('billing')).toBeTruthy());
    // Both pages are now on screen.
    expect(screen.getByText('support')).toBeTruthy();
  });
});

describe('RunDetailView', () => {
  it('assembles the run summary, messages, tool calls and usage', async () => {
    const client = fakeClient();
    renderWith(client, <RunDetailView runId="run-abc12345" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Where is my order?')).toBeTruthy());
    expect(client.runDetail).toHaveBeenCalledWith('run-abc12345');
    // tool call + usage rows.
    expect(screen.getByText('search_orders')).toBeTruthy();
    expect(screen.getByText('chat')).toBeTruthy();
    expect(screen.getByText('Tool calls')).toBeTruthy();
    expect(screen.getByText('Usage')).toBeTruthy();
  });

  it('shows an empty state when the run is unknown', async () => {
    const client = fakeClient({
      runDetail: vi.fn().mockResolvedValue(null),
    } as Partial<AgentClient>);
    renderWith(client, <RunDetailView runId="nope" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Run not found.')).toBeTruthy());
  });
});

describe('ApprovalsSection', () => {
  it('lists pending approvals and fires approve against the real route', async () => {
    const client = fakeClient();
    renderWith(client, <ApprovalsSection />);

    await waitFor(() => expect(screen.getByText('refund_order')).toBeTruthy());
    expect(client.pendingApprovals).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(client.approveToolCall).toHaveBeenCalledWith('run-1', 'call-1'));
  });

  it('fires reject against the real route', async () => {
    const client = fakeClient();
    renderWith(client, <ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('refund_order')).toBeTruthy());

    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(client.rejectToolCall).toHaveBeenCalledWith('run-1', 'call-1'));
  });

  it('shows an empty inbox state', async () => {
    const client = fakeClient({
      pendingApprovals: vi.fn().mockResolvedValue([]),
    } as Partial<AgentClient>);
    renderWith(client, <ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('No tool calls awaiting approval.')).toBeTruthy());
  });
});

describe('ToolsSection', () => {
  it('renders the per-tool stats and re-sorts on a header click', async () => {
    const client = fakeClient();
    renderWith(client, <ToolsSection />);

    await waitFor(() => expect(screen.getByText('search_orders')).toBeTruthy());
    expect(client.perToolStats).toHaveBeenCalled();

    // Default sort is calls desc → search_orders (40) before refund_order (8).
    const firstToolBefore = screen.getAllByRole('row')[1]?.textContent ?? '';
    expect(firstToolBefore).toContain('search_orders');

    // The execution percentiles, and an older server's missing ones as a dash.
    expect(screen.getByText('420ms')).toBeTruthy();
    expect(screen.getAllByRole('row')[2]?.textContent ?? '').toContain('—');

    // Sort by rejected desc → refund_order (3) rises to the top.
    fireEvent.click(screen.getByText(/^Rejected/));
    await waitFor(() => {
      const firstTool = screen.getAllByRole('row')[1]?.textContent ?? '';
      expect(firstTool).toContain('refund_order');
    });
  });
});

describe('ReliabilitySection', () => {
  it('renders the success/failure/cancel rates from governance/reliability', async () => {
    const client = fakeClient();
    renderWith(client, <ReliabilitySection />);

    await waitFor(() => expect(screen.getByText('Success rate')).toBeTruthy());
    expect(client.runReliability).toHaveBeenCalled();
    // Rate appears in both the stat card and the rates table.
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10%').length).toBeGreaterThan(0);
    expect(screen.getByText('5%')).toBeTruthy();
  });

  it('shows an empty state when there are no runs', async () => {
    const client = fakeClient({
      runReliability: vi.fn().mockResolvedValue({
        runs: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        running: 0,
        successRate: 0,
        failureRate: 0,
        cancelRate: 0,
        avgDurationMs: null,
      } as RunReliability),
    } as Partial<AgentClient>);
    renderWith(client, <ReliabilitySection />);
    await waitFor(() => expect(screen.getByText('No runs recorded yet.')).toBeTruthy());
  });

  it('renders the by-agent breakdown and the trend chart when the server provides them', async () => {
    const client = fakeClient({
      runReliability: vi.fn().mockResolvedValue({
        ...reliability,
        byAgent: [{ agentName: 'support', runs: 80, failed: 5, successRate: 0.9 }],
        trend: [
          { day: '2026-03-01', runs: 10, failed: 1 },
          { day: '2026-03-02', runs: 12, failed: 0 },
        ],
      } as RunReliability),
    } as Partial<AgentClient>);
    renderWith(client, <ReliabilitySection />);

    await waitFor(() => expect(screen.getByText('By agent')).toBeTruthy());
    expect(screen.getByText('support')).toBeTruthy();
    expect(screen.getByText('Runs vs failed')).toBeTruthy();
  });

  it('omits the by-agent and trend panels when the server predates them', async () => {
    const client = fakeClient();
    renderWith(client, <ReliabilitySection />);
    await waitFor(() => expect(screen.getByText('Success rate')).toBeTruthy());
    expect(screen.queryByText('By agent')).toBeNull();
    expect(screen.queryByText('Runs vs failed')).toBeNull();
    expect(screen.queryByText('Time to first token')).toBeNull();
    expect(screen.queryByText('Failures by code')).toBeNull();
  });

  it('renders turn latency and failures by code when the server provides them', async () => {
    const client = fakeClient({
      runReliability: vi.fn().mockResolvedValue({
        ...reliability,
        latency: {
          ttft: { samples: 80, p50Ms: 640, p95Ms: 2100 },
          duration: { samples: 82, p50Ms: 3200, p95Ms: 12_500 },
        },
        failuresByCode: [
          { code: 'run_failed', count: 7 },
          { code: 'quota_exceeded', count: 3 },
        ],
      } as RunReliability),
    } as Partial<AgentClient>);
    renderWith(client, <ReliabilitySection />);

    await waitFor(() => expect(screen.getByText('Time to first token')).toBeTruthy());
    expect(screen.getByText('640ms')).toBeTruthy();
    expect(screen.getByText(/p95 2\.1s · 80 turns/)).toBeTruthy();
    expect(screen.getByText('Turn duration')).toBeTruthy();
    expect(screen.getByText(/p95 12\.5s · 82 turns/)).toBeTruthy();
    expect(screen.getByText('Failures by code')).toBeTruthy();
    // Once in the donut's legend, once in the table.
    expect(screen.getAllByText('quota_exceeded').length).toBe(2);
    expect(screen.getByRole('img', { name: 'failures by code' })).toBeTruthy();
  });
});

describe('PricingSection', () => {
  it('lists current model prices and upserts a new one', async () => {
    const client = fakeClient();
    renderWith(client, <PricingSection />);

    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeTruthy());
    expect(client.pricing).toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('model id (e.g. gpt-4o)'), {
      target: { value: 'claude-x' },
    });
    fireEvent.change(screen.getByPlaceholderText('input $/1M'), { target: { value: '3' } });
    fireEvent.change(screen.getByPlaceholderText('output $/1M'), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Save price'));

    await waitFor(() =>
      expect(client.upsertPrice).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'claude-x', inputPricePer1m: 3, outputPricePer1m: 15 }),
      ),
    );
  });

  it('shows a distinct panel when no pricing store is bound (501)', async () => {
    const client = fakeClient({
      pricing: vi.fn().mockRejectedValue(new AgentApiError('nope', 501)),
    } as Partial<AgentClient>);
    renderWith(client, <PricingSection />);
    await waitFor(() => expect(screen.getByText(/No pricing store is bound/)).toBeTruthy());
  });
});

describe('GenuiSection', () => {
  it('renders the KPI tiles from the range stats', async () => {
    const client = fakeClient();
    renderWith(client, <GenuiSection range={RANGE} />);

    await waitFor(() => expect(screen.getByText('UI calls')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('75%')).toBeTruthy());
    expect(client.genuiStats).toHaveBeenCalledWith(RANGE);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('6 of 8 first attempts')).toBeTruthy();
    expect(screen.getByText('2 · 4')).toBeTruthy();
    expect(screen.getByText('$0.48')).toBeTruthy();
    expect(screen.getByText('$0.06')).toBeTruthy();
    expect(screen.getByText('avg · p50 $0.05 · p95 $0.12')).toBeTruthy();
    expect(screen.getByText('420ms')).toBeTruthy();
    expect(screen.getByText('p50 · p95 1.3s · 8 turns')).toBeTruthy();
    expect(screen.getByText('2.1s')).toBeTruthy();
    expect(screen.getByText('p50 · p95 5.6s · 7 turns')).toBeTruthy();
  });

  it('renders first-try success by tool and model', async () => {
    renderWith(fakeClient(), <GenuiSection range={RANGE} />);

    await waitFor(() =>
      expect(screen.getByText('First-try success by tool and model')).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText('tree')).toBeTruthy());
    const row = screen.getByText('tree').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('ui__render');
    expect(row.textContent).toContain('gpt-4o');
    expect(row.textContent).toContain('83%');
    expect(row.textContent).toContain('$0.36');
    const sandbox = screen.getByText('sandbox').closest('tr') as HTMLElement;
    expect(sandbox.textContent).toContain('50%');
    // An unpriced group shows a dash, not $0.00.
    expect(sandbox.textContent).toContain('—');
  });

  it('renders the common errors with category, tool, message, count and last seen', async () => {
    renderWith(fakeClient(), <GenuiSection range={RANGE} />);

    await waitFor(() => expect(screen.getByText('unknown-component')).toBeTruthy());
    const message = screen.getByText('invalid sandbox code: "…" is not a kit component');
    expect(message.className).toContain('mono');
    const row = message.closest('tr') as HTMLElement;
    expect(row.textContent).toContain('ui__sandbox');
    expect(row.textContent).toContain('Mar 6, 09:15');
    expect(screen.getByText('shape')).toBeTruthy();
    // The per-day panel reuses the spend trend chart.
    expect(screen.getByText('UI cost per day')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'daily cost trend' })).toBeTruthy();
    expect(screen.getAllByText('2026-03-06').length).toBeGreaterThan(0);
  });

  it('shows an empty state when no UI calls were recorded in the range', async () => {
    renderWith(
      fakeClient({
        genuiStats: vi.fn().mockResolvedValue(emptyGenuiStats),
      } as Partial<AgentClient>),
      <GenuiSection range={RANGE} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/No generative-UI tool calls were recorded/)).toBeTruthy(),
    );
    expect(screen.queryByText('First-try success by tool and model')).toBeNull();
  });

  it('shows a distinct panel when the store does not record genui telemetry (501)', async () => {
    renderWith(
      fakeClient({
        genuiStats: vi.fn().mockRejectedValue(new AgentApiError('nope', 501)),
      } as Partial<AgentClient>),
      <GenuiSection range={RANGE} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/does not record generative-UI telemetry/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });

  it('shows the generic error note on any other failure', async () => {
    renderWith(
      fakeClient({
        genuiStats: vi.fn().mockRejectedValue(new AgentApiError('GET failed (500)', 500)),
      } as Partial<AgentClient>),
      <GenuiSection range={RANGE} />,
    );
    await waitFor(() => expect(screen.getAllByText(/Failed to load/).length).toBeGreaterThan(0));
  });
});
