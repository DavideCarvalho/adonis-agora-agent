import {
  formatCount,
  formatDuration,
  formatModelLabel,
  formatTimestamp,
  formatUsd,
} from '../client/format.js';
import type { RunToolCallRow } from '../client/types.js';
import { AsyncBlock, Panel, SectionTitle, Stat, StatusPill } from './ui.js';
import { useRunDetail } from './use-governance.js';

/** Render an arbitrary tool input/output payload as compact one-line JSON (`—` when absent). */
function payload(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One tool-call row shared by the run's tool-call table and its pending-approvals subset. */
function ToolCallRow({ row }: { row: RunToolCallRow }) {
  return (
    <tr>
      <td className="mono">{row.toolName}</td>
      <td className="muted">{row.toolType}</td>
      <td>
        <StatusPill status={row.status} />
      </td>
      <td className="mono muted" title={payload(row.input)}>
        {payload(row.input).slice(0, 48)}
      </td>
      <td className="num mono tnum muted">{formatDuration(row.executionMs)}</td>
      <td className="num mono tnum muted">{formatTimestamp(row.createdAt)}</td>
    </tr>
  );
}

/**
 * The full trace of one run from `GET /agent/governance/runs/:id`: a summary stat row, its message
 * timeline, its tool calls (with the pending-approval subset called out), and its usage ledger. All
 * read-only; the approve/reject actions live in the dedicated Approvals inbox.
 */
export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const detail = useRunDetail(runId);
  return (
    <div className="stack">
      <div className="controls">
        <button type="button" className="btn" onClick={onBack}>
          ← Back to runs
        </button>
        <span className="mono muted" title={runId}>
          run {runId.slice(0, 12)}…
        </span>
      </div>

      <AsyncBlock
        state={detail}
        isEmpty={(d) => d === null}
        empty="Run not found."
        skeletonRows={6}
      >
        {(data) => {
          const { run, messages, toolCalls, approvals, usage } = data;
          return (
            <div className="stack">
              <div className="grid stat-4">
                <Stat
                  label="Status"
                  value={<StatusPill status={run.status} />}
                  sub={run.agentName ?? 'agent'}
                />
                <Stat
                  label="Steps"
                  value={formatCount(run.stepCount)}
                  sub={run.durable ? 'durable' : 'inline'}
                />
                <Stat
                  label="Tokens"
                  value={formatCount(run.inputTokens + run.outputTokens)}
                  sub={`${formatCount(run.inputTokens)} in · ${formatCount(run.outputTokens)} out`}
                />
                <Stat
                  label="Cost"
                  value={run.costUsd === null ? '—' : formatUsd(run.costUsd)}
                  sub={`${formatDuration(run.durationMs)} · ${formatTimestamp(run.startedAt)}`}
                />
              </div>

              {run.error && (
                <Panel>
                  <div className="err">{run.error}</div>
                </Panel>
              )}

              <Panel>
                <SectionTitle title="Messages" hint={`${messages.length} in trace`} />
                {messages.length === 0 ? (
                  <div className="empty">No messages recorded.</div>
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

              {approvals.length > 0 && (
                <Panel>
                  <SectionTitle title="Pending approvals" hint="awaiting a HITL decision" />
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Tool</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Input</th>
                          <th className="num">Duration</th>
                          <th className="num">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {approvals.map((row) => (
                          <ToolCallRow key={row.toolCallId} row={row} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <Panel>
                <SectionTitle title="Tool calls" hint={`${toolCalls.length} total`} />
                {toolCalls.length === 0 ? (
                  <div className="empty">No tool calls in this run.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Tool</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Input</th>
                          <th className="num">Duration</th>
                          <th className="num">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {toolCalls.map((row) => (
                          <ToolCallRow key={row.toolCallId} row={row} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel>
                <SectionTitle title="Usage" hint="model calls in this run" />
                {usage.length === 0 ? (
                  <div className="empty">No usage recorded.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Purpose</th>
                          <th className="num">Tokens</th>
                          <th className="num">Cost</th>
                          <th className="num">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.map((u, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: usage rows have no stable id and (modelId, purpose) can repeat
                          <tr key={`${u.modelId}-${u.purpose}-${i}`}>
                            <td title={u.modelId}>{formatModelLabel(u.modelId)}</td>
                            <td className="muted">{u.purpose}</td>
                            <td className="num mono tnum">
                              {formatCount(u.inputTokens + u.outputTokens)}
                            </td>
                            <td className="num mono tnum">
                              {u.costUsd === null ? '—' : formatUsd(u.costUsd)}
                            </td>
                            <td className="num mono tnum muted">{formatTimestamp(u.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
