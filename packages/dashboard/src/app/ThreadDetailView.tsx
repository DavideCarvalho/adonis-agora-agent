import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { formatCount, formatTimestamp, formatUsd } from '../client/format.js';
import type { GovernanceThreadDetail, RunSummaryRow } from '../client/types.js';
import { MessageList } from './MessageList.js';
import { BackBar, numClass, StatusBadge } from './ui.js';
import { asQuery, useThreadDetail } from './use-governance.js';

const threadRunColumns: Column<RunSummaryRow>[] = [
  {
    id: 'run',
    header: 'Run',
    cell: (run) => (
      <span className="mono text-fg" title={run.runId}>
        {run.runId.slice(0, 8)}…
      </span>
    ),
  },
  { id: 'agent', header: 'Agent', cell: (run) => run.agentName ?? '—' },
  { id: 'status', header: 'Status', cell: (run) => <StatusBadge status={run.status} /> },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    hideBelow: 'sm',
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
    id: 'started',
    header: 'Started',
    align: 'right',
    hideBelow: 'md',
    cell: (run) => <span className="mono tnum">{formatTimestamp(run.startedAt)}</span>,
  },
];

/**
 * One thread's drill-down from `GET /agent/governance/threads/:id` (container): a soft-delete
 * banner when applicable, LIFETIME usage (deliberately not range-scoped — a thread's spend doesn't
 * reset with the day picker), its most recent runs and messages. Read-only.
 */
export function ThreadDetailView({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const detail = asQuery(useThreadDetail(threadId));
  return (
    <>
      <BackBar label="Back to threads" onBack={onBack} id={threadId} kind="thread" />
      <QueryBoundary
        query={detail}
        label="Thread"
        skeleton={<MetricGridSkeleton count={4} />}
        isEmpty={(d) => d === null}
        empty={
          <EmptyState
            title="Thread not found."
            description="It may have been purged, or it belongs to another organization."
          />
        }
      >
        {(data) => (data === null ? null : <ThreadDetailBody detail={data} />)}
      </QueryBoundary>
    </>
  );
}

/** The thread detail (presentational). */
export function ThreadDetailBody({ detail }: { detail: GovernanceThreadDetail }) {
  const { title, actorRef, deleted, usage, runs, messages } = detail;
  return (
    <>
      <PageHeader
        title={title || 'untitled'}
        description={<span className="mono">{actorRef}</span>}
      />
      {deleted && (
        <div
          role="status"
          className="rounded-lg border border-warn/25 bg-warn/5 px-4 py-3 text-xs text-warn"
        >
          This thread has been deleted. Showing its last known record.
        </div>
      )}
      <MetricGrid className="md:grid-cols-4">
        <MetricCard
          label="Lifetime tokens"
          value={formatCount(usage.totalTokens)}
          caption="all time"
          tone="info"
        />
        <MetricCard
          label="Lifetime cost"
          value={usage.costUsd === null ? '—' : formatUsd(usage.costUsd)}
          caption="all time"
          tone="brand"
        />
        <MetricCard label="Runs" value={formatCount(usage.runCount)} caption="all time" />
        <MetricCard label="Messages" value={formatCount(usage.messageCount)} caption="all time" />
      </MetricGrid>

      <ErrorBoundary label="Recent runs">
        <Panel title="Recent runs" description={`${runs.length} shown`} flush>
          <DataTable
            columns={threadRunColumns}
            rows={runs}
            rowKey={(run) => run.runId}
            empty={<EmptyState title="No runs recorded for this thread." />}
          />
        </Panel>
      </ErrorBoundary>

      <ErrorBoundary label="Recent messages">
        <Panel title="Recent messages" description={`${messages.length} shown`}>
          {messages.length === 0 ? (
            <EmptyState title="No messages recorded for this thread." className="p-4" />
          ) : (
            <MessageList messages={messages} />
          )}
        </Panel>
      </ErrorBoundary>
    </>
  );
}
