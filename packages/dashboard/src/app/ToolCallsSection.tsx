import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { LoadMore } from '../agora-kit/blocks/pager';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { formatTimestamp } from '../client/format.js';
import type { ToolCallActivityRow } from '../client/types.js';
import { StatusBadge, TableSkeleton } from './ui.js';
import { asQuery, useRecentToolCalls } from './use-governance.js';

const toolCallColumns: Column<ToolCallActivityRow>[] = [
  {
    id: 'tool',
    header: 'Tool',
    cell: (row) => <span className="mono text-fg">{row.toolName}</span>,
  },
  { id: 'type', header: 'Type', hideBelow: 'sm', cell: (row) => row.toolType },
  { id: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
  {
    id: 'thread',
    header: 'Thread',
    hideBelow: 'md',
    cell: (row) =>
      row.threadId ? (
        <a
          className="mono text-brand hover:underline"
          href={`#threads/${encodeURIComponent(row.threadId)}`}
          title={row.threadId}
          onClick={(e) => e.stopPropagation()}
        >
          {row.threadId.slice(0, 8)}…
        </a>
      ) : (
        '—'
      ),
  },
  {
    id: 'when',
    header: 'When',
    align: 'right',
    cell: (row) => <span className="mono tnum">{formatTimestamp(row.createdAt)}</span>,
  },
];

/**
 * The newest-first tool-call feed from `tool-calls/recent` (container), cursor-paged (Load more).
 */
export function ToolCallsSection({ pageSize = 25 }: { pageSize?: number }) {
  const calls = useRecentToolCalls(pageSize);
  return (
    <PageBody>
      <PageHeader
        title="Tool calls"
        description="Every tool the agents called, newest first, with its outcome."
      />
      <ErrorBoundary label="Tool calls list">
        <Panel title="Recent tool calls" description="newest first" flush>
          <QueryBoundary
            query={asQuery(calls)}
            label="Tool calls"
            skeleton={<TableSkeleton columns={toolCallColumns} rows={8} />}
            isEmpty={(rows) => rows.length === 0}
            empty={<EmptyState title="No tool calls yet." />}
          >
            {(rows) => (
              <DataTable
                label="tool calls"
                columns={toolCallColumns}
                rows={rows}
                rowKey={(row) => row.toolCallId}
              />
            )}
          </QueryBoundary>
          <LoadMore
            hasNext={calls.nextCursor !== null}
            loading={calls.loading && calls.data !== undefined}
            onLoadMore={calls.loadMore}
            className="border-t border-border"
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
