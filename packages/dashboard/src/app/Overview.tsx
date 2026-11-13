import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { isUnavailable } from '../client/agent-client.js';
import { formatCount, formatModelLabel, formatUsd } from '../client/format.js';
import {
  donutSegments,
  type SpendTotals,
  summarizeActors,
  summarizeSpend,
  withShares,
} from '../client/spend-summary.js';
import type { TrendMetric } from '../client/trend-path.js';
import type {
  ActorSpendRow,
  FeatureSpendRow,
  GovernanceRange,
  ModelSpendRow,
  UsageTrendPoint,
} from '../client/types.js';
import { Donut } from './Donut.js';
import { TrendChart } from './TrendChart.js';
import {
  ChartSkeleton,
  colorAt,
  DonutSkeleton,
  LegendRow,
  numClass,
  Segmented,
  ShareBar,
  TableSkeleton,
} from './ui.js';
import {
  asQuery,
  useSpendByActor,
  useSpendByFeature,
  useSpendByModel,
  useUsageTrend,
} from './use-governance.js';

const TREND_OPTIONS: { key: TrendMetric; label: string }[] = [
  { key: 'costUsd', label: 'Cost' },
  { key: 'totalTokens', label: 'Tokens' },
];

/**
 * The console's landing page (container): headline spend/usage metrics, spend by model (donut +
 * table), spend by feature, the daily usage/cost trend, and spend by actor — every number from the
 * agent's own `/agent/governance/*` rollups for the selected range. Each region loads, fails and
 * renders on its own.
 */
export function Overview({ range }: { range: GovernanceRange }) {
  const models = asQuery(useSpendByModel(range));
  const actors = asQuery(useSpendByActor(range));
  const featuresState = useSpendByFeature(range);
  const features = asQuery(featuresState);
  const trend = asQuery(useUsageTrend(range));
  const [metric, setMetric] = useState<TrendMetric>('costUsd');

  return (
    <PageBody>
      <PageHeader
        title="Overview"
        description={`Spend, tokens and who drives them · ${range.fromDay} → ${range.toDay}`}
      />

      <ErrorBoundary label="Totals">
        <QueryBoundary query={models} label="Spend" skeleton={<MetricGridSkeleton count={4} />}>
          {(rows) => <SpendMetrics totals={summarizeSpend(rows)} models={rows.length} />}
        </QueryBoundary>
      </ErrorBoundary>

      <ErrorBoundary label="Spend by model">
        <Panel title="Spend by model" description="priced against the current model rates" flush>
          <QueryBoundary
            query={models}
            label="Spend by model"
            skeleton={<DonutSkeleton />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                title="No usage recorded in this range."
                description="Model calls show up here once an agent runs."
              />
            }
          >
            {(rows) => <SpendByModel rows={rows} />}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>

      {/* Spend by feature: agent turns and usage recorded outside them, side by side. An older
          server without the route (501/404) leaves the panel out altogether. */}
      {isUnavailable(featuresState.error) ? null : (
        <ErrorBoundary label="Spend by feature">
          <Panel
            title="Spend by feature"
            description="agent turns and recorded usage (transcription, TTS, direct calls)"
            flush
          >
            <QueryBoundary
              query={features}
              label="Spend by feature"
              skeleton={<TableSkeleton columns={featureColumns(0)} rows={3} />}
              isEmpty={(rows) => rows.length === 0}
              empty={<EmptyState title="No spend by feature in this range." />}
            >
              {(rows) => <FeatureTable rows={rows} />}
            </QueryBoundary>
          </Panel>
        </ErrorBoundary>
      )}

      <ErrorBoundary label="Usage trend">
        <Panel
          title="Usage trend"
          description="per day"
          action={
            <Segmented
              label="trend metric"
              value={metric}
              options={TREND_OPTIONS}
              onChange={setMetric}
            />
          }
        >
          <QueryBoundary
            query={trend}
            label="Usage trend"
            skeleton={<ChartSkeleton />}
            isEmpty={(points) => points.length === 0}
            empty={<EmptyState title="No trend data in this range." />}
          >
            {(points: UsageTrendPoint[]) => <TrendChart points={points} metric={metric} />}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>

      <ErrorBoundary label="Spend by actor">
        <Panel title="Spend by actor" description="who is driving cost" flush>
          <QueryBoundary
            query={actors}
            label="Spend by actor"
            skeleton={<TableSkeleton columns={actorColumns(0)} rows={4} />}
            isEmpty={(rows) => rows.length === 0}
            empty={<EmptyState title="No actor activity in this range." />}
          >
            {(rows) => <ActorTable rows={rows} />}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}

/** The headline row: total spend, tokens, requests, models in use. */
export function SpendMetrics({ totals, models }: { totals: SpendTotals; models: number }) {
  return (
    <MetricGrid className="md:grid-cols-4">
      <MetricCard
        label="Total spend"
        value={formatUsd(totals.costUsd)}
        caption="over range"
        tone="brand"
      />
      <MetricCard
        label="Tokens"
        value={formatCount(totals.totalTokens)}
        caption={`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`}
        tone="info"
      />
      <MetricCard label="Requests" value={formatCount(totals.requests)} caption="model calls" />
      <MetricCard label="Models" value={String(models)} caption="in use" tone="violet" />
    </MetricGrid>
  );
}

const modelColumns: Column<ModelSpendRow>[] = [
  {
    id: 'model',
    header: 'Model',
    cell: (row) => (
      <span className="text-fg" title={row.modelId}>
        {formatModelLabel(row.modelId)}
      </span>
    ),
  },
  {
    id: 'requests',
    header: 'Requests',
    align: 'right',
    hideBelow: 'sm',
    cell: (row) => <span className={numClass}>{formatCount(row.requests)}</span>,
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    cell: (row) => (
      <span className={numClass}>{formatCount(row.inputTokens + row.outputTokens)}</span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'right',
    cell: (row) => <span className="mono tnum text-fg">{formatUsd(row.costUsd)}</span>,
  },
];

/** The donut of spend by model, its legend, and the per-model table. */
export function SpendByModel({ rows }: { rows: ModelSpendRow[] }) {
  const totals = summarizeSpend(rows);
  const shares = withShares(rows);
  return (
    <div className="grid items-center lg:grid-cols-[minmax(240px,320px)_1fr]">
      <div className="flex flex-col items-center gap-4 border-b border-border p-5 lg:border-r lg:border-b-0">
        <Donut
          segments={donutSegments(shares)}
          centerLabel={formatUsd(totals.costUsd)}
          centerSub="total"
        />
        <div className="w-full">
          {shares.slice(0, 6).map((row, i) => (
            <LegendRow
              key={row.modelId}
              color={colorAt(i)}
              name={formatModelLabel(row.modelId)}
              title={row.modelId}
              value={formatUsd(row.costUsd)}
            />
          ))}
        </div>
      </div>
      <div className="min-w-0 self-start">
        <DataTable columns={modelColumns} rows={rows} rowKey={(row) => row.modelId} />
      </div>
    </div>
  );
}

/** What a feature row billed, in the units it billed by: tokens, audio, characters. */
function featureUnits(row: FeatureSpendRow): string {
  const parts: string[] = [];
  const tokens = row.inputTokens + row.outputTokens;
  if (tokens > 0) parts.push(`${formatCount(tokens)} tok`);
  if (row.audioSeconds > 0) parts.push(`${formatCount(Math.round(row.audioSeconds))} s audio`);
  if (row.characters > 0) parts.push(`${formatCount(row.characters)} chars`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function featureColumns(maxCost: number): Column<FeatureSpendRow>[] {
  return [
    {
      id: 'feature',
      header: 'Feature',
      cell: (row) => (
        <span className="mono text-fg" title={row.feature}>
          {row.feature}
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      hideBelow: 'sm',
      cell: (row) => <span>{row.source === 'agent' ? 'agent turn' : 'recorded'}</span>,
    },
    {
      id: 'requests',
      header: 'Requests',
      align: 'right',
      hideBelow: 'md',
      cell: (row) => <span className={numClass}>{formatCount(row.requests)}</span>,
    },
    {
      id: 'units',
      header: 'Units',
      align: 'right',
      hideBelow: 'md',
      cell: (row) => <span className={numClass}>{featureUnits(row)}</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (row) => <span className="mono tnum text-fg">{formatUsd(row.costUsd)}</span>,
    },
    {
      id: 'share',
      header: 'Share',
      className: 'w-40',
      hideBelow: 'sm',
      cell: (row) => <ShareBar fraction={maxCost > 0 ? row.costUsd / maxCost : 0} />,
    },
  ];
}

export function FeatureTable({ rows }: { rows: FeatureSpendRow[] }) {
  const maxCost = Math.max(...rows.map((row) => row.costUsd), 0);
  return (
    <DataTable
      columns={featureColumns(maxCost)}
      rows={rows}
      rowKey={(row) => `${row.source}:${row.feature}`}
    />
  );
}

function actorColumns(maxCost: number): Column<ActorSpendRow>[] {
  return [
    {
      id: 'actor',
      header: 'Actor',
      cell: (row) => (
        <span className="mono text-fg" title={row.actorRef}>
          {row.actorRef}
        </span>
      ),
    },
    {
      id: 'requests',
      header: 'Requests',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => <span className={numClass}>{formatCount(row.requests)}</span>,
    },
    {
      id: 'tokens',
      header: 'Tokens',
      align: 'right',
      hideBelow: 'md',
      cell: (row) => <span className={numClass}>{formatCount(row.totalTokens)}</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (row) => <span className="mono tnum text-fg">{formatUsd(row.costUsd)}</span>,
    },
    {
      id: 'share',
      header: 'Share',
      className: 'w-40',
      hideBelow: 'sm',
      cell: (row) => <ShareBar fraction={maxCost > 0 ? row.costUsd / maxCost : 0} />,
    },
  ];
}

/** Spend per actor with a share bar, and the totals underneath. */
export function ActorTable({ rows }: { rows: ActorSpendRow[] }) {
  const totals = summarizeActors(rows);
  const maxCost = Math.max(...rows.map((r) => r.costUsd), 0);
  return (
    <>
      <DataTable columns={actorColumns(maxCost)} rows={rows} rowKey={(row) => row.actorRef} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2.5 text-[11px] text-faint">
        <span className="font-semibold uppercase tracking-[0.12em]">Total</span>
        <span className="mono tnum">
          {formatCount(totals.requests)} req · {formatCount(totals.totalTokens)} tok ·{' '}
          <span className="text-fg-2">{formatUsd(totals.costUsd)}</span>
        </span>
      </div>
    </>
  );
}
