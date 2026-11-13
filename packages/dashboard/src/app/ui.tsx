import type { ReactNode } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { cn } from '../agora-kit/lib/utils';
import { Badge } from '../agora-kit/ui/badge';
import { Card } from '../agora-kit/ui/card';
import { Skeleton } from '../agora-kit/ui/skeleton';

/**
 * Agent-console presentational helpers on top of the Agora kit: chart palette, share bars, status
 * badges, the metric/segmented controls the pages share, and the native form-field look. Pure
 * props → markup; nothing here fetches.
 */

/**
 * The categorical palette cycled across donut/legend/series segments — the console tokens, so both
 * themes stay legible (light mode darkens the semantic hues).
 */
export const SEGMENT_COLORS = [
  'var(--agora-accent)',
  'var(--agora-info)',
  'var(--agora-good)',
  'var(--agora-warn)',
  'var(--agora-violet)',
  'var(--agora-teal)',
  'var(--agora-bad)',
  'var(--agora-muted)',
];

export function colorAt(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? 'var(--agora-accent)';
}

/** The look of a native `<input>` / `<select>` in the console (topbar pickers, filters, forms). */
export const fieldClass =
  'h-8 min-w-0 rounded-md border border-border bg-panel-2 px-2.5 text-xs text-fg outline-none transition-colors placeholder:text-faint hover:border-line-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

/** Numeric table cell text. */
export const numClass = 'mono tnum text-fg-2';

/** A normalized 0..1 progress bar; `color` overrides the accent fill. */
export function ShareBar({ fraction, color }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="presentation">
      <span
        className="block h-full rounded-full bg-primary"
        style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  );
}

type BadgeTone = 'good' | 'destructive' | 'info' | 'warn' | 'neutral' | 'brand' | 'violet' | 'teal';

const STATUS_TONE: Record<string, BadgeTone> = {
  completed: 'good',
  approved: 'good',
  success: 'good',
  succeeded: 'good',
  failed: 'destructive',
  error: 'destructive',
  rejected: 'destructive',
  denied: 'destructive',
  running: 'info',
  streaming: 'info',
  in_progress: 'info',
  pending_approval: 'warn',
  pending: 'warn',
  awaiting_approval: 'warn',
  cancelled: 'neutral',
  canceled: 'neutral',
  user: 'brand',
  assistant: 'violet',
  tool: 'teal',
  system: 'neutral',
};

/** A status (or message role) as a soft badge whose tone follows its meaning. */
export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/[^a-z]+/g, '_');
  return (
    <Badge variant={STATUS_TONE[key] ?? 'neutral'} data-status={key}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </Badge>
  );
}

/** A two-or-more-way toggle (Cost / Tokens) as pressed chips. */
export function Segmented<K extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: K;
  options: { key: K; label: string }[];
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex rounded-md border border-border bg-panel-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={value === option.key}
          onClick={() => onChange(option.key)}
          className="rounded-[5px] px-2.5 py-1 text-[11px] font-medium text-dim transition-colors hover:text-fg aria-selected:bg-brand-soft aria-selected:text-fg"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A legend row: swatch, name, mono value. */
export function LegendRow({
  color,
  name,
  value,
  title,
  mono,
}: {
  color: string;
  name: ReactNode;
  value: ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className={cn('min-w-0 flex-1 truncate text-fg-2', mono && 'mono')} title={title}>
        {name}
      </span>
      <span className="mono tnum text-dim">{value}</span>
    </div>
  );
}

/** Render an arbitrary tool input/output payload as compact one-line JSON (`—` when absent). */
export function payload(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A table's loading state: the same columns, skeleton rows. */
export function TableSkeleton<T>({ columns, rows = 5 }: { columns: Column<T>[]; rows?: number }) {
  return <DataTable columns={columns} rows={undefined} rowKey={() => ''} skeletonRows={rows} />;
}

/** A chart's loading state: a block the chart's height. */
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="p-4" aria-hidden>
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/** A donut + legend block's loading state. */
export function DonutSkeleton() {
  return (
    <div className="grid items-center gap-6 p-4 md:grid-cols-[220px_1fr]" aria-hidden>
      <Skeleton className="mx-auto size-[168px] rounded-full" />
      <div className="flex flex-col gap-2.5">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}

/** A plain notice card (an expected state that is not an error: feature not available here). */
export function Notice({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className="agora-surface rounded-lg border border-border px-4 py-4 shadow-none ring-0 gap-1.5">
      <div className="text-[12.5px] font-semibold text-fg">{title}</div>
      <div className="text-xs leading-relaxed text-dim [&_code]:mono [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:text-fg-2">
        {children}
      </div>
    </Card>
  );
}

/** A "back to the list" row above a detail view: button + the record's short id. */
export function BackBar({
  label,
  onBack,
  id,
  kind,
}: {
  label: string;
  onBack: () => void;
  id: string;
  kind: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-[26px] items-center gap-1 rounded-[6px] border border-border bg-panel-2 px-2.5 text-[11px] font-medium text-dim transition-colors hover:border-line-strong hover:text-fg"
      >
        <span aria-hidden>←</span> {label}
      </button>
      <span className="mono text-[11px] text-faint" title={id}>
        {kind} {id.slice(0, 12)}…
      </span>
    </div>
  );
}
