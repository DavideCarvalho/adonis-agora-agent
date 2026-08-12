import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '../client/agent-client.js';
import { AgentApiError } from '../client/agent-client.js';
import type {
  ActorSpendRow,
  CurrentModelPrice,
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

function fakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    spendByModel: vi.fn().mockResolvedValue(modelRows),
    spendByActor: vi.fn().mockResolvedValue(actorRows),
    usageTrend: vi.fn().mockResolvedValue(trendPoints),
    recentThreads: vi.fn().mockResolvedValue(threadRows),
    recentToolCalls: vi.fn().mockResolvedValue(toolCallRows),
    quotaToday: vi.fn().mockResolvedValue({ usedTokens: 123 }),
    listRuns: vi.fn().mockResolvedValue({ runs: runRows, nextCursor: null } as ListRunsResult),
    runDetail: vi.fn().mockResolvedValue(runDetail),
    threadDetail: vi.fn().mockResolvedValue(threadDetail),
    pendingApprovals: vi.fn().mockResolvedValue(pendingRows),
    perToolStats: vi.fn().mockResolvedValue(toolStatRows),
    runReliability: vi.fn().mockResolvedValue(reliability),
    approveToolCall: vi.fn().mockResolvedValue({ ok: true }),
    rejectToolCall: vi.fn().mockResolvedValue({ ok: true }),
    pricing: vi.fn().mockResolvedValue(prices),
    upsertPrice: vi.fn().mockResolvedValue({ ok: true }),
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
    const listRuns = vi
      .fn()
      .mockImplementation((filter?: { cursor?: string }) =>
        Promise.resolve(
          filter?.cursor
            ? ({ runs: [page2Run], nextCursor: null } as ListRunsResult)
            : ({ runs: runRows, nextCursor: 'cursor-1' } as ListRunsResult),
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
