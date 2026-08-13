import { useMemo, useState } from 'react';
import { formatCount, formatDuration } from '../client/format.js';
import type { PerToolStatRow } from '../client/types.js';
import { AsyncBlock, Panel, SectionTitle } from './ui.js';
import { useToolStats } from './use-governance.js';

type SortKey = 'toolName' | 'calls' | 'failed' | 'rejected' | 'avgDurationMs';
type SortDir = 'asc' | 'desc';

/** Compare two per-tool rows on `key`; `null` durations always sort last regardless of direction. */
function compare(a: PerToolStatRow, b: PerToolStatRow, key: SortKey, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'toolName') return sign * a.toolName.localeCompare(b.toolName);
  const av = a[key];
  const bv = b[key];
  if (av === null) return 1;
  if (bv === null) return -1;
  return sign * (av - bv);
}

/**
 * The per-tool call/failure/rejection/latency rollup from `GET /agent/governance/tools/stats`, as a
 * sortable table. Clicking a numeric header toggles the sort column/direction (defaults to most-called
 * first); the failure and rejection counts read against the total calls per tool.
 */
export function ToolsSection() {
  const stats = useToolStats();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'calls', dir: 'desc' });

  const sorted = useMemo(() => {
    if (stats.data === null) return null;
    return [...stats.data].sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [stats.data, sort]);

  const toggle = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'toolName' ? 'asc' : 'desc' },
    );

  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <Panel>
      <SectionTitle title="Tools" hint="calls, failures & latency per tool" />
      <AsyncBlock
        state={{ data: sorted, loading: stats.loading, error: stats.error }}
        isEmpty={(rows) => rows.length === 0}
        empty="No tool calls recorded yet."
        skeletonRows={6}
      >
        {(rows) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <button type="button" className="th-sort" onClick={() => toggle('toolName')}>
                      Tool{arrow('toolName')}
                    </button>
                  </th>
                  <th>Type</th>
                  <th className="num">
                    <button type="button" className="th-sort" onClick={() => toggle('calls')}>
                      Calls{arrow('calls')}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="th-sort" onClick={() => toggle('failed')}>
                      Failed{arrow('failed')}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="th-sort" onClick={() => toggle('rejected')}>
                      Rejected{arrow('rejected')}
                    </button>
                  </th>
                  <th className="num">
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() => toggle('avgDurationMs')}
                    >
                      Avg duration{arrow('avgDurationMs')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.toolName}-${row.toolType}`}>
                    <td className="mono">{row.toolName}</td>
                    <td className="muted">{row.toolType}</td>
                    <td className="num mono tnum">{formatCount(row.calls)}</td>
                    <td className="num mono tnum">
                      {row.failed > 0 ? (
                        <span className="warnnum">{formatCount(row.failed)}</span>
                      ) : (
                        formatCount(row.failed)
                      )}
                    </td>
                    <td className="num mono tnum">{formatCount(row.rejected)}</td>
                    <td className="num mono tnum muted">{formatDuration(row.avgDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBlock>
    </Panel>
  );
}
