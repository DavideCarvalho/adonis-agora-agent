import type { Column, DashboardSection, DashboardSpec } from './telescope-sdk.js';

/** Options for the agent "Agent" dashboard. */
export interface AgentDashboardOptions {
  /**
   * URL template for deep-linking a run row (a `LinkSpec.href` with `{key}` placeholders filled from the
   * row, e.g. `/agent/runs/{runId}`). Applied to the `runId` column of every table below that carries one
   * (the entry-backed runs/tool-calls/approvals/delegations tables, AND the governance-backed
   * runs/tool-calls/approvals tables). Omit to render plain run ids with no link.
   */
  runHref?: string;
  /**
   * URL template for deep-linking a thread, e.g. `/agent/threads/{thread}`. Applied to the entry-backed
   * recent-runs table's `thread` column and the governance-backed tables' `threadId` column (two
   * different keys — see `data-providers.ts` vs `agent-governance-providers.ts` for why the entry-backed
   * table renames the field and the governance-backed ones don't).
   */
  threadHref?: string;
  /**
   * HOST-contributed dashboard sections, appended after the built-in ones. Bind their panels to a
   * provider passed via `agentTelescopeExtension({ providers })`, or to any built-in `agent.*`
   * provider. Size each section's panel count to an exact multiple of its `cols` where practical — the
   * renderer lays a section out as a fixed grid with no `colSpan`, so an orphan panel leaves a visible
   * hole beside it. That's a layout nicety, not something validated here.
   */
  sections?: DashboardSection[];
}

/**
 * The "Agent" overview dashboard. Four ENTRY-BACKED sections (unchanged from before this port — see
 * `data-providers.ts`): run health, run activity, tools & approvals, delegations & tokens. Then two
 * GOVERNANCE-BACKED sections reading the authoritative, restart-surviving read-model (see
 * `agent-governance-providers.ts` for exactly what that read-model can and can't answer on this SPI):
 * spend/usage and run reliability + governance activity feeds. Then RAG (see `rag-data-providers.ts`
 * for the honest, partial scope: retrieval counts/zero-hit-rate/mean-chunks/trend only — no latency,
 * scores, or store/collection breakdown, because the recorded event doesn't carry them).
 *
 * Pure data: panels bind to the `agent.*` data providers by name; the `*Href` options add an optional
 * `LinkSpec` on the id columns so a host agent SPA can deep-link a row. `opts.sections` appends
 * host-contributed sections after the built-in ones (see `AgentDashboardOptions.sections`).
 */
export function agentDashboard(opts: AgentDashboardOptions = {}): DashboardSpec {
  const runCol = (label: string): Column =>
    opts.runHref ? { key: 'runId', label, link: { href: opts.runHref } } : { key: 'runId', label };
  const threadCol: Column = opts.threadHref
    ? { key: 'thread', label: 'Thread', link: { href: opts.threadHref } }
    : { key: 'thread', label: 'Thread' };
  const threadIdCol: Column = opts.threadHref
    ? { key: 'threadId', label: 'Thread', link: { href: opts.threadHref } }
    : { key: 'threadId', label: 'Thread' };

  return {
    id: 'agent.overview',
    label: 'Agent',
    panels: [],
    sections: [
      {
        title: 'Runs',
        cols: 3,
        panels: [
          {
            kind: 'stat',
            title: 'Active runs',
            data: { provider: 'agent.activeRuns' },
            spark: false,
          },
          {
            kind: 'stat',
            title: 'Tokens (24h)',
            data: { provider: 'agent.tokenUsage' },
            format: 'number',
            spark: true,
          },
          {
            kind: 'gauge',
            title: 'Tool-call success rate',
            data: { provider: 'agent.toolCallSuccessRate' },
            max: 1,
            format: 'percent',
            thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' },
          },
        ],
      },
      {
        title: 'Run activity',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Runs over time',
            data: { provider: 'agent.runsOverTime' },
            series: ['started', 'finished'],
            style: 'stacked',
          },
          {
            kind: 'table',
            title: 'Recent runs',
            data: { provider: 'agent.recentRuns' },
            columns: [
              { key: 'time', label: 'Time' },
              runCol('Run'),
              threadCol,
              { key: 'steps', label: 'Steps' },
              { key: 'tokens', label: 'Tokens' },
            ],
          },
        ],
      },
      {
        title: 'Tools & approvals',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Tool calls over time',
            data: { provider: 'agent.toolCallsOverTime' },
            series: ['executed', 'rejected', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'table',
            title: 'Recent tool calls',
            data: { provider: 'agent.recentToolCalls' },
            columns: [
              { key: 'time', label: 'Time' },
              runCol('Run'),
              { key: 'tool', label: 'Tool' },
              { key: 'type', label: 'Type' },
              { key: 'status', label: 'Status' },
            ],
          },
          {
            kind: 'table',
            title: 'Recent approvals',
            data: { provider: 'agent.recentApprovals' },
            columns: [
              { key: 'time', label: 'Time' },
              runCol('Run'),
              { key: 'tool', label: 'Tool' },
              { key: 'status', label: 'Decision' },
            ],
          },
        ],
      },
      {
        title: 'Delegations & tokens',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Tokens over time',
            data: { provider: 'agent.tokensOverTime' },
            series: ['input', 'output'],
            style: 'stacked',
          },
          {
            kind: 'timeseries',
            title: 'Delegations over time',
            data: { provider: 'agent.delegationsOverTime' },
            series: ['delegations'],
            style: 'area',
          },
          {
            kind: 'table',
            title: 'Recent delegations',
            data: { provider: 'agent.recentDelegations' },
            columns: [
              { key: 'time', label: 'Time' },
              runCol('Run'),
              { key: 'from', label: 'From' },
              { key: 'to', label: 'To' },
            ],
          },
        ],
      },
      {
        title: 'Spend & usage',
        cols: 3,
        panels: [
          {
            kind: 'stat',
            title: 'Total spend (USD)',
            data: { provider: 'agent.spend.totalCost' },
            format: 'number',
          },
          {
            kind: 'stat',
            title: 'Total tokens',
            data: { provider: 'agent.spend.totalTokens' },
            format: 'number',
          },
          {
            kind: 'breakdown',
            title: 'Spend by model',
            data: { provider: 'agent.spend.byModel' },
            style: 'donut',
          },
        ],
      },
      {
        title: 'Spend detail',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Spend by model',
            data: { provider: 'agent.spend.byModelTable' },
            columns: [
              { key: 'modelId', label: 'Model' },
              { key: 'requests', label: 'Requests' },
              { key: 'inputTokens', label: 'Input tokens' },
              { key: 'outputTokens', label: 'Output tokens' },
              { key: 'costUsd', label: 'Cost (USD)' },
            ],
          },
          {
            kind: 'table',
            title: 'Spend by actor',
            data: { provider: 'agent.spend.byActor' },
            columns: [
              { key: 'actorRef', label: 'Actor' },
              { key: 'requests', label: 'Requests' },
              { key: 'totalTokens', label: 'Tokens' },
              { key: 'costUsd', label: 'Cost (USD)' },
            ],
          },
          {
            kind: 'breakdown',
            title: 'Spend by actor',
            data: { provider: 'agent.spend.byActorShare' },
            style: 'donut',
          },
          {
            kind: 'timeseries',
            title: 'Usage trend',
            data: { provider: 'agent.usage.trend' },
            series: ['costUsd', 'totalTokens'],
            style: 'area',
          },
        ],
      },
      {
        title: 'Run reliability',
        cols: 3,
        panels: [
          { kind: 'stat', title: 'Runs', data: { provider: 'agent.runs.total' }, format: 'number' },
          {
            kind: 'gauge',
            title: 'Success rate',
            data: { provider: 'agent.runs.successRate' },
            max: 1,
            format: 'percent',
            thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' },
          },
          {
            kind: 'stat',
            title: 'Failed runs',
            data: { provider: 'agent.runs.failed' },
            format: 'number',
          },
          {
            kind: 'stat',
            title: 'Avg run duration',
            data: { provider: 'agent.runs.duration' },
            format: 'duration',
          },
          {
            kind: 'table',
            title: 'Runs by agent',
            data: { provider: 'agent.runs.byAgent' },
            columns: [
              { key: 'agentName', label: 'Agent' },
              { key: 'runs', label: 'Runs' },
              { key: 'failed', label: 'Failed' },
            ],
          },
          {
            kind: 'timeseries',
            title: 'Runs trend',
            data: { provider: 'agent.runs.trend' },
            series: ['runs', 'failed'],
            style: 'stacked',
          },
        ],
      },
      {
        title: 'Governance activity',
        cols: 2,
        panels: [
          {
            kind: 'table',
            title: 'Recent runs',
            data: { provider: 'agent.runs.recent' },
            columns: [
              { key: 'startedAt', label: 'Started' },
              runCol('Run'),
              threadIdCol,
              { key: 'actorRef', label: 'Actor' },
              { key: 'agentName', label: 'Agent' },
              { key: 'status', label: 'Status' },
              { key: 'durationMs', label: 'Duration (ms)' },
              { key: 'costUsd', label: 'Cost (USD)' },
              { key: 'error', label: 'Error' },
            ],
          },
          {
            kind: 'table',
            title: 'Recent tool calls',
            data: { provider: 'agent.tools.recent' },
            columns: [
              { key: 'createdAt', label: 'Time' },
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'status', label: 'Status' },
              threadIdCol,
            ],
          },
          {
            kind: 'table',
            title: 'Recent threads',
            data: { provider: 'agent.threads.recent' },
            columns: [
              { key: 'lastActivityAt', label: 'Last activity' },
              { key: 'title', label: 'Title' },
              { key: 'actorRef', label: 'Actor' },
              { key: 'messageCount', label: 'Messages' },
              { key: 'totalTokens', label: 'Tokens' },
            ],
          },
          {
            kind: 'stat',
            title: 'Pending approvals',
            data: { provider: 'agent.approvals.pending' },
            format: 'number',
          },
          {
            kind: 'table',
            title: 'Approvals inbox',
            data: { provider: 'agent.approvals.recent' },
            columns: [
              { key: 'requestedAt', label: 'Requested' },
              runCol('Run'),
              { key: 'toolName', label: 'Tool' },
              threadIdCol,
              { key: 'actorRef', label: 'Actor' },
            ],
          },
          {
            kind: 'table',
            title: 'Tool stats',
            data: { provider: 'agent.tools.stats' },
            columns: [
              { key: 'toolName', label: 'Tool' },
              { key: 'toolType', label: 'Type' },
              { key: 'calls', label: 'Calls' },
              { key: 'failed', label: 'Failed' },
              { key: 'rejected', label: 'Rejected' },
              { key: 'avgDurationMs', label: 'Avg (ms)' },
            ],
          },
        ],
      },
      {
        title: 'RAG',
        cols: 2,
        panels: [
          {
            kind: 'stat',
            title: 'Retrievals',
            data: { provider: 'agent.rag.retrievals' },
            format: 'number',
          },
          {
            kind: 'stat',
            title: 'Zero-hit rate',
            data: { provider: 'agent.rag.zeroHitRate' },
            format: 'percent',
            thresholds: { warn: 0.1, bad: 0.25, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Mean chunks',
            data: { provider: 'agent.rag.chunks' },
            format: 'number',
          },
          {
            kind: 'timeseries',
            title: 'Retrieval trend',
            data: { provider: 'agent.rag.trend' },
            series: ['retrievals', 'zeroHits'],
            style: 'area',
          },
        ],
      },
      ...(opts.sections ?? []),
    ],
  };
}
