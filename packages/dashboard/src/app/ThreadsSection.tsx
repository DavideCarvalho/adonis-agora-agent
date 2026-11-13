import { useState } from 'react';
import { formatCount, formatTimestamp } from '../client/format.js';
import { ThreadDetailView } from './ThreadDetailView.js';
import { AsyncBlock, Panel, SectionTitle } from './ui.js';
import { useRecentThreads } from './use-governance.js';

/**
 * Newest-first recent threads with message count + rolled-up token total, from `threads/recent`.
 * Clicking a row opens the {@link ThreadDetailView} drill-down; "Load more" appends the next page.
 */
export function ThreadsSection({
  pageSize = 25,
  initialThreadId = null,
}: {
  pageSize?: number;
  initialThreadId?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(initialThreadId);
  const threads = useRecentThreads(pageSize);

  if (selected) return <ThreadDetailView threadId={selected} onBack={() => setSelected(null)} />;

  return (
    <Panel>
      <SectionTitle title="Recent threads" hint="newest first" />
      <AsyncBlock
        state={threads}
        isEmpty={(rows) => rows.length === 0}
        empty="No threads yet."
        skeletonRows={6}
      >
        {(rows) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Thread</th>
                    <th>Actor</th>
                    <th className="num">Messages</th>
                    <th className="num">Tokens</th>
                    <th className="num">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.threadId}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => setSelected(row.threadId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(row.threadId);
                        }
                      }}
                      title={row.threadId}
                    >
                      <td>{row.title || <span className="muted">untitled</span>}</td>
                      <td className="mono muted" title={row.actorRef}>
                        {row.actorRef}
                      </td>
                      <td className="num mono tnum">{formatCount(row.messageCount)}</td>
                      <td className="num mono tnum">{formatCount(row.totalTokens)}</td>
                      <td className="num mono tnum muted">{formatTimestamp(row.lastActivityAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {threads.nextCursor !== null && (
              <div className="controls" style={{ justifyContent: 'center', marginTop: 14 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={threads.loading}
                  onClick={threads.loadMore}
                >
                  {threads.loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </AsyncBlock>
    </Panel>
  );
}
