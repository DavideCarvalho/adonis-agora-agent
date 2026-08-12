import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { RunReliability, RunTrendPoint } from '../client/types.js';
import { AsyncBlock, Empty, Panel, SectionTitle, ShareBar, Stat } from './ui.js';
import { useReliability } from './use-governance.js';

/** One outcome slice of the reliability donut, with its semantic CSS colour token. */
interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * A hand-rolled inline-SVG donut of run outcomes (no chart library) — each slice is a
 * `stroke-dasharray` arc on a ring rotated -90° so the first slice starts at 12 o'clock, mirroring
 * the Overview {@link Donut} but coloured by semantic outcome tokens (`--good`/`--bad`/`--warn`/
 * `--info`) rather than the categorical palette. The total run count sits in the hole.
 */
function ReliabilityDonut({ slices, total }: { slices: Slice[]; total: number }) {
  const size = 168;
  const thickness = 20;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  let offset = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="run outcomes"
    >
      <title>run outcomes</title>
      <g transform={`rotate(-90 ${center} ${center})`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          slices.map((slice) => {
            const fraction = slice.value / total;
            const dash = fraction * circumference;
            const el = (
              <circle
                key={slice.key}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference}`}
                strokeDashoffset={-offset * circumference}
                strokeLinecap="butt"
              />
            );
            offset += fraction;
            return el;
          })}
      </g>
      <text
        x={center}
        y={center - 3}
        textAnchor="middle"
        className="mono tnum"
        fontSize="18"
        fontWeight="600"
        fill="var(--text)"
      >
        {formatCount(total)}
      </text>
      <text
        x={center}
        y={center + 15}
        textAnchor="middle"
        className="mono"
        fontSize="10"
        fill="var(--muted)"
      >
        runs
      </text>
    </svg>
  );
}

const TREND_WIDTH = 720;
const TREND_HEIGHT = 160;
const TREND_PAD = 12;

/**
 * A hand-rolled inline-SVG grouped-bar chart of the daily runs/failed trend — no charting dependency,
 * mirroring the visual language of {@link import('./TrendChart.js').TrendChart}. Each day gets two
 * bars: total runs (`--primary`) and the failed subset (`--bad`), so a failure spike reads directly
 * against that day's volume instead of needing a second axis.
 */
function ReliabilityTrendChart({ points }: { points: RunTrendPoint[] }) {
  const innerW = TREND_WIDTH - TREND_PAD * 2;
  const innerH = TREND_HEIGHT - TREND_PAD * 2;
  const max = Math.max(...points.map((p) => p.runs), 1);
  const slot = innerW / points.length;
  const barW = Math.max(2, Math.min(18, slot * 0.32));

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
      role="img"
      aria-label="daily runs vs failed trend"
      preserveAspectRatio="none"
    >
      <title>daily runs vs failed trend</title>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={TREND_PAD}
          x2={TREND_WIDTH - TREND_PAD}
          y1={TREND_PAD + innerH * f}
          y2={TREND_PAD + innerH * f}
          stroke="var(--line-soft)"
          strokeWidth="1"
        />
      ))}
      <g transform={`translate(${TREND_PAD} ${TREND_PAD})`}>
        {points.map((p, i) => {
          const cx = slot * i + slot / 2;
          const runsH = (p.runs / max) * innerH;
          const failedH = (p.failed / max) * innerH;
          return (
            <g key={p.day}>
              <rect
                x={cx - barW}
                y={innerH - runsH}
                width={barW}
                height={runsH}
                fill="var(--primary)"
                opacity={0.6}
              >
                <title>{`${p.day} · ${p.runs} runs`}</title>
              </rect>
              {p.failed > 0 && (
                <rect x={cx} y={innerH - failedH} width={barW} height={failedH} fill="var(--bad)">
                  <title>{`${p.day} · ${p.failed} failed`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </g>
      <text x={TREND_PAD} y={TREND_HEIGHT - 1} fontSize="10" className="mono" fill="var(--muted)">
        {points[0]?.day ?? ''}
      </text>
      <text
        x={TREND_WIDTH - TREND_PAD}
        y={TREND_HEIGHT - 1}
        fontSize="10"
        textAnchor="end"
        className="mono"
        fill="var(--muted)"
      >
        {points[points.length - 1]?.day ?? ''}
      </text>
    </svg>
  );
}

/**
 * The run reliability surface from `GET /agent/governance/reliability`: success / failure / cancel
 * rates + mean settled duration, shown as headline stats, a hand-rolled outcome donut with a legend,
 * per-rate bars, a daily runs/failed trend chart, and a per-agent breakdown table.
 */
export function ReliabilitySection() {
  const reliability = useReliability();
  return (
    <Panel>
      <SectionTitle title="Reliability" hint="run outcomes over all time" />
      <AsyncBlock
        state={reliability}
        isEmpty={(r: RunReliability) => r.runs === 0}
        empty="No runs recorded yet."
        skeletonRows={4}
      >
        {(r) => {
          const slices: Slice[] = [
            { key: 'completed', label: 'Completed', value: r.completed, color: 'var(--good)' },
            { key: 'failed', label: 'Failed', value: r.failed, color: 'var(--bad)' },
            { key: 'cancelled', label: 'Cancelled', value: r.cancelled, color: 'var(--warn)' },
            { key: 'running', label: 'Running', value: r.running, color: 'var(--info)' },
          ];
          return (
            <div className="stack">
              <div className="grid stat-4">
                <Stat
                  label="Runs"
                  value={formatCount(r.runs)}
                  sub={`${formatCount(r.running)} running`}
                />
                <Stat
                  label="Success rate"
                  value={formatPercent(r.successRate)}
                  sub={`${formatCount(r.completed)} completed`}
                />
                <Stat
                  label="Failure rate"
                  value={formatPercent(r.failureRate)}
                  sub={`${formatCount(r.failed)} failed`}
                />
                <Stat
                  label="Avg duration"
                  value={formatDuration(r.avgDurationMs)}
                  sub="settled runs"
                />
              </div>

              <div className="grid cols-2" style={{ alignItems: 'center' }}>
                <div style={{ display: 'grid', placeItems: 'center', gap: 14 }}>
                  <ReliabilityDonut slices={slices} total={r.runs} />
                  <div className="legend" style={{ width: '100%' }}>
                    {slices.map((slice) => (
                      <div className="row" key={slice.key}>
                        <span className="swatch" style={{ background: slice.color }} />
                        <span className="name">{slice.label}</span>
                        <span className="mono tnum muted">{formatCount(slice.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Outcome</th>
                        <th className="num">Rate</th>
                        <th style={{ width: 160 }}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Success</td>
                        <td className="num mono tnum">{formatPercent(r.successRate)}</td>
                        <td>
                          <ShareBar fraction={r.successRate} color="var(--good)" />
                        </td>
                      </tr>
                      <tr>
                        <td>Failure</td>
                        <td className="num mono tnum">{formatPercent(r.failureRate)}</td>
                        <td>
                          <ShareBar fraction={r.failureRate} color="var(--bad)" />
                        </td>
                      </tr>
                      <tr>
                        <td>Cancel</td>
                        <td className="num mono tnum">{formatPercent(r.cancelRate)}</td>
                        <td>
                          <ShareBar fraction={r.cancelRate} color="var(--warn)" />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {r.trend !== undefined && r.trend.length > 0 && (
                <Panel>
                  <SectionTitle title="Runs vs failed" hint="daily, over the same window" />
                  <ReliabilityTrendChart points={r.trend} />
                </Panel>
              )}

              {r.byAgent !== undefined && (
                <Panel>
                  <SectionTitle title="By agent" hint="run volume + failures per agent" />
                  {r.byAgent.length === 0 ? (
                    <Empty>No agent-attributed runs recorded yet.</Empty>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Agent</th>
                            <th className="num">Runs</th>
                            <th className="num">Failed</th>
                            <th className="num">Success rate</th>
                            <th style={{ width: 160 }}>Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.byAgent.map((row) => (
                            <tr key={row.agentName ?? '—'}>
                              <td>{row.agentName ?? <span className="muted">—</span>}</td>
                              <td className="num mono tnum">{formatCount(row.runs)}</td>
                              <td className="num mono tnum">
                                {row.failed > 0 ? (
                                  <span className="warnnum">{formatCount(row.failed)}</span>
                                ) : (
                                  formatCount(row.failed)
                                )}
                              </td>
                              <td className="num mono tnum">{formatPercent(row.successRate)}</td>
                              <td>
                                <ShareBar fraction={r.runs > 0 ? row.runs / r.runs : 0} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              )}
            </div>
          );
        }}
      </AsyncBlock>
    </Panel>
  );
}
