import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../agora-kit/blocks/error-boundary';
import {
  MetricCard,
  MetricGrid,
  MetricGridSkeleton,
  type MetricTone,
} from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import {
  formatCount,
  formatDuration,
  formatModelLabel,
  formatTimestamp,
  formatUsd,
} from '../client/format.js';
import type { RunDetail, RunToolCallRow, RunUsageRow } from '../client/types.js';
import { MessageList } from './MessageList.js';
import {
  BackBar,
  colorAt,
  LegendRow,
  numClass,
  payload,
  StatusBadge,
  TableSkeleton,
} from './ui.js';
import { asQuery, useRunDetail } from './use-governance.js';

const STATUS_TONE: Record<string, MetricTone> = {
  completed: 'good',
  failed: 'bad',
  running: 'info',
  cancelled: 'default',
};

const toolCallColumns: Column<RunToolCallRow>[] = [
  {
    id: 'tool',
    header: 'Tool',
    cell: (row) => <span className="mono text-fg">{row.toolName}</span>,
  },
  { id: 'type', header: 'Type', hideBelow: 'md', cell: (row) => row.toolType },
  { id: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
  {
    id: 'input',
    header: 'Input',
    hideBelow: 'md',
    className: 'max-w-[22rem] truncate',
    cell: (row) => (
      <span className="mono" title={payload(row.input)}>
        {payload(row.input).slice(0, 48)}
      </span>
    ),
  },
  {
    id: 'duration',
    header: 'Duration',
    align: 'right',
    hideBelow: 'sm',
    cell: (row) => <span className={numClass}>{formatDuration(row.executionMs)}</span>,
  },
  {
    id: 'when',
    header: 'When',
    align: 'right',
    hideBelow: 'lg',
    cell: (row) => <span className="mono tnum">{formatTimestamp(row.createdAt)}</span>,
  },
];

/** Usage rows have no stable id and (modelId, purpose) can repeat: key them by position. */
type KeyedUsage = RunUsageRow & { rowKey: string };

const usageColumns: Column<KeyedUsage>[] = [
  {
    id: 'model',
    header: 'Model',
    cell: (u) => (
      <span className="text-fg" title={u.modelId}>
        {formatModelLabel(u.modelId)}
      </span>
    ),
  },
  { id: 'purpose', header: 'Purpose', cell: (u) => u.purpose },
  {
    id: 'feature',
    header: 'Feature',
    hideBelow: 'md',
    cell: (u) => <span className="mono">{u.feature ?? '—'}</span>,
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    cell: (u) => <span className={numClass}>{formatCount(u.inputTokens + u.outputTokens)}</span>,
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'right',
    hideBelow: 'sm',
    cell: (u) => (
      <span className="mono tnum text-fg">{u.costUsd === null ? '—' : formatUsd(u.costUsd)}</span>
    ),
  },
  {
    id: 'when',
    header: 'When',
    align: 'right',
    hideBelow: 'lg',
    cell: (u) => <span className="mono tnum">{formatTimestamp(u.createdAt)}</span>,
  },
];

/**
 * Where a run's time went: queue / model / tools, the rest of the wall-clock (persistence, approval
 * and delegation waits) as "other", and each step's model time and tool calls. Absent when the server
 * recorded no timings for the run (an older server, a run that did not complete).
 */
export function TimingPanel({ detail }: { detail: RunDetail }) {
  const { run, timings } = detail;
  if ((timings === null || timings === undefined) && (run.queueMs ?? null) === null) return null;
  const queue = run.queueMs ?? 0;
  const model = timings?.modelMs ?? 0;
  const tools = timings?.toolsMs ?? 0;
  const other = run.durationMs === null ? 0 : Math.max(0, run.durationMs - model - tools);
  const parts = [
    { label: 'Queue', ms: queue },
    { label: 'Model', ms: model },
    { label: 'Tools', ms: tools },
    { label: 'Other', ms: other },
  ];
  const total = parts.reduce((sum, part) => sum + part.ms, 0);
  return (
    <Panel
      title="Where the time went"
      description={
        timings
          ? `${formatCount(timings.modelCalls)} model calls · ${formatCount(timings.toolCalls)} tool calls`
          : 'queue time only'
      }
    >
      <div
        className="flex h-2.5 gap-px overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={parts.map((part) => `${part.label} ${formatDuration(part.ms)}`).join(', ')}
      >
        {parts.map((part, i) =>
          part.ms > 0 && total > 0 ? (
            <span
              key={part.label}
              title={`${part.label}: ${formatDuration(part.ms)}`}
              style={{ flex: part.ms / total, background: colorAt(i) }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 sm:grid-cols-4">
        {parts.map((part, i) => (
          <LegendRow
            key={part.label}
            color={colorAt(i)}
            name={part.label}
            value={formatDuration(part.ms)}
          />
        ))}
      </div>
      {timings && timings.steps.length > 0 && (
        <div className="-mx-4 mt-3 -mb-4 border-t border-border">
          <DataTable
            label="steps"
            columns={[
              {
                id: 'step',
                header: 'Step',
                cell: (step) => <span className="mono text-fg">{step.step + 1}</span>,
              },
              {
                id: 'model',
                header: 'Model',
                align: 'right',
                cell: (step) => (
                  <span className={numClass}>{formatDuration(step.modelMs ?? null)}</span>
                ),
              },
              {
                id: 'tools',
                header: 'Tools',
                align: 'right',
                cell: (step) => (
                  <span className={numClass}>
                    {formatDuration(step.tools.length > 0 ? step.toolsMs : null)}
                  </span>
                ),
              },
              {
                id: 'calls',
                header: 'Tool calls',
                hideBelow: 'sm',
                cell: (step) => (
                  <span className="mono">
                    {step.tools.length === 0
                      ? '—'
                      : step.tools
                          .map((tool) => `${tool.toolName} ${formatDuration(tool.ms)}`)
                          .join(' · ')}
                  </span>
                ),
              },
            ]}
            rows={timings.steps}
            rowKey={(step) => String(step.step)}
          />
        </div>
      )}
    </Panel>
  );
}

/**
 * One run's full trace from `GET /agent/governance/runs/:id` (container): summary metrics, timing,
 * its message timeline, its tool calls (the pending-approval subset called out) and its usage
 * ledger. Read-only; approve/reject live in the Approvals inbox.
 */
export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const detail = asQuery(useRunDetail(runId));
  return (
    <>
      <BackBar label="Back to runs" onBack={onBack} id={runId} kind="run" />
      <QueryBoundary
        query={detail}
        label="Run"
        skeleton={
          <>
            <MetricGridSkeleton count={4} />
            <TableSkeleton columns={toolCallColumns} rows={4} />
          </>
        }
        isEmpty={(d) => d === null}
        empty={
          <EmptyState
            title="Run not found."
            description="It may have been pruned, or it belongs to another organization."
          />
        }
      >
        {(data) => (data === null ? null : <RunDetailBody detail={data} />)}
      </QueryBoundary>
    </>
  );
}

/** The run detail (presentational). */
export function RunDetailBody({ detail }: { detail: RunDetail }) {
  const { run, messages, toolCalls, approvals, usage } = detail;
  return (
    <>
      <PageHeader
        title={run.agentName ?? 'Run'}
        description={
          <span className="mono">
            {run.runId} · {run.actorRef} · started {formatTimestamp(run.startedAt)}
          </span>
        }
        actions={<StatusBadge status={run.status} />}
      />
      <MetricGrid className="md:grid-cols-4">
        <MetricCard
          label="Status"
          value={run.status}
          caption={run.agentName ?? 'agent'}
          tone={STATUS_TONE[run.status] ?? 'default'}
        />
        <MetricCard
          label="Steps"
          value={formatCount(run.stepCount)}
          caption={run.durable ? 'durable' : 'inline'}
        />
        <MetricCard
          label="Tokens"
          value={formatCount(run.inputTokens + run.outputTokens)}
          caption={`${formatCount(run.inputTokens)} in · ${formatCount(run.outputTokens)} out`}
          tone="info"
        />
        <MetricCard
          label="Cost"
          value={run.costUsd === null ? '—' : formatUsd(run.costUsd)}
          caption={`${formatDuration(run.durationMs)} · ${formatTimestamp(run.startedAt)}`}
          tone="brand"
        />
      </MetricGrid>

      {run.error && <RegionError title="The run failed" error={run.error} />}

      <ErrorBoundary label="Timing">
        <TimingPanel detail={detail} />
      </ErrorBoundary>

      <ErrorBoundary label="Messages">
        <Panel title="Messages" description={`${messages.length} in trace`}>
          {messages.length === 0 ? (
            <EmptyState title="No messages recorded." className="p-4" />
          ) : (
            <MessageList messages={messages} />
          )}
        </Panel>
      </ErrorBoundary>

      {approvals.length > 0 && (
        <ErrorBoundary label="Pending approvals">
          <Panel title="Pending approvals" description="awaiting a HITL decision" flush>
            <DataTable
              columns={toolCallColumns}
              rows={approvals}
              rowKey={(row) => row.toolCallId}
            />
          </Panel>
        </ErrorBoundary>
      )}

      <ErrorBoundary label="Tool calls">
        <Panel title="Tool calls" description={`${toolCalls.length} total`} flush>
          <DataTable
            columns={toolCallColumns}
            rows={toolCalls}
            rowKey={(row) => row.toolCallId}
            empty={<EmptyState title="No tool calls in this run." />}
          />
        </Panel>
      </ErrorBoundary>

      <ErrorBoundary label="Usage">
        <Panel title="Usage" description="model calls in this run" flush>
          <DataTable
            columns={usageColumns}
            rows={usage.map((u, i) => ({ ...u, rowKey: String(i) }))}
            rowKey={(u) => u.rowKey}
            empty={<EmptyState title="No usage recorded." />}
          />
        </Panel>
      </ErrorBoundary>
    </>
  );
}
