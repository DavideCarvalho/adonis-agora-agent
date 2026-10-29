import {
  formatCount,
  formatDuration,
  formatModelLabel,
  formatTimestamp,
  formatUsd,
} from '../client/format.js';
import type { RunDetail, RunToolCallRow } from '../client/types.js';
import { AsyncBlock, colorAt, Panel, SectionTitle, Stat, StatusPill } from './ui.js';
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
    <Panel>
      <SectionTitle
        title="Where the time went"
        hint={
          timings
            ? `${formatCount(timings.modelCalls)} model calls · ${formatCount(timings.toolCalls)} tool calls`
            : 'queue time only'
        }
      />
      <div
        className="timing-bar"
        role="img"
        aria-label={parts.map((part) => `${part.label} ${formatDuration(part.ms)}`).join(', ')}
        style={{ display: 'flex', height: 10, borderRadius: 4, overflow: 'hidden', gap: 1 }}
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
      <div className="legend" style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
        {parts.map((part, i) => (
          <div className="row" key={part.label}>
            <span className="swatch" style={{ background: colorAt(i) }} />
            <span className="name">{part.label}</span>
            <span className="mono tnum muted">{formatDuration(part.ms)}</span>
          </div>
        ))}
      </div>
      {timings && timings.steps.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th className="num">Model</th>
                <th className="num">Tools</th>
                <th>Tool calls</th>
              </tr>
            </thead>
            <tbody>
              {timings.steps.map((step) => (
                <tr key={step.step}>
                  <td className="mono">{step.step + 1}</td>
                  <td className="num mono tnum">{formatDuration(step.modelMs ?? null)}</td>
                  <td className="num mono tnum">
                    {formatDuration(step.tools.length > 0 ? step.toolsMs : null)}
                  </td>
                  <td className="mono muted">
                    {step.tools.length === 0
                      ? '—'
                      : step.tools
                          .map((tool) => `${tool.toolName} ${formatDuration(tool.ms)}`)
                          .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
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

              <TimingPanel detail={data} />

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
                          <th>Feature</th>
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
                            <td className="mono muted">{u.feature ?? '—'}</td>
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
