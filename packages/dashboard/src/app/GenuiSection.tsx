import { useState } from 'react';
import { isUnsupported } from '../client/agent-client.js';
import {
  formatCount,
  formatDuration,
  formatModelLabel,
  formatPercent,
  formatTimestamp,
  formatUsd,
} from '../client/format.js';
import type { TrendMetric } from '../client/trend-path.js';
import type { GenuiStats, GovernanceRange, UsageTrendPoint } from '../client/types.js';
import { TrendChart } from './TrendChart.js';
import { AsyncBlock, Empty, Panel, SectionTitle, ShareBar, Stat } from './ui.js';
import { useGenuiStats } from './use-governance.js';

const usd = (value: number | null) => (value === null ? '—' : formatUsd(value));
const pct = (value: number | null) => (value === null ? '—' : formatPercent(value));

/** The daily rows as the spend page's {@link TrendChart} points (unpriced days plot as $0). */
function trendPoints(stats: GenuiStats): UsageTrendPoint[] {
  return stats.byDay.map((day) => ({
    day: day.day,
    totalTokens: day.inputTokens + day.outputTokens,
    costUsd: day.costUsd ?? 0,
  }));
}

/**
 * Generative-UI telemetry from `GET /agent/governance/genui` for the selected range: how often the
 * model's UI tool calls (`ui__render`, `ui__sandbox`, `ui__show_*`) are accepted on the first try,
 * which tool/model pairs struggle, the errors they hit, what UI costs per turn and per day, and how
 * soon the user sees a frame. `501` means the bound store does not record genui telemetry — an
 * expected state with its own panel, not the generic error note.
 */
export function GenuiSection({ range }: { range: GovernanceRange }) {
  const stats = useGenuiStats(range);
  const [metric, setMetric] = useState<TrendMetric>('costUsd');

  if (isUnsupported(stats.error)) {
    return (
      <Panel>
        <SectionTitle title="Generative UI" hint="UI tool calls" />
        <div className="empty">
          This server's governance store does not record generative-UI telemetry (no{' '}
          <code>genuiStats</code> on its governance queries), so there is nothing to show here. Use
          a store that records UI tool calls (the Lucid or in-memory store) to enable this page.
        </div>
      </Panel>
    );
  }

  const data = stats.data;
  const totals = data?.totals;
  const hasRows = data !== null && data.totals.calls > 0;

  return (
    <div className="stack">
      <div className="grid stat-4">
        <Stat
          label="UI calls"
          value={totals ? formatCount(totals.calls) : '—'}
          sub="ui__* tool calls"
        />
        <Stat
          label="First-try success"
          value={totals ? pct(totals.firstTryRate) : '—'}
          sub={
            totals
              ? `${formatCount(totals.firstTrySuccesses)} of ${formatCount(totals.firstAttempts)} first attempts`
              : undefined
          }
        />
        <Stat
          label="Retried · failed"
          value={totals ? `${formatCount(totals.retried)} · ${formatCount(totals.failed)}` : '—'}
          sub="accepted after a retry · refused"
        />
        <Stat
          label="UI cost"
          value={totals ? usd(totals.costUsd) : '—'}
          sub={
            totals
              ? `${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`
              : undefined
          }
        />
        <Stat
          label="Cost per turn"
          value={data ? usd(data.costPerTurn.avgUsd) : '—'}
          sub={
            data
              ? `avg · p50 ${usd(data.costPerTurn.p50Usd)} · p95 ${usd(data.costPerTurn.p95Usd)}`
              : undefined
          }
        />
        <Stat label="Turns" value={totals ? formatCount(totals.turns) : '—'} sub="with a UI call" />
        <Stat
          label="Time to first frame"
          value={data ? formatDuration(data.latency.firstFrame.p50Ms) : '—'}
          sub={
            data
              ? `p50 · p95 ${formatDuration(data.latency.firstFrame.p95Ms)} · ${formatCount(data.latency.firstFrame.samples)} turns`
              : undefined
          }
        />
        <Stat
          label="Time to complete"
          value={data ? formatDuration(data.latency.complete.p50Ms) : '—'}
          sub={
            data
              ? `p50 · p95 ${formatDuration(data.latency.complete.p95Ms)} · ${formatCount(data.latency.complete.samples)} turns`
              : undefined
          }
        />
      </div>

      {data !== null && !hasRows ? (
        <Panel>
          <SectionTitle title="Generative UI" hint="UI tool calls" />
          <Empty>
            No generative-UI tool calls were recorded between {range.fromDay} and {range.toDay}.
          </Empty>
        </Panel>
      ) : (
        <>
          <Panel>
            <SectionTitle
              title="First-try success by tool and model"
              hint="a turn's first UI attempt, accepted as written"
            />
            <AsyncBlock
              state={stats}
              isEmpty={(s) => s.byToolModel.length === 0}
              empty="No UI tool calls recorded in this range."
            >
              {(s) => (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Model</th>
                        <th>Mode</th>
                        <th className="num">Calls</th>
                        <th className="num">First attempts</th>
                        <th className="num">First-try rate</th>
                        <th style={{ width: 120 }} />
                        <th className="num">Retried</th>
                        <th className="num">Failed</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byToolModel.map((row) => (
                        <tr key={`${row.toolName}\u0000${row.modelId}`}>
                          <td className="mono">{row.toolName}</td>
                          <td title={row.modelId}>{formatModelLabel(row.modelId)}</td>
                          <td className="muted">{row.mode}</td>
                          <td className="num mono tnum">{formatCount(row.calls)}</td>
                          <td className="num mono tnum">{formatCount(row.firstAttempts)}</td>
                          <td className="num mono tnum">{pct(row.firstTryRate)}</td>
                          <td>
                            <ShareBar fraction={row.firstTryRate ?? 0} color="var(--good)" />
                          </td>
                          <td className="num mono tnum">{formatCount(row.retried)}</td>
                          <td className={`num mono tnum${row.failed > 0 ? ' s-failed' : ''}`}>
                            {formatCount(row.failed)}
                          </td>
                          <td className="num mono tnum">{usd(row.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AsyncBlock>
          </Panel>

          <Panel>
            <SectionTitle title="Common errors" hint="refused UI calls, most frequent first" />
            <AsyncBlock
              state={stats}
              isEmpty={(s) => s.errors.length === 0}
              empty="No refused UI calls in this range."
            >
              {(s) => (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Tool</th>
                        <th>Message</th>
                        <th className="num">Count</th>
                        <th className="num">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.errors.map((row) => (
                        <tr key={`${row.category}\u0000${row.toolName}\u0000${row.message}`}>
                          <td>
                            <span className="pill cat mono">{row.category}</span>
                          </td>
                          <td className="mono">{row.toolName}</td>
                          <td className="mono genui-msg">{row.message || '—'}</td>
                          <td className="num mono tnum">{formatCount(row.count)}</td>
                          <td className="num mono tnum muted">{formatTimestamp(row.lastAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AsyncBlock>
          </Panel>

          <Panel>
            <SectionTitle
              title="UI cost per day"
              hint={
                <span className="controls" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={metric === 'costUsd'}
                    onClick={() => setMetric('costUsd')}
                  >
                    Cost
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={metric === 'totalTokens'}
                    onClick={() => setMetric('totalTokens')}
                  >
                    Tokens
                  </button>
                </span>
              }
            />
            <AsyncBlock
              state={stats}
              isEmpty={(s) => s.byDay.length === 0}
              empty="No UI activity in this range."
            >
              {(s) => (
                <div className="stack">
                  <TrendChart points={trendPoints(s)} metric={metric} />
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Day</th>
                          <th className="num">Calls</th>
                          <th className="num">Turns</th>
                          <th className="num">First-try rate</th>
                          <th className="num">Tokens</th>
                          <th className="num">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.byDay.map((day) => (
                          <tr key={day.day}>
                            <td className="mono">{day.day}</td>
                            <td className="num mono tnum">{formatCount(day.calls)}</td>
                            <td className="num mono tnum">{formatCount(day.turns)}</td>
                            <td className="num mono tnum">{pct(day.firstTryRate)}</td>
                            <td className="num mono tnum">
                              {formatCount(day.inputTokens + day.outputTokens)}
                            </td>
                            <td className="num mono tnum">{usd(day.costUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </AsyncBlock>
          </Panel>
        </>
      )}
    </div>
  );
}
