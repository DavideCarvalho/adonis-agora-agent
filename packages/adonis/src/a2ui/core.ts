/**
 * A2UI (https://a2ui.org) — Google's declarative agent-to-UI protocol — for this agent's generative
 * UI, framework-free. Targets A2UI **v0.9** (the current production family: v0.9.1 is a patch of
 * it; v1.0 is a release candidate).
 *
 *  - Outbound: a `ui` frame (one component, or a composed `genui:tree`) becomes a surface — a flat
 *    list of A2UI components keyed by id — that any A2UI renderer (Lit, Angular, Flutter, React)
 *    draws. Library builtins map onto A2UI's basic catalog; an app maps its own components with a
 *    function, or sends them through as custom components of its own A2UI catalog.
 *  - Streamed: a preview frame the model is still writing becomes the same surface, partially —
 *    A2UI renderers draw what has arrived and leave a child that is not there yet as a placeholder.
 *  - Inbound: an A2UI `action` (v0.9) or `userAction` (v0.8) becomes a {@link UiAction}: the next
 *    user turn.
 */
import type { AgUiEvent, AgUiInterrupt } from '../ag-ui/core/types.js';
import {
  readUiAction,
  readUiActionText,
  type UiAction,
  type UiActionMessage,
} from '../genui/actions.js';
import type { Catalog } from '../genui/catalog.js';
import { toJsonSchema } from '../genui/schema.js';
import { componentToText } from '../genui/text.js';
import { GENUI_TREE_COMPONENT } from '../genui/tree.js';

/** The A2UI protocol version every message is stamped with. */
export const A2UI_VERSION = 'v0.9';

/** The catalog id of A2UI v0.9's basic catalog (what `@a2ui/react`'s `basicCatalog.id` is). */
export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

/**
 * The id the AG-UI A2UI binding knows the basic catalog by: `@ag-ui/a2ui-middleware`,
 * `@ag-ui/a2ui-toolkit` and CopilotKit's A2UI renderer (1.77, on `@a2ui/web_core` 0.10) register it
 * under this earlier v0.9 id, not {@link A2UI_BASIC_CATALOG_ID}. The AG-UI transport's default.
 */
export const A2UI_LEGACY_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/basic_catalog.json';

/** Every id the basic catalog goes by: the current one first. */
export const A2UI_BASIC_CATALOG_IDS: readonly string[] = Object.freeze([
  A2UI_BASIC_CATALOG_ID,
  A2UI_LEGACY_BASIC_CATALOG_ID,
]);

/** Whether a catalog id names A2UI v0.9's basic catalog (under either of its ids). */
export function isA2uiBasicCatalogId(id: unknown): id is string {
  return typeof id === 'string' && A2UI_BASIC_CATALOG_IDS.includes(id);
}

/** The components of A2UI v0.9's basic catalog. */
export const A2UI_BASIC_COMPONENTS = [
  'Text',
  'Image',
  'Icon',
  'Video',
  'AudioPlayer',
  'Row',
  'Column',
  'List',
  'Card',
  'Tabs',
  'Modal',
  'Divider',
  'Button',
  'CheckBox',
  'TextField',
  'DateTimeInput',
  'ChoicePicker',
  'Slider',
] as const;

/** The AG-UI activity type A2UI surfaces travel under (AG-UI's A2UI middleware, CopilotKit). */
export const A2UI_ACTIVITY_TYPE = 'a2ui-surface';

/** The key of the A2UI messages in an `a2ui-surface` activity's content. */
export const A2UI_OPERATIONS_KEY = 'a2ui_operations';

/** Action names the transports answer themselves: deciding a parked approval. */
export const A2UI_APPROVE_ACTION = 'agora.approve';
export const A2UI_REJECT_ACTION = 'agora.reject';

/** One A2UI component: its id, its catalog type, and its properties flat beside them. */
export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

/** One server-to-client A2UI message. */
export type A2uiServerMessage = { version: typeof A2UI_VERSION } & (
  | {
      createSurface: {
        surfaceId: string;
        catalogId: string;
        theme?: Record<string, unknown>;
        sendDataModel?: boolean;
      };
    }
  | { updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { deleteSurface: { surfaceId: string } }
);

/** What a mapper is handed for one node. */
export interface A2uiMapContext {
  /** The id the node's root component MUST take (its parent references it). */
  id: string;
  /** The ids of the node's children, already converted (a layout lists them). */
  children: readonly string[];
  /** A fresh id derived from the node's (`<id>~<suffix>`), for the extra components a mapping needs. */
  derive(suffix: string): string;
  /** The node is still being written (a preview): props may be missing — default them. */
  incomplete: boolean;
  /** The component's plain-text fallback (`fallbackText`), for a mapping that only has text. */
  text(): string;
}

/**
 * Maps one of this agent's components to A2UI components. Must return a component whose `id` is
 * `ctx.id`; any others it adds take ids from `ctx.derive`.
 */
export type A2uiMapper = (props: Record<string, unknown>, ctx: A2uiMapContext) => A2uiComponent[];

export interface A2uiOptions {
  /**
   * The A2UI catalog surfaces are created with. Default the basic catalog. An app that registers
   * its own components on the client names its catalog here (and lists them in `custom`). Either id
   * of the basic catalog ({@link A2UI_BASIC_CATALOG_IDS}) means "the basic catalog": the id the
   * client advertises for it wins.
   */
  catalogId?: string;
  /**
   * The id the client knows the basic catalog by — what text, approval and error surfaces (always
   * basic) are created with, and `catalogId`'s default. Normally left unset: each transport picks
   * it from the catalogs the client advertises (`a2uiClientCapabilities`), else uses its own
   * default ({@link A2UI_BASIC_CATALOG_ID} on the A2UI route, {@link A2UI_LEGACY_BASIC_CATALOG_ID}
   * over AG-UI).
   */
  basicCatalogId?: string;
  /**
   * Create every surface with `sendDataModel: true`: the client sends the surface's data model back
   * with its next message (`a2uiClientDataModel`), which the A2UI route hands the prompt builder as
   * `pageContext.a2uiDataModel`.
   */
  sendDataModel?: boolean;
  /** Per component: a mapping to A2UI (overrides a builtin's), or `'custom'` to send it as is. */
  components?: Record<string, A2uiMapper | 'custom'>;
  /**
   * A component with no mapping: `'text'` (default) draws its `fallbackText` as an A2UI `Text`;
   * `'custom'` sends it as a custom component of the same name, props flat (the client's catalog
   * must have it).
   */
  unmapped?: 'text' | 'custom';
  /** The agent's catalog: what unmapped components' text comes from. */
  catalog?: Catalog;
  /** `createSurface.theme` (basic catalog: `primaryColor`, `agentDisplayName`, `iconUrl`). */
  theme?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

function text(id: string, value: string, variant?: string): A2uiComponent {
  return { id, component: 'Text', text: value, ...(variant !== undefined ? { variant } : {}) };
}

/** A column of `[heading?, ...children]` — what most builtins come down to. */
function titled(
  ctx: A2uiMapContext,
  title: unknown,
  children: readonly string[],
  extra: A2uiComponent[] = [],
): A2uiComponent[] {
  const heading = typeof title === 'string' && title.length > 0;
  const titleId = ctx.derive('title');
  return [
    {
      id: ctx.id,
      component: 'Column',
      children: heading ? [titleId, ...children] : [...children],
    },
    ...(heading ? [text(titleId, title as string, 'h4')] : []),
    ...extra,
  ];
}

function cards(
  ctx: A2uiMapContext,
  items: unknown,
  lines: (item: Record<string, unknown>) => [string, string | undefined][],
): A2uiComponent[] {
  const list = Array.isArray(items) ? items.filter(isRecord) : [];
  const out: A2uiComponent[] = [];
  const ids: string[] = [];
  list.forEach((item, index) => {
    const card = ctx.derive(`item${index}`);
    const column = ctx.derive(`item${index}col`);
    const parts = lines(item).filter(([value]) => value.length > 0);
    ids.push(card);
    out.push({ id: card, component: 'Card', child: column });
    out.push({
      id: column,
      component: 'Column',
      children: parts.map((_, line) => ctx.derive(`item${index}l${line}`)),
    });
    parts.forEach(([value, variant], line) => {
      out.push(text(ctx.derive(`item${index}l${line}`), value, variant));
    });
  });
  return [{ id: ctx.id, component: 'Row', children: ids }, ...out];
}

function table(
  ctx: A2uiMapContext,
  title: unknown,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
): A2uiComponent[] {
  const out: A2uiComponent[] = [];
  const header = ctx.derive('header');
  const rowIds = rows.map((_, index) => ctx.derive(`row${index}`));
  out.push({
    id: header,
    component: 'Row',
    children: columns.map((_, index) => ctx.derive(`h${index}`)),
  });
  columns.forEach((column, index) => {
    out.push({ ...text(ctx.derive(`h${index}`), column.label, 'caption'), weight: 1 });
  });
  rows.forEach((row, r) => {
    out.push({
      id: rowIds[r] as string,
      component: 'Row',
      children: columns.map((_, c) => ctx.derive(`r${r}c${c}`)),
    });
    columns.forEach((column, c) => {
      out.push({ ...text(ctx.derive(`r${r}c${c}`), str(row[column.key])), weight: 1 });
    });
  });
  return titled(ctx, title, [header, ...rowIds], out);
}

function columnsOf(value: unknown): { key: string; label: string }[] {
  return (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .filter((column) => typeof column.key === 'string')
    .map((column) => ({
      key: column.key as string,
      label: str(column.label, column.key as string),
    }));
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).filter(isRecord);
}

/** The library builtins, mapped onto A2UI's basic catalog. */
export const A2UI_BUILTIN_MAPPERS: Readonly<Record<string, A2uiMapper>> = Object.freeze({
  Stack: (props, ctx) => [
    {
      id: ctx.id,
      component: props.direction === 'row' ? 'Row' : 'Column',
      children: [...ctx.children],
    },
  ],
  Card: (props, ctx) => {
    const inner = ctx.derive('body');
    const subtitle = ctx.derive('subtitle');
    const hasSubtitle = typeof props.subtitle === 'string' && props.subtitle.length > 0;
    return [
      { id: ctx.id, component: 'Card', child: inner },
      ...titled(
        { ...ctx, id: inner },
        props.title,
        hasSubtitle ? [subtitle, ...ctx.children] : ctx.children,
        hasSubtitle ? [text(subtitle, props.subtitle as string, 'caption')] : [],
      ),
    ];
  },
  Heading: (props, ctx) => [text(ctx.id, str(props.text), 'h3')],
  Text: (props, ctx) => [text(ctx.id, str(props.text), props.muted === true ? 'caption' : 'body')],
  Badge: (props, ctx) => [text(ctx.id, str(props.text), 'caption')],
  Callout: (props, ctx) => {
    const body = ctx.derive('body');
    const message = ctx.derive('text');
    return [
      { id: ctx.id, component: 'Card', child: body },
      ...titled({ ...ctx, id: body }, props.title, [message], [text(message, str(props.text))]),
    ];
  },
  Link: (props, ctx) => {
    const label = ctx.derive('label');
    return [
      {
        id: ctx.id,
        component: 'Button',
        variant: 'borderless',
        child: label,
        action: { functionCall: { call: 'openUrl', args: { url: str(props.url) } } },
      },
      text(label, str(props.text, str(props.url))),
    ];
  },
  Image: (props, ctx) => [
    {
      id: ctx.id,
      component: 'Image',
      url: str(props.url),
      ...(typeof props.alt === 'string' ? { description: props.alt } : {}),
    },
  ],
  CodeBlock: (props, ctx) => [text(ctx.id, `\`\`\`\n${str(props.code)}\n\`\`\``)],
  KpiCards: (props, ctx) =>
    cards(ctx, props.items, (item) => [
      [str(item.label), 'caption'],
      [str(item.value), 'h3'],
      [str(item.delta), 'caption'],
    ]),
  SourceCards: (props, ctx) =>
    cards(ctx, props.items, (item) => [
      [str(item.title), 'h5'],
      [str(item.snippet), 'body'],
      [str(item.source, str(item.url)), 'caption'],
    ]),
  DataTable: (props, ctx) => table(ctx, props.title, columnsOf(props.columns), rowsOf(props.rows)),
  // The basic catalog has no chart: its points, as a table — what a text client gets too.
  Chart: (props, ctx) => {
    const xKey = str(props.xKey);
    const series = (Array.isArray(props.series) ? props.series : [])
      .filter(isRecord)
      .filter((each) => typeof each.key === 'string')
      .map((each) => ({ key: each.key as string, label: str(each.label, each.key as string) }));
    return table(ctx, props.title, [{ key: xKey, label: xKey }, ...series], rowsOf(props.data));
  },
});

/** Ids A2UI renderers accept everywhere: the node ids (`root.0.1`) and derived ones (`root.0~title`). */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.~:-]/g, '_');
}

interface NodeLike {
  type: string;
  props: Record<string, unknown>;
  children?: NodeLike[];
  incomplete?: true;
  held?: true;
}

/**
 * A `ui` frame as A2UI components, flat, the root's id `root`. A composed tree (`genui:tree`) maps
 * node by node — node ids are their positions (`root`, `root.0`, `root.0.2`), stable from the first
 * preview to the final frame, so a streamed surface only ever grows. A node still held back
 * (`held`) is left out: its parent references an id that arrives later, which A2UI draws as a
 * placeholder.
 */
export function toA2uiComponents(
  frame: { component: string; props: unknown },
  options: A2uiOptions = {},
): A2uiComponent[] {
  const props = isRecord(frame.props) ? frame.props : {};
  const root: NodeLike | undefined =
    frame.component === GENUI_TREE_COMPONENT
      ? isRecord(props.root) && typeof props.root.type === 'string'
        ? (props.root as unknown as NodeLike)
        : undefined
      : { type: frame.component, props };
  if (root === undefined) return [];
  const out: A2uiComponent[] = [];
  const visit = (node: NodeLike, id: string, depth: number) => {
    if (depth > 32 || node.held === true) return;
    const children = (Array.isArray(node.children) ? node.children : []).filter(
      (child): child is NodeLike => isRecord(child) && typeof child.type === 'string',
    );
    const childIds = children.map((_, index) => `${id}.${index}`);
    const nodeProps = isRecord(node.props) ? node.props : {};
    const ctx: A2uiMapContext = {
      id,
      children: childIds,
      derive: (suffix) => `${id}~${suffix}`,
      incomplete: node.incomplete === true,
      text: () =>
        options.catalog !== undefined ? componentToText(options.catalog, node.type, nodeProps) : '',
    };
    out.push(...mapNode(node.type, nodeProps, ctx, options));
    children.forEach((child, index) => {
      visit(child, childIds[index] as string, depth + 1);
    });
  };
  visit(root, 'root', 1);
  return out.map((component) => ({ ...component, id: safeId(component.id) })).map(fixRefs);
}

function fixRefs(component: A2uiComponent): A2uiComponent {
  const next: A2uiComponent = { ...component };
  if (Array.isArray(next.children)) next.children = next.children.map((id) => safeId(String(id)));
  for (const key of ['child', 'trigger', 'content'] as const) {
    if (typeof next[key] === 'string') next[key] = safeId(next[key] as string);
  }
  return next;
}

function mapNode(
  type: string,
  props: Record<string, unknown>,
  ctx: A2uiMapContext,
  options: A2uiOptions,
): A2uiComponent[] {
  const own = options.components?.[type];
  if (typeof own === 'function') return withRoot(own(props, ctx), ctx, type);
  if (own === 'custom' || (own === undefined && options.unmapped === 'custom')) {
    return [
      {
        ...props,
        id: ctx.id,
        component: type,
        ...(ctx.children.length > 0 ? { children: [...ctx.children] } : {}),
      },
    ];
  }
  const builtin = A2UI_BUILTIN_MAPPERS[type];
  if (builtin !== undefined) return withRoot(builtin(props, ctx), ctx, type);
  // Nothing maps it: its words, then whatever it holds.
  const words = ctx.text();
  if (ctx.children.length === 0) return [text(ctx.id, words)];
  const label = ctx.derive('text');
  return [
    {
      id: ctx.id,
      component: 'Column',
      children: words.length > 0 ? [label, ...ctx.children] : [...ctx.children],
    },
    ...(words.length > 0 ? [text(label, words)] : []),
  ];
}

function withRoot(components: A2uiComponent[], ctx: A2uiMapContext, type: string): A2uiComponent[] {
  if (!components.some((component) => component.id === ctx.id)) {
    throw new Error(`a2ui: the mapping of ${type} must return a component with id "${ctx.id}"`);
  }
  return components;
}

/**
 * {@link toA2uiComponents} that never throws: a mapping that fails (an app mapper that throws or
 * forgets the root id) draws the component's text instead of breaking the stream it rides on.
 */
function safeComponents(
  frame: { component: string; props: unknown },
  options: A2uiOptions,
): A2uiComponent[] {
  try {
    return toA2uiComponents(frame, options);
  } catch {
    const props = isRecord(frame.props) ? frame.props : {};
    const words =
      options.catalog !== undefined ? componentToText(options.catalog, frame.component, props) : '';
    return words.length > 0 ? [text('root', words)] : [];
  }
}

/** The messages that draw (or redraw) a surface: `createSurface` the first time, then its components. */
export function a2uiSurfaceMessages(
  surfaceId: string,
  components: A2uiComponent[],
  options: A2uiOptions & { create: boolean; sendDataModel?: boolean },
): A2uiServerMessage[] {
  const out: A2uiServerMessage[] = [];
  if (options.create) {
    out.push({
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: options.catalogId ?? options.basicCatalogId ?? A2UI_BASIC_CATALOG_ID,
        ...(options.theme !== undefined ? { theme: options.theme } : {}),
        ...(options.sendDataModel === true ? { sendDataModel: true } : {}),
      },
    });
  }
  if (components.length > 0) {
    out.push({ version: A2UI_VERSION, updateComponents: { surfaceId, components } });
  }
  return out;
}

/** A surface id A2UI clients accept, from a `ui` frame id (`<toolCallId>:ui:0`). */
export function a2uiSurfaceId(frameId: string): string {
  return frameId.replace(/[^A-Za-z0-9_.~:-]/g, '_');
}

/**
 * A2UI's AG-UI binding (the AG-UI A2UI middleware, CopilotKit's renderer): one `ACTIVITY_SNAPSHOT`
 * of type `a2ui-surface` per `ui` frame, carrying the whole surface (`createSurface` +
 * `updateComponents`) with `replace: true` — so each preview of a streaming tree repaints the same
 * activity in place, keyed by the frame id.
 */
export function a2uiActivityEvent(
  frame: { id: string; component: string; props: unknown; partial?: boolean },
  options: A2uiOptions = {},
): AgUiEvent | null {
  const props = isRecord(frame.props) ? frame.props : {};
  const surfaceId = a2uiSurfaceId(frame.id);
  // A withdrawn preview: the surface it painted goes.
  if (frame.partial === true && Object.keys(props).length === 0) {
    return {
      type: 'ACTIVITY_SNAPSHOT',
      messageId: `a2ui-surface-${surfaceId}`,
      activityType: A2UI_ACTIVITY_TYPE,
      content: { [A2UI_OPERATIONS_KEY]: [{ version: A2UI_VERSION, deleteSurface: { surfaceId } }] },
      replace: true,
    };
  }
  const components = safeComponents(frame, options);
  if (components.length === 0) return null;
  return {
    type: 'ACTIVITY_SNAPSHOT',
    messageId: `a2ui-surface-${surfaceId}`,
    activityType: A2UI_ACTIVITY_TYPE,
    content: {
      [A2UI_OPERATIONS_KEY]: a2uiSurfaceMessages(surfaceId, components, {
        ...options,
        create: true,
      }),
    },
    replace: true,
  };
}

/**
 * An A2UI catalog definition (v0.9 inline catalog shape) for an agent catalog's components sent
 * as custom components: `{ catalogId, components: { Name: JSON Schema } }` — what a client
 * registers, or hands an A2UI-aware runtime (`a2uiClientCapabilities.inlineCatalogs`).
 */
export function a2uiCatalog(
  catalog: Catalog,
  options: { catalogId: string; only?: readonly string[] },
): { catalogId: string; components: Record<string, Record<string, unknown>> } {
  const components: Record<string, Record<string, unknown>> = {};
  for (const definition of catalog.modelComponents()) {
    if (options.only !== undefined && !options.only.includes(definition.name)) continue;
    const schema = toJsonSchema(definition.props) ?? { type: 'object' };
    const properties = isRecord(schema.properties) ? schema.properties : {};
    components[definition.name] = {
      type: 'object',
      description: definition.description,
      properties: {
        component: { const: definition.name },
        ...properties,
        ...(definition.children === true
          ? {
              children: {
                $ref: 'https://a2ui.org/specification/v0_9/common_types.json#/$defs/ChildList',
              },
            }
          : {}),
      },
      required: ['component', ...(Array.isArray(schema.required) ? schema.required : [])],
    };
  }
  return { catalogId: options.catalogId, components };
}

/**
 * A client-to-server A2UI message, or an AG-UI `forwardedProps.a2uiAction`, as a {@link UiAction}:
 * v0.9 `{ version, action: { name, surfaceId, sourceComponentId, timestamp, context } }`, v0.8
 * `{ userAction: { … } }`, or the bare action object. A string when it is not one.
 */
export function readA2uiAction(
  raw: unknown,
  options: { maxBytes?: number } = {},
): UiAction | string {
  if (!isRecord(raw)) return 'an A2UI action must be an object';
  const inner = isRecord(raw.action) ? raw.action : isRecord(raw.userAction) ? raw.userAction : raw;
  if (typeof inner.name !== 'string') return 'an A2UI action carries a name';
  return readUiAction(
    {
      source: 'a2ui',
      name: inner.name,
      context: isRecord(inner.context) ? inner.context : {},
      ...(typeof inner.surfaceId === 'string' ? { surfaceId: inner.surfaceId } : {}),
      ...(typeof inner.sourceComponentId === 'string'
        ? { componentId: inner.sourceComponentId }
        : {}),
      ...(typeof inner.timestamp === 'string' ? { timestamp: inner.timestamp } : {}),
      ...(typeof inner.text === 'string' ? { text: inner.text } : {}),
    },
    { ...options, source: 'a2ui' },
  );
}

/** The surface an approval interrupt is shown on: its message, and Approve / Reject buttons. */
export function a2uiApprovalComponents(interrupt: AgUiInterrupt): A2uiComponent[] {
  const button = (id: string, label: string, name: string, variant: string): A2uiComponent[] => [
    {
      id,
      component: 'Button',
      variant,
      child: `${id}~label`,
      action: { event: { name, context: { interruptId: interrupt.id } } },
    },
    text(`${id}~label`, label),
  ];
  return [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['message', 'buttons'] },
    text('message', interrupt.message ?? 'Approve?', 'body'),
    { id: 'buttons', component: 'Row', children: ['approve', 'reject'] },
    ...button('approve', 'Approve', A2UI_APPROVE_ACTION, 'primary'),
    ...button('reject', 'Reject', A2UI_REJECT_ACTION, 'default'),
  ];
}

export interface A2uiStreamOptions extends A2uiOptions {
  /**
   * Assistant text: `'surface'` (default) streams it into a surface of its own — one `Text` bound
   * to `/text` in the data model, updated as tokens arrive; `'omit'` leaves text out (UI only).
   */
  text?: 'surface' | 'omit';
}

/**
 * One AG-UI run as an A2UI message stream — the projection the A2UI transport serves. Stateful
 * (which surfaces exist), pure otherwise: feed it the run's AG-UI events in order.
 *
 *  - `CUSTOM agora.ui` → a surface per `ui` frame id, created once and updated in place (previews
 *    included); a withdrawn preview deletes it;
 *  - text messages → a text surface each (see {@link A2uiStreamOptions.text});
 *  - an approval interrupt → a surface with Approve / Reject buttons ({@link A2UI_APPROVE_ACTION});
 *    any other interrupt → a text surface saying to answer it in the app;
 *  - `RUN_ERROR` → a text surface with the message.
 */
export class A2uiProjector {
  private readonly surfaces = new Set<string>();
  private readonly texts = new Map<string, string>();

  constructor(private readonly options: A2uiStreamOptions = {}) {}

  project(event: AgUiEvent): A2uiServerMessage[] {
    switch (event.type) {
      case 'CUSTOM':
        return event.name === 'agora.ui' ? this.ui(event.value) : [];
      case 'TEXT_MESSAGE_START':
        if (this.options.text === 'omit') return [];
        this.texts.set(event.messageId, '');
        return this.surface(`text-${event.messageId}`, [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]);
      case 'TEXT_MESSAGE_CONTENT': {
        if (this.options.text === 'omit') return [];
        const next = `${this.texts.get(event.messageId) ?? ''}${event.delta}`;
        this.texts.set(event.messageId, next);
        return [
          {
            version: A2UI_VERSION,
            updateDataModel: { surfaceId: `text-${event.messageId}`, path: '/text', value: next },
          },
        ];
      }
      case 'RUN_FINISHED': {
        const outcome = (event as { outcome?: unknown }).outcome;
        if (!isRecord(outcome) || outcome.type !== 'interrupt') return [];
        const interrupts = Array.isArray(outcome.interrupts) ? outcome.interrupts : [];
        return interrupts.filter(isRecord).flatMap((interrupt) => {
          const id = a2uiSurfaceId(`interrupt-${String(interrupt.id)}`);
          return interrupt.reason === 'tool_approval'
            ? this.surface(id, a2uiApprovalComponents(interrupt as unknown as AgUiInterrupt))
            : this.surface(id, [
                text(
                  'root',
                  `${str(interrupt.message, 'The assistant is waiting for an answer.')} (answer it in the app)`,
                ),
              ]);
        });
      }
      case 'RUN_ERROR':
        return this.surface(`error-${this.surfaces.size}`, [text('root', event.message)]);
      default:
        return [];
    }
  }

  private surface(surfaceId: string, components: A2uiComponent[]): A2uiServerMessage[] {
    const create = !this.surfaces.has(surfaceId);
    this.surfaces.add(surfaceId);
    return a2uiSurfaceMessages(surfaceId, components, {
      ...this.options,
      // Text, approvals and errors are basic-catalog components whatever the app's catalog is.
      catalogId: this.options.basicCatalogId ?? A2UI_BASIC_CATALOG_ID,
      create,
    });
  }

  private ui(value: unknown): A2uiServerMessage[] {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.component !== 'string') {
      return [];
    }
    const surfaceId = a2uiSurfaceId(value.id);
    const props = isRecord(value.props) ? value.props : {};
    if (value.partial === true && Object.keys(props).length === 0) {
      if (!this.surfaces.delete(surfaceId)) return [];
      return [{ version: A2UI_VERSION, deleteSurface: { surfaceId } }];
    }
    const components = safeComponents(
      { component: value.component, props: props as Record<string, unknown> },
      this.options,
    );
    if (components.length === 0) return [];
    const create = !this.surfaces.has(surfaceId);
    this.surfaces.add(surfaceId);
    return a2uiSurfaceMessages(surfaceId, components, { ...this.options, create });
  }
}

function catalogIdsOf(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.supportedCatalogIds)) return undefined;
  return value.supportedCatalogIds.filter((id): id is string => typeof id === 'string');
}

/**
 * The catalog ids a client says it draws, from its `a2uiClientCapabilities`: v0.9's
 * `{ 'v0.9': { supportedCatalogIds } }` (what `MessageProcessor.getRendererCapabilities()` builds),
 * a `v0.9.1` entry, or a flat `{ supportedCatalogIds }`. `undefined` when it names none.
 */
export function readA2uiClientCapabilities(raw: unknown): string[] | undefined {
  if (!isRecord(raw)) return undefined;
  const ids = [
    ...(catalogIdsOf(raw['v0.9']) ?? []),
    ...(catalogIdsOf(raw['v0.9.1']) ?? []),
    ...(catalogIdsOf(raw) ?? []),
  ];
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/** The AG-UI context entry CopilotKit's A2UI provider sends ("A2UI catalog capabilities: …"). */
const AG_UI_CATALOG_CONTEXT = /^A2UI catalog capabilities/i;

/**
 * The catalog ids an AG-UI client advertises: `forwardedProps.a2uiClientCapabilities`, or the
 * `context` entry CopilotKit's A2UI provider adds (its value lists the ids, one `- <id>` per line).
 */
export function readAgUiA2uiCatalogIds(input: {
  forwardedProps?: unknown;
  context?: readonly unknown[];
}): string[] | undefined {
  const forwarded = isRecord(input.forwardedProps)
    ? readA2uiClientCapabilities(input.forwardedProps.a2uiClientCapabilities)
    : undefined;
  if (forwarded !== undefined) return forwarded;
  const ids: string[] = [];
  for (const entry of input.context ?? []) {
    if (!isRecord(entry) || typeof entry.description !== 'string') continue;
    if (!AG_UI_CATALOG_CONTEXT.test(entry.description) || typeof entry.value !== 'string') continue;
    for (const line of entry.value.split('\n')) {
      const id = /^\s*-\s+(\S+:\/\/\S+)/.exec(line)?.[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/**
 * Options for one client: the basic catalog under the id the client advertises (else the
 * configured `basicCatalogId`, a basic `catalogId`, or the transport's `fallback`), and `catalogId`
 * resolved — an app catalog stays as configured; the basic catalog takes the negotiated id.
 */
export function negotiateA2uiCatalog(
  options: A2uiOptions,
  supported: readonly string[] | undefined,
  fallback: string = A2UI_BASIC_CATALOG_ID,
): A2uiOptions {
  const advertised = (supported ?? []).filter(isA2uiBasicCatalogId);
  const preferred = [options.basicCatalogId, options.catalogId].find(
    (id) => id !== undefined && advertised.includes(id),
  );
  const basic =
    preferred ??
    advertised[0] ??
    options.basicCatalogId ??
    (isA2uiBasicCatalogId(options.catalogId) ? options.catalogId : undefined) ??
    fallback;
  const catalogId =
    options.catalogId === undefined || isA2uiBasicCatalogId(options.catalogId)
      ? basic
      : options.catalogId;
  return { ...options, basicCatalogId: basic, catalogId };
}

/** One stored message, as much of it as a replay reads. */
export interface A2uiStoredMessage {
  id: string;
  role: string;
  content: string;
  ui?: readonly { id: string; component: string; props: unknown; partial?: true }[];
}

/** One entry of a replayed thread: the user's line, or an assistant step's surfaces. */
export type A2uiReplayEntry =
  | {
      role: 'user';
      id: string;
      text: string;
      /** The message was a UI action: its parts (draw `action.text`; the values are the model's). */
      action?: UiActionMessage;
    }
  | { role: 'assistant'; id: string; messages: A2uiServerMessage[] };

/**
 * A stored thread as A2UI, for a client that reopens it: each user message as its line, each
 * assistant step as the surfaces the live stream drew — its text (one `Text`), then every `ui`
 * frame it kept (the last props per id), mapped exactly as the stream maps them, under the same
 * surface ids. An approval the thread is still waiting on is not redrawn: ask again by sending.
 */
export function a2uiThreadReplay(
  messages: readonly A2uiStoredMessage[],
  options: A2uiStreamOptions = {},
): A2uiReplayEntry[] {
  const out: A2uiReplayEntry[] = [];
  const basic = options.basicCatalogId ?? A2UI_BASIC_CATALOG_ID;
  for (const message of messages) {
    if (message.role === 'user') {
      const action = readUiActionText(message.content);
      out.push({
        role: 'user',
        id: message.id,
        text: action?.text ?? message.content,
        ...(action !== null ? { action } : {}),
      });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const surfaces: A2uiServerMessage[] = [];
    if (options.text !== 'omit' && message.content.trim().length > 0) {
      surfaces.push(
        ...a2uiSurfaceMessages(`text-${message.id}`, [text('root', message.content)], {
          ...options,
          catalogId: basic,
          create: true,
        }),
      );
    }
    for (const frame of message.ui ?? []) {
      if (frame.partial === true) continue;
      const components = safeComponents(frame, options);
      if (components.length === 0) continue;
      surfaces.push(
        ...a2uiSurfaceMessages(a2uiSurfaceId(frame.id), components, { ...options, create: true }),
      );
    }
    if (surfaces.length > 0) out.push({ role: 'assistant', id: message.id, messages: surfaces });
  }
  return out;
}
