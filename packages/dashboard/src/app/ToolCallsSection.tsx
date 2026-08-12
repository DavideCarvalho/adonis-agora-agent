import { useState } from 'react';
import { formatTimestamp } from '../client/format.js';
import { AsyncBlock, Panel, SectionTitle, StatusPill } from './ui.js';
import { useRecentToolCalls } from './use-governance.js';

const PAGE_STEP = 25;

/**
 * Newest-first recent tool-call activity feed, from `tool-calls/recent`. "Load more" re-requests the
 * feed with a larger `limit` (the endpoint has no cursor, unlike the runs list).
 */
export function ToolCallsSection({ limit: initialLimit = 25 }: { limit?: number }) {
  const [limit, setLimit] = useState(initialLimit);
  const calls = useRecentToolCalls(limit);
  return (
    <Panel>
      <SectionTitle title="Recent tool calls" hint="newest first" />
      <AsyncBlock
        state={calls}
        isEmpty={(rows) => rows.length === 0}
        empty="No tool calls yet."
        skeletonRows={6}
      >
        {(rows) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Thread</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.toolCallId}>
                      <td className="mono">{row.toolName}</td>
                      <td className="muted">{row.toolType}</td>
                      <td>
                        <StatusPill status={row.status} />
                      </td>
                      <td className="mono muted" title={row.threadId}>
                        {row.threadId ? `${row.threadId.slice(0, 8)}…` : '—'}
                      </td>
                      <td className="num mono tnum muted">{formatTimestamp(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length >= limit && (
              <div className="controls" style={{ justifyContent: 'center', marginTop: 14 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={calls.loading}
                  onClick={() => setLimit((n) => n + PAGE_STEP)}
                >
                  {calls.loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </AsyncBlock>
    </Panel>
  );
}
