import { useMemo, useState } from 'react';
import { pageTenant } from '../client/agent-client.js';
import { formatCount, formatDuration, formatTimestamp, formatUsd } from '../client/format.js';
import type { ListRunsFilter, RunStatus } from '../client/types.js';
import { RunDetailView } from './RunDetailView.js';
import { Empty, ErrorNote, Panel, SectionTitle, Skeleton, StatusPill } from './ui.js';
import { useRuns } from './use-governance.js';

const STATUSES: RunStatus[] = ['running', 'completed', 'failed', 'cancelled'];

/**
 * The run governance list from `GET /agent/governance/runs`: a status/agent/actor filter bar over a
 * newest-first table, forward-paginated with the server's opaque `nextCursor`. Clicking a row opens
 * the full {@link RunDetailView} trace; the "Back to runs" control returns to the filtered list.
 */
export function RunsSection({ initialRunId = null }: { initialRunId?: string | null } = {}) {
  const [selected, setSelected] = useState<string | null>(initialRunId);
  const [actor, setActor] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState<'' | RunStatus>('');

  const filter = useMemo<ListRunsFilter>(
    () => ({
      ...(actor ? { actor } : {}),
      ...(agent ? { agent } : {}),
      ...(status ? { status } : {}),
    }),
    [actor, agent, status],
  );

  const { runs, nextCursor, loading, error, loadMore } = useRuns(filter);

  // Across several organizations (tenancy, no single one picked), say whose each run is.
  const showTenant = pageTenant() === null && runs.some((run) => run.tenantRef != null);

  if (selected) return <RunDetailView runId={selected} onBack={() => setSelected(null)} />;

  return (
    <Panel>
      <SectionTitle title="Runs" hint="newest first" />
      <div className="controls" style={{ marginBottom: 14 }}>
        <select
          className="range-input"
          aria-label="status filter"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | RunStatus)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          className="range-input"
          aria-label="agent filter"
          placeholder="agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        />
        <input
          className="range-input"
          aria-label="actor filter"
          placeholder="actor"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
      </div>

      {error ? (
        <ErrorNote error={error} />
      ) : loading && runs.length === 0 ? (
        <Skeleton rows={6} />
      ) : runs.length === 0 ? (
        <Empty>No runs match this filter.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Agent</th>
                  <th>Actor</th>
                  {showTenant && <th>Organization</th>}
                  <th>Status</th>
                  <th className="num">Steps</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">Duration</th>
                  <th className="num">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.runId}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => setSelected(run.runId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(run.runId);
                      }
                    }}
                    title={run.runId}
                  >
                    <td className="mono">{run.runId.slice(0, 8)}…</td>
                    <td>{run.agentName ?? <span className="muted">—</span>}</td>
                    <td className="mono muted" title={run.actorRef}>
                      {run.actorRef}
                    </td>
                    {showTenant && <td className="mono muted">{run.tenantRef ?? '—'}</td>}
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td className="num mono tnum">{formatCount(run.stepCount)}</td>
                    <td className="num mono tnum">
                      {formatCount(run.inputTokens + run.outputTokens)}
                    </td>
                    <td className="num mono tnum">
                      {run.costUsd === null ? '—' : formatUsd(run.costUsd)}
                    </td>
                    <td className="num mono tnum muted">{formatDuration(run.durationMs)}</td>
                    <td className="num mono tnum muted">{formatTimestamp(run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor !== null && (
            <div className="controls" style={{ justifyContent: 'center', marginTop: 14 }}>
              <button type="button" className="btn" disabled={loading} onClick={loadMore}>
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
