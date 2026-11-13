import type { DonutSegment } from '../client/spend-summary.js';
import { colorAt } from './ui.js';

/**
 * Inline-SVG donut. Each segment is an arc drawn with `stroke-dasharray`; the ring is rotated -90deg
 * so the first slice starts at 12 o'clock. `centerLabel`/`centerSub` render inside the hole. No chart
 * library — pure SVG from the pre-computed {@link DonutSegment} fractions.
 */
export function Donut({
  segments,
  size = 168,
  thickness = 20,
  centerLabel,
  centerSub,
  label = 'spend by model',
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string | undefined;
  centerSub?: string | undefined;
  label?: string;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <title>{label}</title>
      <g transform={`rotate(-90 ${center} ${center})`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--agora-line)"
          strokeWidth={thickness}
        />
        {segments.map((segment, index) => (
          <circle
            key={segment.key}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colorAt(index)}
            strokeWidth={thickness}
            strokeDasharray={`${segment.fraction * circumference} ${circumference}`}
            strokeDashoffset={-segment.offset * circumference}
            strokeLinecap="butt"
          />
        ))}
      </g>
      {centerLabel && (
        <text
          x={center}
          y={center - 3}
          textAnchor="middle"
          className="mono tnum"
          fontSize="18"
          fontWeight="600"
          fill="var(--agora-text)"
        >
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text
          x={center}
          y={center + 15}
          textAnchor="middle"
          className="mono"
          fontSize="10"
          fill="var(--agora-muted)"
        >
          {centerSub}
        </text>
      )}
    </svg>
  );
}
