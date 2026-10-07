/**
 * Optional builtin component DEFINITIONS — names, props schemas, model descriptions and plain-text
 * fallbacks for the components most chat apps want. No visuals: an app renders each with its own
 * look, keyed by name. Use them as-is, pick some, or extend them:
 *
 * ```ts
 * const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, myDealCard]);
 * ```
 */
import { type ComponentDefinition, defineComponent } from './catalog.js';
import type { ChartProps, TableProps } from './registry.js';
import type { JsonSchema } from './schema.js';

type Props = Record<string, unknown>;

const str = (description?: string, extra: JsonSchema = {}): JsonSchema => ({
  type: 'string',
  ...(description !== undefined ? { description } : {}),
  ...extra,
});
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const arr = (items: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({
  type: 'array',
  items,
  ...extra,
});
const cell: JsonSchema = { type: ['string', 'number', 'boolean', 'null'] };
const row: JsonSchema = { type: 'object', additionalProperties: cell };

const s = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const heading = (props: { title?: unknown }): string =>
  props.title ? `*${s(props.title)}*\n` : '';

/** A fixed-width text table in a code block, at most `max` rows. */
export function textTable(
  columns: readonly { key: string; label: string }[],
  rows: readonly Props[],
  max = 15,
): string {
  return `\`\`\`\n${tableLines(columns, rows, max).join('\n')}\n\`\`\``;
}

/** {@link textTable}'s lines, without the code block. */
function tableLines(
  columns: readonly { key: string; label: string }[],
  rows: readonly Props[],
  max: number,
): string[] {
  const shown = rows.slice(0, max);
  const widths = columns.map((column) =>
    Math.min(28, Math.max(column.label.length, ...shown.map((r) => s(r[column.key]).length))),
  );
  const format = (values: string[]) =>
    values
      .map((value, index) => value.slice(0, widths[index]).padEnd(widths[index] ?? 0))
      .join('  ');
  const lines = [
    format(columns.map((column) => column.label)),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...shown.map((r) => format(columns.map((column) => s(r[column.key])))),
  ];
  if (rows.length > max) lines.push(`… ${rows.length - max} more rows`);
  return lines;
}

export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff (LCS) — good enough for snippets up to a few hundred lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  const at = (i: number, j: number): number => dp[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (dp[i] as number[])[j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ op: 'del', text: a[i++] as string });
    } else {
      out.push({ op: 'add', text: b[j++] as string });
    }
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++] as string });
  while (j < b.length) out.push({ op: 'add', text: b[j++] as string });
  return out;
}

function bar(value: number, max: number, width = 20): string {
  const n = max > 0 ? Math.round((Math.abs(value) / max) * width) : 0;
  return '█'.repeat(n) || '▏';
}

export const DataTable = defineComponent<TableProps>({
  name: 'DataTable',
  title: 'Data table',
  description:
    'Tabular data (records with the same fields) as a sortable table. Prefer it over markdown tables for more than 3 rows.',
  props: obj(
    {
      title: str('Short caption'),
      columns: arr(
        obj(
          {
            key: str('Field name in each row'),
            label: str('Column header'),
            align: str(undefined, { enum: ['left', 'right', 'center'] }),
            format: str('How to format values', {
              enum: ['text', 'number', 'currency', 'percent', 'date', 'link'],
            }),
          },
          ['key', 'label'],
        ),
        { minItems: 1, maxItems: 12 },
      ),
      rows: arr(row, { maxItems: 500 }),
    },
    ['columns', 'rows'],
  ),
  fallbackText: (props) => `${heading(props)}${textTable(props.columns ?? [], props.rows ?? [])}`,
});

export const Chart = defineComponent<ChartProps>({
  name: 'Chart',
  title: 'Chart',
  description:
    '`bar` to compare categories, `line` for a trend over time. `data` is a list of points; `xKey` names the category/time field and each series names a numeric field.',
  props: obj(
    {
      type: str('Chart type', { enum: ['bar', 'line'] }),
      title: str(),
      xKey: str('Field of each point used for the x axis'),
      series: arr(obj({ key: str('Numeric field'), label: str() }, ['key']), {
        minItems: 1,
        maxItems: 6,
      }),
      data: arr(row, { minItems: 1, maxItems: 200 }),
      unit: str('Unit shown after values, e.g. `KB` or `%`'),
    },
    ['type', 'xKey', 'series', 'data'],
  ),
  fallbackText: (props) => {
    const series = props.series ?? [];
    const data = props.data ?? [];
    const unit = props.unit ? ` ${s(props.unit)}` : '';
    const lines =
      props.type === 'line'
        ? lineChartLines(props.xKey, series, data, unit)
        : barChartLines(props.xKey, series, data, unit);
    return `${heading(props)}\`\`\`\n${lines.join('\n')}\n\`\`\``;
  },
});

const seriesName = (each: { key: string; label?: string }): string => s(each.label || each.key);
const pad = (value: unknown, width: number): string => s(value).slice(0, width).padEnd(width);

/**
 * A bar chart as text: one bar per point (one series), or per point a bar per series, all on one
 * scale. At most 20 points.
 */
function barChartLines(
  xKey: string,
  series: ChartProps['series'],
  data: ChartProps['data'],
  unit: string,
): string[] {
  const value = (point: ChartProps['data'][number], key: string) => Number(point[key]) || 0;
  const max = Math.max(
    0,
    ...data.flatMap((point) => series.map((each) => Math.abs(value(point, each.key)))),
  );
  const lines: string[] = [];
  const width = Math.min(18, Math.max(0, ...series.map((each) => seriesName(each).length)));
  for (const point of data.slice(0, 20)) {
    if (series.length <= 1) {
      const key = series[0]?.key ?? '';
      lines.push(`${pad(point[xKey], 18)} ${bar(value(point, key), max)} ${s(point[key])}${unit}`);
      continue;
    }
    lines.push(s(point[xKey]));
    for (const each of series) {
      lines.push(
        `  ${pad(seriesName(each), width)} ${bar(value(point, each.key), max)} ${s(point[each.key])}${unit}`,
      );
    }
  }
  if (data.length > 20) lines.push(`… ${data.length - 20} more points`);
  return lines;
}

const SPARKS = '▁▂▃▄▅▆▇█';

/** `▁▃▅█`: one block per value, scaled between the smallest and the largest. */
function sparkline(values: readonly number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values
    .map((value) =>
      max === min
        ? SPARKS[3]
        : SPARKS[Math.round(((value - min) / (max - min)) * (SPARKS.length - 1))],
    )
    .join('');
}

/** A line chart as text: a sparkline per series (first → last, min/max), then the points as a table. */
function lineChartLines(
  xKey: string,
  series: ChartProps['series'],
  data: ChartProps['data'],
  unit: string,
): string[] {
  const width = Math.min(18, Math.max(0, ...series.map((each) => seriesName(each).length)));
  // At most 40 sparkline points, sampled evenly across the data.
  const step = Math.max(1, Math.ceil(data.length / 40));
  const lines = series.map((each) => {
    const values = data.map((point) => Number(point[each.key]) || 0);
    if (values.length === 0) return seriesName(each);
    const spark = sparkline(values.filter((_value, index) => index % step === 0));
    const first = s(data[0]?.[each.key]);
    const last = s(data[data.length - 1]?.[each.key]);
    return `${pad(seriesName(each), width)}  ${spark}  ${first} → ${last}${unit} (min ${Math.min(...values)}, max ${Math.max(...values)})`;
  });
  const columns = [
    { key: xKey, label: xKey },
    ...series.map((each) => ({ key: each.key, label: seriesName(each) })),
  ];
  return [...lines, '', ...tableLines(columns, data, 20)];
}

export const KpiCards = defineComponent<{
  title?: string;
  items: {
    label: string;
    value: string | number;
    delta?: string;
    trend?: 'up' | 'down' | 'flat';
    hint?: string;
  }[];
}>({
  name: 'KpiCards',
  title: 'KPI cards',
  description: 'A few key numbers (metrics, totals, counts) as cards.',
  props: obj(
    {
      title: str(),
      items: arr(
        obj(
          {
            label: str(),
            value: { type: ['string', 'number'] },
            delta: str('Change, e.g. `+12%`'),
            trend: str(undefined, { enum: ['up', 'down', 'flat'] }),
            hint: str(),
          },
          ['label', 'value'],
        ),
        { minItems: 1, maxItems: 8 },
      ),
    },
    ['items'],
  ),
  fallbackText: (props) =>
    `${heading(props)}${(props.items ?? [])
      .map(
        (item) =>
          `• *${s(item.label)}:* ${s(item.value)}${item.delta ? ` (${s(item.delta)})` : ''}`,
      )
      .join('\n')}`,
});

export const SourceCards = defineComponent<{
  title?: string;
  items: { title: string; url?: string; snippet?: string; source?: string }[];
}>({
  name: 'SourceCards',
  title: 'Sources',
  description: 'The documents, pages or links an answer is based on, as cards.',
  props: obj(
    {
      title: str(),
      items: arr(
        obj({ title: str(), url: str(), snippet: str(), source: str('e.g. Wiki, GitHub') }, [
          'title',
        ]),
        { minItems: 1, maxItems: 12 },
      ),
    },
    ['items'],
  ),
  fallbackText: (props) =>
    `${heading(props)}${(props.items ?? [])
      .map(
        (item) =>
          `• ${item.url ? `<${s(item.url)}|${s(item.title)}>` : s(item.title)}${item.source ? ` — ${s(item.source)}` : ''}`,
      )
      .join('\n')}`,
});

export const Checklist = defineComponent<{
  title?: string;
  items: { label: string; done?: boolean; note?: string }[];
}>({
  name: 'Checklist',
  title: 'Checklist',
  description: 'Steps or a to-do list with done/not-done state.',
  props: obj(
    {
      title: str(),
      items: arr(obj({ label: str(), done: { type: 'boolean' }, note: str() }, ['label']), {
        minItems: 1,
        maxItems: 50,
      }),
    },
    ['items'],
  ),
  fallbackText: (props) =>
    `${heading(props)}${(props.items ?? [])
      .map(
        (item) =>
          `${item.done ? '☑' : '☐'} ${s(item.label)}${item.note ? ` — _${s(item.note)}_` : ''}`,
      )
      .join('\n')}`,
});

export const Timeline = defineComponent<{
  title?: string;
  events: { date?: string; title: string; description?: string }[];
}>({
  name: 'Timeline',
  title: 'Timeline',
  description: 'Events in chronological order (the history of a project, an incident, a deal).',
  props: obj(
    {
      title: str(),
      events: arr(obj({ date: str(), title: str(), description: str() }, ['title']), {
        minItems: 1,
        maxItems: 50,
      }),
    },
    ['events'],
  ),
  fallbackText: (props) =>
    `${heading(props)}${(props.events ?? [])
      .map(
        (event) =>
          `• ${event.date ? `*${s(event.date)}* ` : ''}${s(event.title)}${event.description ? ` — ${s(event.description)}` : ''}`,
      )
      .join('\n')}`,
});

export const CodeBlock = defineComponent<Props>({
  name: 'CodeBlock',
  title: 'Code',
  description: 'A code snippet or file excerpt with syntax highlighting.',
  props: obj({ title: str(), language: str(), code: str() }, ['code']),
  fallbackText: (props) => `${heading(props)}\`\`\`\n${s(props.code)}\n\`\`\``,
});

export const Diff = defineComponent<Props>({
  name: 'Diff',
  title: 'Diff',
  description: 'A before/after change to a text or code file, as a line diff.',
  props: obj({ title: str(), language: str(), before: str(), after: str() }, ['before', 'after']),
  fallbackText: (props) =>
    `${heading(props)}\`\`\`\n${lineDiff(s(props.before), s(props.after))
      .map((line) => `${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '} ${line.text}`)
      .join('\n')}\n\`\`\``,
});

export const Callout = defineComponent<Props>({
  name: 'Callout',
  title: 'Callout',
  description: 'A short note, warning or success message, emphasized.',
  props: obj(
    {
      tone: str(undefined, { enum: ['info', 'success', 'warning', 'danger'] }),
      title: str(),
      text: str(),
    },
    ['text'],
  ),
  fallbackText: (props) =>
    `${props.tone === 'warning' || props.tone === 'danger' ? ':warning: ' : ':information_source: '}${heading(props)}${s(props.text)}`,
});

export const Stack = defineComponent<Props>({
  name: 'Stack',
  title: 'Stack',
  description: 'Lays its children out vertically (or horizontally with direction=row).',
  props: obj({ direction: str(undefined, { enum: ['column', 'row'] }), gap: { type: 'number' } }),
  children: true,
  fallbackText: () => '',
});

export const Card = defineComponent<Props>({
  name: 'Card',
  title: 'Card',
  description: 'A box with an optional title around its children.',
  props: obj({ title: str(), subtitle: str() }),
  children: true,
  fallbackText: (props) =>
    props.title ? `*${s(props.title)}*${props.subtitle ? ` — ${s(props.subtitle)}` : ''}` : '',
});

export const Heading = defineComponent<Props>({
  name: 'Heading',
  title: 'Heading',
  description: 'A heading.',
  props: obj({ text: str() }, ['text']),
  fallbackText: (props) => `*${s(props.text)}*`,
});

export const Text = defineComponent<Props>({
  name: 'Text',
  title: 'Text',
  description: 'A paragraph of plain text (no markdown).',
  props: obj({ text: str(), muted: { type: 'boolean' } }, ['text']),
  fallbackText: (props) => s(props.text),
});

export const Badge = defineComponent<Props>({
  name: 'Badge',
  title: 'Badge',
  description: 'A small label.',
  props: obj(
    {
      text: str(),
      tone: str(undefined, { enum: ['neutral', 'brand', 'success', 'warning', 'danger'] }),
    },
    ['text'],
  ),
  fallbackText: (props) => `[${s(props.text)}]`,
});

export const Link = defineComponent<Props>({
  name: 'Link',
  title: 'Link',
  description: 'A link to an http(s) URL.',
  props: obj({ text: str(), url: str(undefined, { pattern: '^https?://' }) }, ['text', 'url']),
  fallbackText: (props) => `<${s(props.url)}|${s(props.text || props.url)}>`,
});

export const Image = defineComponent<Props>({
  name: 'Image',
  title: 'Image',
  description: 'An image from an https URL.',
  props: obj({ url: str(undefined, { pattern: '^https://' }), alt: str() }, ['url']),
  fallbackText: (props) => s(props.url),
});

/** Content components: data a model shows. */
export const BUILTIN_COMPONENTS: readonly ComponentDefinition<unknown>[] = [
  DataTable,
  Chart,
  KpiCards,
  SourceCards,
  Checklist,
  Timeline,
  CodeBlock,
  Diff,
  Callout,
];

/** Layout and text primitives, mostly for composing trees (`Stack`, `Card` take children). */
export const LAYOUT_COMPONENTS: readonly ComponentDefinition<unknown>[] = [
  Stack,
  Card,
  Heading,
  Text,
  Badge,
  Link,
  Image,
];
