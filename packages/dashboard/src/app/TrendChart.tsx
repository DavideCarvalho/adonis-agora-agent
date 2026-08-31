import { formatCount, formatUsd } from '../client/format.js';
import { buildTrendGeometry, type TrendMetric } from '../client/trend-path.js';
import type { UsageTrendPoint } from '../client/types.js';

const WIDTH = 720;
const HEIGHT = 200;
const PAD = 12;

/**
 * A hand-rolled SVG area/line chart for the daily usage trend — no charting dependency. Geometry is
 * computed by the pure {@link buildTrendGeometry}; this component only paints it (gradient fill,
 * stroke, vertex dots) and labels the endpoints. `viewBox` + `width:100%` make it fluid/responsive.
 */
export function TrendChart({ points, metric }: { points: UsageTrendPoint[]; metric: TrendMetric }) {
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;
  const geo = buildTrendGeometry(points, metric, innerW, innerH);
  const fmt = metric === 'costUsd' ? formatUsd : formatCount;
  const gradId = `trend-fill-${metric}`;

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`daily ${metric === 'costUsd' ? 'cost' : 'token'} trend`}
      preserveAspectRatio="none"
    >
      <title>{`daily ${metric === 'costUsd' ? 'cost' : 'token'} trend`}</title>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* baseline gridlines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={PAD}
          x2={WIDTH - PAD}
          y1={PAD + innerH * f}
          y2={PAD + innerH * f}
          stroke="var(--line-soft)"
          strokeWidth="1"
        />
      ))}
      <g transform={`translate(${PAD} ${PAD})`}>
        {geo.area && <path d={geo.area} fill={`url(#${gradId})`} />}
        {geo.line && (
          <path
            d={geo.line}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        )}
        {geo.vertices.map((v) => (
          <circle key={v.day} cx={v.x} cy={v.y} r="3" fill="var(--primary)">
            <title>{`${v.day} · ${fmt(v.value)}`}</title>
          </circle>
        ))}
      </g>
      <text x={PAD} y={HEIGHT - 1} fontSize="10" className="mono" fill="var(--muted)">
        {points[0]?.day ?? ''}
      </text>
      <text
        x={WIDTH - PAD}
        y={HEIGHT - 1}
        fontSize="10"
        textAnchor="end"
        className="mono"
        fill="var(--muted)"
      >
        {points[points.length - 1]?.day ?? ''}
      </text>
      <text x={PAD} y={PAD + 2} fontSize="10" className="mono" fill="var(--muted)">
        {fmt(geo.max)}
      </text>
    </svg>
  );
}
