import { useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Badge } from '../agora-kit/ui/badge';
import { isUnsupported } from '../client/agent-client.js';
import {
  formatCount,
  formatDuration,
  formatModelLabel,
  formatPercent,
  formatTimestamp,
  formatUsd,
} from '../client/format.js';
import type { TrendMetric } from '../client/trend-path.js';
import type { GenuiStats, GovernanceRange, UsageTrendPoint } from '../client/types.js';
import { SparklesIcon } from './icons.js';
import { TrendChart } from './TrendChart.js';
import { Notice, numClass, Segmented, ShareBar } from './ui.js';
import { asQuery, useGenuiStats } from './use-governance.js';

const usd = (value: number | null) => (value === null ? '—' : formatUsd(value));
const pct = (value: number | null) => (value === null ? '—' : formatPercent(value));

type ToolModelRow = GenuiStats['byToolModel'][number];
type ErrorRow = GenuiStats['errors'][number];
type DayRow = GenuiStats['byDay'][number];

/** The daily rows as the spend page's {@link TrendChart} points (unpriced days plot as $0). */
function trendPoints(stats: GenuiStats): UsageTrendPoint[] {
  return stats.byDay.map((day) => ({
    day: day.day,
    totalTokens: day.inputTokens + day.outputTokens,
    costUsd: day.costUsd ?? 0,
  }));
}

const toolModelColumns: Column<ToolModelRow>[] = [
  {
    id: 'tool',
    header: 'Tool',
    cell: (row) => <span className="mono text-fg">{row.toolName}</span>,
  },
  {
    id: 'model',
    header: 'Model',
    cell: (row) => <span title={row.modelId}>{formatModelLabel(row.modelId)}</span>,
  },
  { id: 'mode', header: 'Mode', hideBelow: 'sm', cell: (row) => row.mode },
  {
    id: 'calls',
    header: 'Calls',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => <span className={numClass}>{formatCount(row.calls)}</span>,
  },
  {
    id: 'first',
    header: 'First attempts',
    align: 'right',
    hideBelow: 'lg',
    cell: (row) => <span className={numClass}>{formatCount(row.firstAttempts)}</span>,
  },
  {
    id: 'rate',
    header: 'First-try rate',
    align: 'right',
    cell: (row) => <span className="mono tnum text-fg">{pct(row.firstTryRate)}</span>,
  },
  {
    id: 'bar',
    header: '',
    className: 'w-28',
    hideBelow: 'md',
    cell: (row) => <ShareBar fraction={row.firstTryRate ?? 0} color="var(--agora-good)" />,
  },
  {
    id: 'retried',
    header: 'Retried',
    align: 'right',
    hideBelow: 'lg',
    cell: (row) => <span className={numClass}>{formatCount(row.retried)}</span>,
  },
  {
    id: 'failed',
    header: 'Failed',
    align: 'right',
    hideBelow: 'sm',
    cell: (row) => (
      <span className={row.failed > 0 ? 'mono tnum text-bad' : numClass}>
        {formatCount(row.failed)}
      </span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => <span className={numClass}>{usd(row.costUsd)}</span>,
  },
];

const errorColumns: Column<ErrorRow>[] = [
  {
    id: 'category',
    header: 'Category',
    cell: (row) => <Badge variant="destructive">{row.category}</Badge>,
  },
  {
    id: 'tool',
    header: 'Tool',
    hideBelow: 'sm',
    cell: (row) => <span className="mono">{row.toolName}</span>,
  },
  {
    id: 'message',
    header: 'Message',
    className: 'max-w-[28rem] whitespace-normal',
    cell: (row) => <span className="mono break-words text-fg-2">{row.message || '—'}</span>,
  },
  {
    id: 'count',
    header: 'Count',
    align: 'right',
    cell: (row) => <span className={numClass}>{formatCount(row.count)}</span>,
  },
  {
    id: 'last',
    header: 'Last seen',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => <span className="mono tnum">{formatTimestamp(row.lastAt)}</span>,
  },
];

const dayColumns: Column<DayRow>[] = [
  { id: 'day', header: 'Day', cell: (day) => <span className="mono text-fg">{day.day}</span> },
  {
    id: 'calls',
    header: 'Calls',
    align: 'right',
    cell: (day) => <span className={numClass}>{formatCount(day.calls)}</span>,
  },
  {
    id: 'turns',
    header: 'Turns',
    align: 'right',
    hideBelow: 'sm',
    cell: (day) => <span className={numClass}>{formatCount(day.turns)}</span>,
  },
  {
    id: 'rate',
    header: 'First-try rate',
    align: 'right',
    hideBelow: 'md',
    cell: (day) => <span className={numClass}>{pct(day.firstTryRate)}</span>,
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    hideBelow: 'md',
    cell: (day) => (
      <span className={numClass}>{formatCount(day.inputTokens + day.outputTokens)}</span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'right',
    cell: (day) => <span className="mono tnum text-fg">{usd(day.costUsd)}</span>,
  },
];

/** The eight headline tiles. */
export function GenuiMetrics({ stats }: { stats: GenuiStats }) {
  const { totals, costPerTurn, latency } = stats;
  return (
    <MetricGrid className="md:grid-cols-4">
      <MetricCard
        label="UI calls"
        value={formatCount(totals.calls)}
        caption="ui__* tool calls"
        tone="brand"
      />
      <MetricCard
        label="First-try success"
        value={pct(totals.firstTryRate)}
        caption={`${formatCount(totals.firstTrySuccesses)} of ${formatCount(totals.firstAttempts)} first attempts`}
        tone="good"
      />
      <MetricCard
        label="Retried · failed"
        value={`${formatCount(totals.retried)} · ${formatCount(totals.failed)}`}
        caption="accepted after a retry · refused"
        tone={totals.failed > 0 ? 'warn' : 'default'}
      />
      <MetricCard
        label="UI cost"
        value={usd(totals.costUsd)}
        caption={`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`}
      />
      <MetricCard
        label="Cost per turn"
        value={usd(costPerTurn.avgUsd)}
        caption={`avg · p50 ${usd(costPerTurn.p50Usd)} · p95 ${usd(costPerTurn.p95Usd)}`}
      />
      <MetricCard label="Turns" value={formatCount(totals.turns)} caption="with a UI call" />
      <MetricCard
        label="Time to first frame"
        value={formatDuration(latency.firstFrame.p50Ms)}
        caption={`p50 · p95 ${formatDuration(latency.firstFrame.p95Ms)} · ${formatCount(latency.firstFrame.samples)} turns`}
        tone="info"
      />
      <MetricCard
        label="Time to complete"
        value={formatDuration(latency.complete.p50Ms)}
        caption={`p50 · p95 ${formatDuration(latency.complete.p95Ms)} · ${formatCount(latency.complete.samples)} turns`}
        tone="info"
      />
    </MetricGrid>
  );
}

/** The breakdowns under the tiles (presentational). */
export function GenuiBreakdowns({ stats }: { stats: GenuiStats }) {
  const [metric, setMetric] = useState<TrendMetric>('costUsd');
  return (
    <>
      <ErrorBoundary label="First-try success by tool and model">
        <Panel
          title="First-try success by tool and model"
          description="a turn's first UI attempt, accepted as written"
          flush
        >
          <DataTable
            columns={toolModelColumns}
            rows={stats.byToolModel}
            rowKey={(row) => `${row.toolName}\u0000${row.modelId}`}
            empty={<EmptyState title="No UI tool calls recorded in this range." />}
          />
        </Panel>
      </ErrorBoundary>

      <ErrorBoundary label="Common errors">
        <Panel title="Common errors" description="refused UI calls, most frequent first" flush>
          <DataTable
            columns={errorColumns}
            rows={stats.errors}
            rowKey={(row) => `${row.category}\u0000${row.toolName}\u0000${row.message}`}
            empty={<EmptyState title="No refused UI calls in this range." />}
          />
        </Panel>
      </ErrorBoundary>

      <ErrorBoundary label="UI cost per day">
        <Panel
          title="UI cost per day"
          description="per day"
          flush
          action={
            <Segmented
              label="trend metric"
              value={metric}
              options={[
                { key: 'costUsd', label: 'Cost' },
                { key: 'totalTokens', label: 'Tokens' },
              ]}
              onChange={setMetric}
            />
          }
        >
          {stats.byDay.length === 0 ? (
            <EmptyState title="No UI activity in this range." />
          ) : (
            <>
              <div className="px-4 pt-3 pb-2">
                <TrendChart points={trendPoints(stats)} metric={metric} />
              </div>
              <DataTable columns={dayColumns} rows={stats.byDay} rowKey={(day) => day.day} />
            </>
          )}
        </Panel>
      </ErrorBoundary>
    </>
  );
}

/**
 * Generative-UI telemetry from `GET /agent/governance/genui` for the selected range (container):
 * how often the model's UI tool calls (`ui__render`, `ui__sandbox`, `ui__show_*`) are accepted on
 * the first try, which tool/model pairs struggle, the errors they hit, what UI costs per turn and per
 * day, and how soon the user sees a frame. `501` means the bound store does not record genui
 * telemetry — an expected state with its own notice, not an error.
 */
export function GenuiSection({ range }: { range: GovernanceRange }) {
  const state = useGenuiStats(range);
  const stats = asQuery(state);
  const header = (
    <PageHeader
      title="Generative UI"
      description={`UI tool calls: first-try success, errors, cost and latency · ${range.fromDay} → ${range.toDay}`}
    />
  );

  if (isUnsupported(state.error)) {
    return (
      <PageBody>
        {header}
        <Notice title="Not recorded on this server">
          This server's governance store does not record generative-UI telemetry (no{' '}
          <code>genuiStats</code> on its governance queries), so there is nothing to show here. Use
          a store that records UI tool calls (the Lucid or in-memory store) to enable this page.
        </Notice>
      </PageBody>
    );
  }

  return (
    <PageBody>
      {header}
      <ErrorBoundary label="Generative UI">
        <QueryBoundary
          query={stats}
          label="Generative UI"
          skeleton={<MetricGridSkeleton count={8} />}
        >
          {(data) => (
            <>
              <GenuiMetrics stats={data} />
              {data.totals.calls > 0 ? (
                <GenuiBreakdowns stats={data} />
              ) : (
                <Panel title="Generative UI" description="UI tool calls">
                  <EmptyState
                    icon={<SparklesIcon />}
                    title={`No generative-UI tool calls were recorded between ${range.fromDay} and ${range.toDay}.`}
                    description="Widen the range, or check that the agent has UI tools enabled."
                  />
                </Panel>
              )}
            </>
          )}
        </QueryBoundary>
      </ErrorBoundary>
    </PageBody>
  );
}
