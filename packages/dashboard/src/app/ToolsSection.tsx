import { useMemo, useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { PerToolStatRow } from '../client/types.js';
import { numClass, TableSkeleton } from './ui.js';
import { asQuery, useToolStats } from './use-governance.js';

type SortKey =
  | 'toolName'
  | 'calls'
  | 'failed'
  | 'rejected'
  | 'avgDurationMs'
  | 'p50ExecutionMs'
  | 'p95ExecutionMs';
type SortDir = 'asc' | 'desc';
interface Sort {
  key: SortKey;
  dir: SortDir;
}

/** Compare two per-tool rows on `key`; `null` durations always sort last regardless of direction. */
function compare(a: PerToolStatRow, b: PerToolStatRow, key: SortKey, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'toolName') return sign * a.toolName.localeCompare(b.toolName);
  // An older server sends no percentiles: read as "no duration", like a null one.
  const av = a[key] ?? null;
  const bv = b[key] ?? null;
  if (av === null) return 1;
  if (bv === null) return -1;
  return sign * (av - bv);
}

/** A sortable header: a button with the direction arrow on the active column. */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-pressed={active}
      className={`uppercase tracking-[0.12em] transition-colors hover:text-fg ${active ? 'text-brand' : ''}`}
    >
      {label}
      {active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );
}

function toolColumns(sort: Sort, onSort: (key: SortKey) => void): Column<PerToolStatRow>[] {
  const header = (label: string, key: SortKey) => (
    <SortHeader label={label} sortKey={key} sort={sort} onSort={onSort} />
  );
  const duration =
    (key: 'avgDurationMs' | 'p50ExecutionMs' | 'p95ExecutionMs') => (row: PerToolStatRow) => (
      <span className="mono tnum">{formatDuration(row[key] ?? null)}</span>
    );
  return [
    {
      id: 'tool',
      header: header('Tool', 'toolName'),
      cell: (row) => <span className="mono text-fg">{row.toolName}</span>,
    },
    { id: 'type', header: 'Type', hideBelow: 'md', cell: (row) => row.toolType },
    {
      id: 'calls',
      header: header('Calls', 'calls'),
      align: 'right',
      cell: (row) => <span className={numClass}>{formatCount(row.calls)}</span>,
    },
    {
      id: 'failed',
      header: header('Failed', 'failed'),
      align: 'right',
      cell: (row) => (
        <span className={row.failed > 0 ? 'mono tnum text-bad' : numClass}>
          {formatCount(row.failed)}
        </span>
      ),
    },
    {
      id: 'rejected',
      header: header('Rejected', 'rejected'),
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => (
        <span className={row.rejected > 0 ? 'mono tnum text-warn' : numClass}>
          {formatCount(row.rejected)}
        </span>
      ),
    },
    {
      id: 'avg',
      header: header('Avg duration', 'avgDurationMs'),
      align: 'right',
      hideBelow: 'lg',
      cell: duration('avgDurationMs'),
    },
    {
      id: 'p50',
      header: header('p50', 'p50ExecutionMs'),
      align: 'right',
      hideBelow: 'md',
      cell: duration('p50ExecutionMs'),
    },
    {
      id: 'p95',
      header: header('p95', 'p95ExecutionMs'),
      align: 'right',
      hideBelow: 'md',
      cell: duration('p95ExecutionMs'),
    },
  ];
}

/** Headline numbers over every tool. */
export function ToolTotals({ rows }: { rows: PerToolStatRow[] }) {
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  const rejected = rows.reduce((sum, row) => sum + row.rejected, 0);
  return (
    <MetricGrid className="md:grid-cols-4">
      <MetricCard label="Tools" value={formatCount(rows.length)} caption="called at least once" />
      <MetricCard label="Calls" value={formatCount(calls)} caption="all tools" tone="info" />
      <MetricCard
        label="Failure share"
        value={calls > 0 ? formatPercent(failed / calls) : '—'}
        caption={`${formatCount(failed)} failed calls`}
        tone={failed > 0 ? 'bad' : 'good'}
      />
      <MetricCard
        label="Rejections"
        value={formatCount(rejected)}
        caption="denied by a human"
        tone={rejected > 0 ? 'warn' : 'default'}
      />
    </MetricGrid>
  );
}

/**
 * The per-tool call/failure/rejection/latency rollup from `GET /agent/governance/tools/stats`
 * (container), as a sortable table (most-called first; a header click toggles the column/direction).
 */
export function ToolsSection() {
  const statsState = useToolStats();
  const stats = asQuery(statsState);
  const [sort, setSort] = useState<Sort>({ key: 'calls', dir: 'desc' });

  const toggle = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'toolName' ? 'asc' : 'desc' },
    );

  const columns = toolColumns(sort, toggle);
  const sorted = useMemo(
    () => statsState.data && [...statsState.data].sort((a, b) => compare(a, b, sort.key, sort.dir)),
    [statsState.data, sort],
  );

  return (
    <PageBody>
      <PageHeader
        title="Tools"
        description="Calls, failures, rejections and execution latency per tool."
      />
      <ErrorBoundary label="Tool totals">
        <QueryBoundary query={stats} label="Tools" skeleton={<MetricGridSkeleton count={4} />}>
          {(rows) => <ToolTotals rows={rows} />}
        </QueryBoundary>
      </ErrorBoundary>
      <ErrorBoundary label="Per-tool stats">
        <Panel title="Per tool" description="click a column to sort" flush>
          <QueryBoundary
            query={{ ...stats, data: stats.data === undefined ? undefined : sorted }}
            label="Tool stats"
            skeleton={<TableSkeleton columns={columns} rows={6} />}
            isEmpty={(rows) => rows.length === 0}
            empty={<EmptyState title="No tool calls recorded yet." />}
          >
            {(rows) => (
              <DataTable
                label="tool stats"
                columns={columns}
                rows={rows}
                rowKey={(row) => `${row.toolName}-${row.toolType}`}
              />
            )}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
