import type { ReactNode } from 'react';

/** A stable, high-contrast palette cycled across donut/legend/series segments. */
export const SEGMENT_COLORS = [
  '#8b78ff',
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#60a5fa',
  '#f472b6',
  '#a3e635',
];

export function colorAt(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? SEGMENT_COLORS[0]!;
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`panel${className ? ` ${className}` : ''}`}>{children}</section>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel stat">
      <div className="label">{label}</div>
      <div className="value mono tnum">{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {hint !== undefined && <span className="hint">{hint}</span>}
    </div>
  );
}

/** A normalized 0..1 progress bar; `color` overrides the primary fill. */
export function ShareBar({ fraction, color }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="bar" role="presentation">
      <span style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

/** A status pill whose hue is driven by the `s-<status>` CSS class. */
export function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/[^a-z]+/g, '_');
  return (
    <span className={`pill s-${key}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number | undefined }) {
  return (
    <div className="stack" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, never reordered.
        <div key={i} className="skeleton" style={{ width: `${90 - i * 8}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: Error }) {
  return <div className="err">Failed to load: {error.message}</div>;
}

/**
 * Standard load/error/empty wrapper for a data panel. Renders the skeleton while loading, an error
 * note on failure, an empty message when there is no data, else the children.
 */
export function AsyncBlock<T>({
  state,
  isEmpty,
  empty,
  skeletonRows,
  children,
}: {
  state: { data: T | null; loading: boolean; error: Error | null };
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  skeletonRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (state.error) return <ErrorNote error={state.error} />;
  if (state.loading && state.data === null) return <Skeleton rows={skeletonRows} />;
  if (state.data === null || (isEmpty?.(state.data) ?? false)) return <Empty>{empty}</Empty>;
  return <>{children(state.data)}</>;
}
