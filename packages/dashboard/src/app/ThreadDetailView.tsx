import { formatCount, formatTimestamp, formatUsd } from '../client/format.js';
import { AsyncBlock, Empty, Panel, SectionTitle, Stat, StatusPill } from './ui.js';
import { useThreadDetail } from './use-governance.js';

/**
 * The thread governance drill-down from `GET /agent/governance/threads/:id`: a soft-delete banner
 * (when applicable), LIFETIME usage stat tiles (deliberately not range-scoped — a thread's total spend
 * doesn't reset with the header's day picker), its most recent runs, and its most recent messages. All
 * read-only, mirroring {@link import('./RunDetailView.js').RunDetailView}'s shape.
 */
export function ThreadDetailView({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const detail = useThreadDetail(threadId);
  return (
    <div className="stack">
      <div className="controls">
        <button type="button" className="btn" onClick={onBack}>
          ← Back to threads
        </button>
        <span className="mono muted" title={threadId}>
          thread {threadId.slice(0, 12)}…
        </span>
      </div>

      <AsyncBlock
        state={detail}
        isEmpty={(d) => d === null}
        empty="Thread not found."
        skeletonRows={6}
      >
        {(data) => {
          const { title, actorRef, deleted, usage, runs, messages } = data;
          return (
            <div className="stack">
              {deleted && (
                <Panel>
                  <div className="err">
                    This thread has been deleted. Showing its last known record.
                  </div>
                </Panel>
              )}

              <Panel>
                <SectionTitle title={title || 'untitled'} hint={actorRef} />
                <div className="grid stat-4">
                  <Stat
                    label="Lifetime tokens"
                    value={formatCount(usage.totalTokens)}
                    sub="all time"
                  />
                  <Stat
                    label="Lifetime cost"
                    value={usage.costUsd === null ? '—' : formatUsd(usage.costUsd)}
                    sub="all time"
                  />
                  <Stat label="Runs" value={formatCount(usage.runCount)} sub="all time" />
                  <Stat label="Messages" value={formatCount(usage.messageCount)} sub="all time" />
                </div>
              </Panel>

              <Panel>
                <SectionTitle title="Recent runs" hint={`${runs.length} shown`} />
                {runs.length === 0 ? (
                  <Empty>No runs recorded for this thread.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Run</th>
                          <th>Agent</th>
                          <th>Status</th>
                          <th className="num">Tokens</th>
                          <th className="num">Cost</th>
                          <th className="num">Started</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.runId} title={run.runId}>
                            <td className="mono">{run.runId.slice(0, 8)}…</td>
                            <td>{run.agentName ?? <span className="muted">—</span>}</td>
                            <td>
                              <StatusPill status={run.status} />
                            </td>
                            <td className="num mono tnum">
                              {formatCount(run.inputTokens + run.outputTokens)}
                            </td>
                            <td className="num mono tnum">
                              {run.costUsd === null ? '—' : formatUsd(run.costUsd)}
                            </td>
                            <td className="num mono tnum muted">
                              {formatTimestamp(run.startedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel>
                <SectionTitle title="Recent messages" hint={`${messages.length} shown`} />
                {messages.length === 0 ? (
                  <Empty>No messages recorded for this thread.</Empty>
                ) : (
                  <div className="stack">
                    {messages.map((m) => (
                      <div key={m.id} className="msg">
                        <div className="msg-head">
                          <StatusPill status={m.role} />
                          <span className="num mono tnum muted">
                            {formatTimestamp(m.createdAt)}
                          </span>
                        </div>
                        <div className="msg-body">{m.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          );
        }}
      </AsyncBlock>
    </div>
  );
}
