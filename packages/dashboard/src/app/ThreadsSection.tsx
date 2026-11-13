import { useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { LoadMore } from '../agora-kit/blocks/pager';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { formatCount, formatTimestamp } from '../client/format.js';
import type { ThreadActivityRow } from '../client/types.js';
import { ThreadDetailView } from './ThreadDetailView.js';
import { numClass, TableSkeleton } from './ui.js';
import { asQuery, useRecentThreads } from './use-governance.js';

/** Keep the URL on the open thread (`#threads/<id>`) without re-routing. */
function syncThreadHash(threadId: string | null): void {
  if (typeof window === 'undefined') return;
  const hash = threadId === null ? '#threads' : `#threads/${encodeURIComponent(threadId)}`;
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
}

const threadColumns: Column<ThreadActivityRow>[] = [
  {
    id: 'thread',
    header: 'Thread',
    cell: (row) =>
      row.title ? (
        <span className="text-fg">{row.title}</span>
      ) : (
        <span className="text-faint italic">untitled</span>
      ),
  },
  {
    id: 'actor',
    header: 'Actor',
    hideBelow: 'sm',
    cell: (row) => (
      <span className="mono" title={row.actorRef}>
        {row.actorRef}
      </span>
    ),
  },
  {
    id: 'messages',
    header: 'Messages',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => <span className={numClass}>{formatCount(row.messageCount)}</span>,
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'right',
    cell: (row) => <span className={numClass}>{formatCount(row.totalTokens)}</span>,
  },
  {
    id: 'last',
    header: 'Last activity',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => <span className="mono tnum">{formatTimestamp(row.lastActivityAt)}</span>,
  },
];

/**
 * Newest-first recent threads from `threads/recent` (container), cursor-paged (Load more). A row
 * opens the {@link ThreadDetailView} drill-down.
 */
export function ThreadsSection({
  pageSize = 25,
  initialThreadId = null,
}: {
  pageSize?: number;
  initialThreadId?: string | null;
}) {
  const [selected, setSelectedState] = useState<string | null>(initialThreadId);
  const threads = useRecentThreads(pageSize);
  const setSelected = (id: string | null) => {
    setSelectedState(id);
    syncThreadHash(id);
  };

  if (selected) {
    return (
      <PageBody>
        <ErrorBoundary label="Thread" resetKeys={[selected]}>
          <ThreadDetailView threadId={selected} onBack={() => setSelected(null)} />
        </ErrorBoundary>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="Threads"
        description="Conversations by last activity, with their message count and token total."
      />
      <ErrorBoundary label="Threads list">
        <Panel title="Recent threads" description="newest first" flush>
          <QueryBoundary
            query={asQuery(threads)}
            label="Threads"
            skeleton={<TableSkeleton columns={threadColumns} rows={8} />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                title="No threads yet."
                description="A thread appears once someone talks to an agent."
              />
            }
          >
            {(rows) => (
              <DataTable
                label="threads"
                columns={threadColumns}
                rows={rows}
                rowKey={(row) => row.threadId}
                onRowClick={(row) => setSelected(row.threadId)}
              />
            )}
          </QueryBoundary>
          <LoadMore
            hasNext={threads.nextCursor !== null}
            loading={threads.loading && threads.data !== undefined}
            onLoadMore={threads.loadMore}
            className="border-t border-border"
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
