import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { formatCount, formatDuration, formatPercent } from '../client/format.js';
import type { DonutSegment } from '../client/spend-summary.js';
import type {
  Latency,
  RunAgentBreakdownRow,
  RunFailureCodeRow,
  RunReliability,
  RunTrendPoint,
} from '../client/types.js';
import { Donut } from './Donut.js';
import { colorAt, DonutSkeleton, LegendRow, numClass, ShareBar } from './ui.js';
import { asQuery, useReliability } from './use-governance.js';

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
          stroke="var(--agora-line)"
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
        fill="var(--agora-text)"
      >
        {formatCount(total)}
      </text>
      <text
        x={center}
        y={center + 15}
        textAnchor="middle"
        className="mono"
        fontSize="10"
        fill="var(--agora-muted)"
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
      className="block h-[160px] w-full"
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
          stroke="var(--agora-line-soft)"
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
                fill="var(--agora-accent)"
                opacity={0.6}
              >
                <title>{`${p.day} · ${p.runs} runs`}</title>
              </rect>
              {p.failed > 0 && (
                <rect
                  x={cx}
                  y={innerH - failedH}
                  width={barW}
                  height={failedH}
                  fill="var(--agora-bad)"
                >
                  <title>{`${p.day} · ${p.failed} failed`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </g>
      <text
        x={TREND_PAD}
        y={TREND_HEIGHT - 1}
        fontSize="10"
        className="mono"
        fill="var(--agora-muted)"
      >
        {points[0]?.day ?? ''}
      </text>
      <text
        x={TREND_WIDTH - TREND_PAD}
        y={TREND_HEIGHT - 1}
        fontSize="10"
        textAnchor="end"
        className="mono"
        fill="var(--agora-muted)"
      >
        {points[points.length - 1]?.day ?? ''}
      </text>
    </svg>
  );
}

/** A latency headline: p50 as the value, p95 and the sample count underneath. */
function LatencyCard({ label, latency }: { label: string; latency: Latency }) {
  return (
    <MetricCard
      label={label}
      value={formatDuration(latency.p50Ms)}
      caption={`p50 · p95 ${formatDuration(latency.p95Ms)} · ${formatCount(latency.samples)} turns`}
      tone="info"
    />
  );
}

/** Failed runs split by the stable code their stream `error` frame carried: a donut and a table. */
function FailuresByCode({ rows }: { rows: RunFailureCodeRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const segments: DonutSegment[] = [];
  let offset = 0;
  for (const row of rows) {
    const fraction = total > 0 ? row.count / total : 0;
    segments.push({ key: row.code, value: row.count, fraction, offset });
    offset += fraction;
  }
  const colorOf = new Map(rows.map((row, i) => [row.code, colorAt(i)]));
  const columns: Column<RunFailureCodeRow>[] = [
    { id: 'code', header: 'Code', cell: (row) => <span className="mono text-fg">{row.code}</span> },
    {
      id: 'failed',
      header: 'Failed',
      align: 'right',
      cell: (row) => <span className={numClass}>{formatCount(row.count)}</span>,
    },
    {
      id: 'share',
      header: 'Share',
      className: 'w-40',
      cell: (row) => (
        <ShareBar
          fraction={total > 0 ? row.count / total : 0}
          {...(colorOf.has(row.code) ? { color: colorOf.get(row.code) as string } : {})}
        />
      ),
    },
  ];
  return (
    <div className="grid items-center lg:grid-cols-[minmax(240px,320px)_1fr]">
      <div className="flex flex-col items-center gap-4 border-b border-border p-5 lg:border-r lg:border-b-0">
        <Donut
          segments={segments}
          centerLabel={formatCount(total)}
          centerSub="failed"
          label="failures by code"
        />
        <div className="w-full">
          {rows.slice(0, 6).map((row, i) => (
            <LegendRow
              key={row.code}
              color={colorAt(i)}
              name={row.code}
              mono
              value={formatCount(row.count)}
            />
          ))}
        </div>
      </div>
      <div className="min-w-0 self-start">
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.code} />
      </div>
    </div>
  );
}

function agentColumns(totalRuns: number): Column<RunAgentBreakdownRow>[] {
  return [
    {
      id: 'agent',
      header: 'Agent',
      cell: (row) => <span className="text-fg">{row.agentName ?? '—'}</span>,
    },
    {
      id: 'runs',
      header: 'Runs',
      align: 'right',
      cell: (row) => <span className={numClass}>{formatCount(row.runs)}</span>,
    },
    {
      id: 'failed',
      header: 'Failed',
      align: 'right',
      cell: (row) => (
        <span className={row.failed > 0 ? 'mono tnum text-bad' : numClass}>
          {formatCount(row.failed)}
        </span>
      ),
    },
    {
      id: 'success',
      header: 'Success rate',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => <span className={numClass}>{formatPercent(row.successRate)}</span>,
    },
    {
      id: 'share',
      header: 'Share',
      className: 'w-40',
      hideBelow: 'md',
      cell: (row) => <ShareBar fraction={totalRuns > 0 ? row.runs / totalRuns : 0} />,
    },
  ];
}

interface RateRow {
  key: string;
  label: string;
  rate: number;
  color: string;
}

const rateColumns: Column<RateRow>[] = [
  { id: 'outcome', header: 'Outcome', cell: (row) => <span className="text-fg">{row.label}</span> },
  {
    id: 'rate',
    header: 'Rate',
    align: 'right',
    cell: (row) => <span className={numClass}>{formatPercent(row.rate)}</span>,
  },
  {
    id: 'share',
    header: 'Share',
    className: 'w-40',
    cell: (row) => <ShareBar fraction={row.rate} color={row.color} />,
  },
];

/**
 * The run reliability page from `GET /agent/governance/reliability` (container): success / failure
 * / cancel rates and mean settled duration, the outcome donut, turn latency, failures by code, the
 * daily runs/failed trend and the per-agent breakdown. The optional blocks only show when the server
 * sends them.
 */
export function ReliabilitySection() {
  const reliability = asQuery(useReliability());
  return (
    <PageBody>
      <PageHeader
        title="Reliability"
        description="How runs end, how fast turns are and what fails — over all time."
      />
      <QueryBoundary
        query={reliability}
        label="Reliability"
        skeleton={
          <>
            <MetricGridSkeleton count={4} />
            <DonutSkeleton />
          </>
        }
        isEmpty={(r: RunReliability) => r.runs === 0}
        empty={
          <EmptyState
            title="No runs recorded yet."
            description="Run outcomes show up here once an agent runs."
          />
        }
      >
        {(r) => <ReliabilityView r={r} />}
      </QueryBoundary>
    </PageBody>
  );
}

/** The reliability page body (presentational). */
export function ReliabilityView({ r }: { r: RunReliability }) {
  const slices: Slice[] = [
    { key: 'completed', label: 'Completed', value: r.completed, color: 'var(--agora-good)' },
    { key: 'failed', label: 'Failed', value: r.failed, color: 'var(--agora-bad)' },
    { key: 'cancelled', label: 'Cancelled', value: r.cancelled, color: 'var(--agora-warn)' },
    { key: 'running', label: 'Running', value: r.running, color: 'var(--agora-info)' },
  ];
  const rates: RateRow[] = [
    { key: 'success', label: 'Success', rate: r.successRate, color: 'var(--agora-good)' },
    { key: 'failure', label: 'Failure', rate: r.failureRate, color: 'var(--agora-bad)' },
    { key: 'cancel', label: 'Cancel', rate: r.cancelRate, color: 'var(--agora-warn)' },
  ];
  return (
    <>
      <MetricGrid className="md:grid-cols-4">
        <MetricCard
          label="Runs"
          value={formatCount(r.runs)}
          caption={`${formatCount(r.running)} running`}
        />
        <MetricCard
          label="Success rate"
          value={formatPercent(r.successRate)}
          caption={`${formatCount(r.completed)} completed`}
          tone="good"
        />
        <MetricCard
          label="Failure rate"
          value={formatPercent(r.failureRate)}
          caption={`${formatCount(r.failed)} failed`}
          tone={r.failed > 0 ? 'bad' : 'default'}
        />
        <MetricCard
          label="Avg duration"
          value={formatDuration(r.avgDurationMs)}
          caption="settled runs"
          tone="info"
        />
      </MetricGrid>

      <ErrorBoundary label="Outcomes">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Outcomes" description="every run by how it ended">
            <div className="flex flex-col items-center gap-4 py-1 sm:flex-row sm:justify-center sm:gap-8">
              <ReliabilityDonut slices={slices} total={r.runs} />
              <div className="w-full sm:w-48">
                {slices.map((slice) => (
                  <LegendRow
                    key={slice.key}
                    color={slice.color}
                    name={slice.label}
                    value={formatCount(slice.value)}
                  />
                ))}
              </div>
            </div>
          </Panel>
          <Panel title="Rates" description="share of all runs" flush>
            <DataTable columns={rateColumns} rows={rates} rowKey={(row) => row.key} />
          </Panel>
        </div>
      </ErrorBoundary>

      {r.latency !== undefined && (
        <ErrorBoundary label="Latency">
          <MetricGrid className="md:grid-cols-2">
            <LatencyCard label="Time to first token" latency={r.latency.ttft} />
            <LatencyCard label="Turn duration" latency={r.latency.duration} />
          </MetricGrid>
        </ErrorBoundary>
      )}

      {r.failuresByCode !== undefined && r.failuresByCode.length > 0 && (
        <ErrorBoundary label="Failures by code">
          <Panel title="Failures by code" description="the code the run's error carried" flush>
            <FailuresByCode rows={r.failuresByCode} />
          </Panel>
        </ErrorBoundary>
      )}

      {r.trend !== undefined && r.trend.length > 0 && (
        <ErrorBoundary label="Runs vs failed">
          <Panel
            title="Runs vs failed"
            description="daily, over the same window"
            action={
              <span className="flex items-center gap-3 text-[10.5px] text-faint">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-[2px] bg-primary/60" /> runs
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-[2px] bg-bad" /> failed
                </span>
              </span>
            }
          >
            <ReliabilityTrendChart points={r.trend} />
          </Panel>
        </ErrorBoundary>
      )}

      {r.byAgent !== undefined && (
        <ErrorBoundary label="By agent">
          <Panel title="By agent" description="run volume + failures per agent" flush>
            <DataTable
              columns={agentColumns(r.runs)}
              rows={r.byAgent}
              rowKey={(row) => row.agentName ?? '—'}
              empty={<EmptyState title="No agent-attributed runs recorded yet." />}
            />
          </Panel>
        </ErrorBoundary>
      )}
    </>
  );
}
