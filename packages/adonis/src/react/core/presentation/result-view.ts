import type { ToolResultField, ToolResultView } from '../../../index.js';
import { fillTemplate, readPath } from './phrasing.js';

/** One labelled reading of a `metrics` view. */
export interface ResolvedReading {
  label: string;
  /** The value as text (`—` for nothing). */
  value: string;
  unit: string | null;
}

/**
 * A tool's output resolved through its view into plain data a renderer draws — never the payload
 * itself. `null` from {@link resolveResultView} means "draw nothing".
 */
export type ResolvedResultView =
  | { kind: 'metrics'; readings: ResolvedReading[] }
  | { kind: 'table'; columns: ToolResultField[]; rows: string[][]; empty: string | null }
  | { kind: 'log'; lines: string[] }
  | { kind: 'note'; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(toText).join(', ');
  return '—';
}

/**
 * A view for an output whose tool declared none, from its shape: an array of flat records is a
 * table, an array of strings a log, a flat record a set of readings. `undefined` when nothing fits —
 * a serialized payload is what a person-facing surface exists to avoid, so failing to infer must not
 * fall back to one.
 */
export function inferResultView(output: unknown): ToolResultView | undefined {
  if (!isRecord(output)) return undefined;
  for (const [key, value] of Object.entries(output)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    if (value.every((entry) => typeof entry === 'string')) {
      return { kind: 'log', lines: key };
    }
    if (value.every(isRecord)) {
      const first = value[0] as Record<string, unknown>;
      return {
        kind: 'table',
        rows: key,
        columns: Object.keys(first)
          .filter((column) => !isRecord(first[column]))
          .map((column) => ({ path: column, label: column })),
      };
    }
  }
  const fields = Object.entries(output)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key]) => ({ path: key, label: key }));
  return fields.length > 0 ? { kind: 'metrics', fields } : undefined;
}

/**
 * Read `output` through `view` (or one inferred from its shape when `view` is omitted and `infer` is
 * on). `null` when there is nothing to draw: an `elsewhere` view, an empty reading set, a missing
 * array. A table whose rows array is present but empty resolves with no rows and its `empty` line.
 */
export function resolveResultView(
  output: unknown,
  view: ToolResultView | undefined,
  options: { infer?: boolean } = {},
): ResolvedResultView | null {
  const resolved = view ?? (options.infer === true ? inferResultView(output) : undefined);
  if (resolved === undefined || resolved.kind === 'elsewhere') return null;
  switch (resolved.kind) {
    case 'note': {
      const text = fillTemplate(resolved.text, output);
      return text === '' ? null : { kind: 'note', text };
    }
    case 'metrics': {
      const readings = resolved.fields
        .map((field) => ({ field, value: readPath(output, field.path) }))
        .filter((entry) => entry.value !== undefined && entry.value !== null)
        .map(({ field, value }) => ({
          label: field.label,
          value: toText(value),
          unit: field.unit ?? null,
        }));
      return readings.length === 0 ? null : { kind: 'metrics', readings };
    }
    case 'log': {
      const lines = readPath(output, resolved.lines);
      if (!Array.isArray(lines) || lines.length === 0) return null;
      return { kind: 'log', lines: lines.map(toText) };
    }
    case 'table': {
      const rows = readPath(output, resolved.rows);
      if (!Array.isArray(rows)) return null;
      return {
        kind: 'table',
        columns: resolved.columns,
        rows: rows.map((row) =>
          resolved.columns.map((column) => toText(readPath(row, column.path))),
        ),
        empty: rows.length === 0 ? (resolved.empty ?? null) : null,
      };
    }
  }
}
