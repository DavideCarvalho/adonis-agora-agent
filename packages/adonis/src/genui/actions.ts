/**
 * UI actions: what a drawn component hands back to the agent — a sandbox's `agent.send(…)`, an
 * A2UI button's `action` event, an app component's own button. Every kind becomes the same thing:
 * the next user turn, whose text says what was done and carries the values.
 *
 * Framework-free and isomorphic: the browser builds one before sending, the server reads and checks
 * one that arrives over a protocol (A2UI, AG-UI's `forwardedProps`).
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  builtinJsonSchemaValidator,
  type GenuiIssue,
  type JsonSchema,
  type PropsSchema,
  validateProps,
} from './schema.js';

/** Where an action came from. */
export type UiActionSource = 'sandbox' | 'a2ui' | 'component';

export interface UiAction {
  source: UiActionSource;
  /** What was done (`send` for a plain `agent.send`, an A2UI event's `name`, a button's own name). */
  name: string;
  /** The values that go with it — JSON. */
  context: Record<string, unknown>;
  /** What the user says by doing it ("Split it three ways"). Shown as their message. */
  text?: string;
  /** The `ui` frame id (or A2UI surface id) the action came from. */
  surfaceId?: string;
  /** The tree node (or A2UI component id) that raised it. */
  componentId?: string;
  /** The view's title, for the model's benefit. */
  title?: string;
  /** ISO 8601, when the user acted. */
  timestamp?: string;
}

/** Largest action accepted by default, as JSON, in bytes. */
export const UI_ACTION_MAX_BYTES = 8192;

const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Bytes of `value` as JSON, or `undefined` when it is not JSON (a cycle, a function, a bigint). */
export function jsonByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : byteLength(json);
  } catch {
    return undefined;
  }
}

export interface ReadUiActionOptions {
  /** Default {@link UI_ACTION_MAX_BYTES}. */
  maxBytes?: number;
  /** The source to stamp when the raw value names none. Default `component`. */
  source?: UiActionSource;
}

/**
 * A UI action from untrusted input, checked: a plain object with a short `name` and a JSON
 * `context`, no larger than `maxBytes`. Answers the problem as a string when it is refused.
 */
export function readUiAction(raw: unknown, options: ReadUiActionOptions = {}): UiAction | string {
  if (!isRecord(raw)) return 'a UI action must be an object';
  const size = jsonByteLength(raw);
  const max = options.maxBytes ?? UI_ACTION_MAX_BYTES;
  if (size === undefined) return 'a UI action must be JSON';
  if (size > max) return `a UI action may be at most ${max} bytes (this one is ${size})`;
  const name = raw.name ?? 'send';
  if (typeof name !== 'string' || !NAME.test(name)) {
    return 'a UI action name is 1-64 letters, digits, "_", ".", ":" or "-"';
  }
  const context = raw.context ?? {};
  if (!isRecord(context)) return 'a UI action context must be an object';
  const source =
    raw.source === 'sandbox' || raw.source === 'a2ui' || raw.source === 'component'
      ? raw.source
      : (options.source ?? 'component');
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 500) : undefined;
  const str = (value: unknown, limit = 200) =>
    typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined;
  const surfaceId = str(raw.surfaceId);
  const componentId = str(raw.componentId);
  const title = str(raw.title);
  const timestamp = str(raw.timestamp, 40);
  return {
    source,
    name,
    context,
    ...(text !== undefined && text.length > 0 ? { text } : {}),
    ...(surfaceId !== undefined ? { surfaceId } : {}),
    ...(componentId !== undefined ? { componentId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

/**
 * The action a sandbox's `agent.send(payload)` stands for: `payload.text` is what the user says,
 * `payload.action` (optional) names it, and every other field is a value.
 */
export function sandboxAction(
  payload: unknown,
  frame: { surfaceId?: string; componentId?: string; title?: string } = {},
): UiAction {
  const values: Record<string, unknown> = isRecord(payload) ? { ...payload } : { value: payload };
  const text = typeof values.text === 'string' ? values.text.trim().slice(0, 500) : undefined;
  const name =
    typeof values.action === 'string' && NAME.test(values.action) ? values.action : 'send';
  delete values.text;
  delete values.action;
  return {
    source: 'sandbox',
    name,
    context: values,
    ...(text !== undefined && text.length > 0 ? { text } : {}),
    ...(frame.surfaceId !== undefined ? { surfaceId: frame.surfaceId } : {}),
    ...(frame.componentId !== undefined ? { componentId: frame.componentId } : {}),
    ...(frame.title !== undefined ? { title: frame.title } : {}),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check an action's `context` against a schema (Zod, Valibot, ArkType — any Standard Schema — or a
 * JSON Schema). Answers the parsed context, or the issues.
 */
export async function validateUiActionContext(
  action: UiAction,
  schema: StandardSchemaV1 | JsonSchema,
): Promise<{ ok: true; context: Record<string, unknown> } | { ok: false; issues: GenuiIssue[] }> {
  const result = await validateProps(
    schema as PropsSchema,
    action.context,
    builtinJsonSchemaValidator,
  );
  if (!result.ok) return { ok: false, issues: result.issues };
  return isRecord(result.value)
    ? { ok: true, context: result.value }
    : { ok: false, issues: [{ path: [], message: 'must be an object' }] };
}

/**
 * The user message an action becomes: what the user said (or a sentence naming the action), then
 * where it came from and its values as a JSON block — the model reads both.
 */
export function uiActionText(action: UiAction): string {
  const said =
    action.text ?? `I used "${action.name}"${action.title ? ` in ${action.title}` : ''}.`;
  const origin = [
    action.source === 'sandbox' ? 'interactive view' : action.source === 'a2ui' ? 'A2UI' : 'UI',
    action.title !== undefined ? `"${action.title}"` : undefined,
    action.surfaceId !== undefined ? `surface ${action.surfaceId}` : undefined,
    action.componentId !== undefined ? `component ${action.componentId}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
  const values = Object.keys(action.context).length > 0;
  return [
    said,
    '',
    `[UI action "${action.name}" from ${origin}]${values ? '' : ' (no values)'}`,
    ...(values ? ['```json', JSON.stringify(action.context, null, 2), '```'] : []),
  ].join('\n');
}
