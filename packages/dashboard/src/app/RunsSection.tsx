import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useMemo, useState } from 'react';
import { ComboSelect } from '../agora-kit/blocks/combo-field';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { LoadMore } from '../agora-kit/blocks/pager';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { splitHash } from '../agora-kit/url-state/hash-url';
import { pageTenant } from '../client/agent-client.js';
import { defaultRange } from '../client/default-range.js';
import { formatCount, formatDuration, formatTimestamp, formatUsd } from '../client/format.js';
import type { ListRunsFilter, RunStatus, RunSummaryRow } from '../client/types.js';
import { RunDetailView } from './RunDetailView.js';
import { fieldClass, numClass, StatusBadge, TableSkeleton } from './ui.js';
import { hashWith } from './url-state.js';
import { asQuery, useReliability, useRuns, useSpendByActor } from './use-governance.js';

const STATUSES: RunStatus[] = ['running', 'completed', 'failed', 'cancelled'];

/** Keep the URL on the open run (`#runs/<id>`) without re-routing, so a reload or a copy keeps it.
 *  The list's filters stay in the query, so the back button returns to the filtered list. */
function syncRunHash(runId: string | null): void {
  if (typeof window === 'undefined') return;
  const path = runId === null ? 'runs' : `runs/${encodeURIComponent(runId)}`;
  const hash = hashWith(path, splitHash(window.location.hash).search);
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
}

/**
 * The run list's filters, in the hash's query (`#runs?status=failed&agent=support`). Picking a
 * status adds a history entry; picking the agent or actor rewrites the current one.
 */
export const runFilterParams = {
  status: parseAsStringLiteral(['', ...STATUSES] as const)
    .withDefault('')
    .withOptions({ history: 'push' }),
  agent: parseAsString.withDefault(''),
  actor: parseAsString.withDefault(''),
};

/**
 * The run list from `GET /agent/governance/runs` (container): a status/agent/actor filter toolbar
 * over a newest-first table, cursor-paged (`meta.nextCursor` → Load more). A row opens the run's
 * {@link RunDetailView}; its back button returns to the filtered list.
 */
export function RunsSection({ initialRunId = null }: { initialRunId?: string | null } = {}) {
  const [selected, setSelectedState] = useState<string | null>(initialRunId);
  const [{ actor, agent, status }, setFilters] = useQueryStates(runFilterParams);
  const setSelected = (id: string | null) => {
    setSelectedState(id);
    syncRunHash(id);
  };

  const filter = useMemo<ListRunsFilter>(
    () => ({
      ...(actor ? { actor } : {}),
      ...(agent ? { agent } : {}),
      ...(status ? { status } : {}),
    }),
    [actor, agent, status],
  );

  const runs = useRuns(filter);
  const { agents, actors } = useRunFilterOptions();

  if (selected) {
    return (
      <PageBody>
        <ErrorBoundary label="Run" resetKeys={[selected]}>
          <RunDetailView runId={selected} onBack={() => setSelected(null)} />
        </ErrorBoundary>
      </PageBody>
    );
  }

  // Across several organizations (tenancy, no single one picked), say whose each run is.
  const showTenant =
    pageTenant() === null && (runs.data ?? []).some((run) => run.tenantRef != null);

  return (
    <PageBody>
      <PageHeader
        title="Runs"
        description="Every agent run, newest first: status, steps, tokens, cost and time."
      />
      <Toolbar label="run filters">
        <select
          className={fieldClass}
          aria-label="status filter"
          value={status}
          onChange={(e) => void setFilters({ status: e.target.value as '' | RunStatus })}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <ComboSelect
          className={comboClass}
          aria-label="agent filter"
          placeholder="agent"
          options={agents.options}
          loading={agents.loading}
          creatable
          value={agent || null}
          onValueChange={(next) => void setFilters({ agent: next ?? '' })}
        />
        <ComboSelect
          className={comboClass}
          aria-label="actor filter"
          placeholder="actor"
          options={actors.options}
          loading={actors.loading}
          creatable
          value={actor || null}
          onValueChange={(next) => void setFilters({ actor: next ?? '' })}
        />
      </Toolbar>
      <ErrorBoundary label="Runs list" resetKeys={[actor, agent, status]}>
        <Panel
          title="Runs"
          description={runs.data ? `${runs.data.length} loaded · newest first` : 'newest first'}
          flush
        >
          <QueryBoundary
            query={asQuery(runs)}
            label="Runs"
            skeleton={<TableSkeleton columns={runColumns(false)} rows={8} />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                title="No runs match this filter."
                description="Clear a filter, or wait for an agent to run."
              />
            }
          >
            {(rows) => (
              <RunsTable
                rows={rows}
                showTenant={showTenant}
                onOpen={(row) => setSelected(row.runId)}
              />
            )}
          </QueryBoundary>
          <LoadMore
            hasNext={runs.nextCursor !== null}
            loading={runs.loading && runs.data !== undefined}
            onLoadMore={runs.loadMore}
            className="border-t border-border"
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}

/** The filter combos' look: the toolbar's field height and surface. */
const comboClass = 'h-8 w-44 bg-panel-2 text-xs';

/**
 * Suggestions for the agent and actor filters: the agents that ran in the trailing 30 days (the
 * reliability rollup's `byAgent`) and the actors that spent in them. Both lists can miss a name
 * (older runs), so the filters stay creatable.
 */
function useRunFilterOptions() {
  const [range] = useState(() => defaultRange(new Date(), 30));
  const reliability = useReliability();
  const spend = useSpendByActor(range);
  const agents = useMemo(
    () =>
      (reliability.data?.byAgent ?? []).flatMap((row) =>
        row.agentName ? [{ value: row.agentName, hint: `${formatCount(row.runs)} runs` }] : [],
      ),
    [reliability.data],
  );
  const actors = useMemo(
    () => (spend.data ?? []).map((row) => ({ value: row.actorRef })),
    [spend.data],
  );
  return {
    agents: { options: agents, loading: reliability.loading },
    actors: { options: actors, loading: spend.loading },
  };
}

function runColumns(showTenant: boolean): Column<RunSummaryRow>[] {
  return [
    {
      id: 'run',
      header: 'Run',
      cell: (run) => <span className="mono text-fg">{run.runId.slice(0, 8)}…</span>,
    },
    {
      id: 'agent',
      header: 'Agent',
      cell: (run) => <span className="text-fg-2">{run.agentName ?? '—'}</span>,
    },
    {
      id: 'actor',
      header: 'Actor',
      hideBelow: 'md',
      cell: (run) => (
        <span className="mono" title={run.actorRef}>
          {run.actorRef}
        </span>
      ),
    },
    ...(showTenant
      ? [
          {
            id: 'tenant',
            header: 'Organization',
            hideBelow: 'lg',
            cell: (run: RunSummaryRow) => <span className="mono">{run.tenantRef ?? '—'}</span>,
          } satisfies Column<RunSummaryRow>,
        ]
      : []),
    { id: 'status', header: 'Status', cell: (run) => <StatusBadge status={run.status} /> },
    {
      id: 'steps',
      header: 'Steps',
      align: 'right',
      hideBelow: 'lg',
      cell: (run) => <span className={numClass}>{formatCount(run.stepCount)}</span>,
    },
    {
      id: 'tokens',
      header: 'Tokens',
      align: 'right',
      hideBelow: 'md',
      cell: (run) => (
        <span className={numClass}>{formatCount(run.inputTokens + run.outputTokens)}</span>
      ),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      hideBelow: 'sm',
      cell: (run) => (
        <span className="mono tnum text-fg">
          {run.costUsd === null ? '—' : formatUsd(run.costUsd)}
        </span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'right',
      hideBelow: 'lg',
      cell: (run) => <span className="mono tnum">{formatDuration(run.durationMs)}</span>,
    },
    {
      id: 'started',
      header: 'Started',
      align: 'right',
      hideBelow: 'md',
      cell: (run) => <span className="mono tnum">{formatTimestamp(run.startedAt)}</span>,
    },
  ];
}

/** The runs table (presentational): a row opens the run. */
export function RunsTable({
  rows,
  showTenant,
  onOpen,
}: {
  rows: RunSummaryRow[];
  showTenant: boolean;
  onOpen: (row: RunSummaryRow) => void;
}) {
  return (
    <DataTable
      label="runs"
      columns={runColumns(showTenant)}
      rows={rows}
      rowKey={(run) => run.runId}
      onRowClick={onOpen}
    />
  );
}
