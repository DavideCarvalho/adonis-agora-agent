/** Every dev-tool result is capped at this many bytes of text. */
export const DEV_TOOLS_MAX_BYTES = 48 * 1024;
/** Rows a list tool returns at most. */
export const DEV_TOOLS_MAX_ROWS = 100;
/** A single blob field (a run's input, a message) is cut to this many bytes. */
export const DEV_TOOLS_FIELD_BYTES = 4 * 1024;

const SENSITIVE_KEY = /(secret|token|password|authorization|cookie|api[_-]?key)/i;
/** Token COUNTS (`inputTokens`, `total_tokens`, `tokenCount`), not token values. */
const TOKEN_COUNT_KEY = /(tokens|token_?count)$/i;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const REDACTED = '[redacted]';

/**
 * The final redaction pass over everything a dev tool returns (and over the arguments the audit line
 * logs): a key that names a secret (`secret`, `token`, `password`, `authorization`, `cookie`,
 * `api_key`) loses its value, whatever its type. Kept: `null`, booleans (`hasPassword: true`) and
 * the numbers of token-count keys (`inputTokens`, `tokenCount`).
 */
export function redactDevToolOutput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((item) => redactDevToolOutput(item, seen));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const source =
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON(): unknown }).toJSON()
      : value;
  if (source !== value) return redactDevToolOutput(source, seen);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SENSITIVE_KEY.test(key) && !harmless(key, child)
        ? REDACTED
        : redactDevToolOutput(child, seen);
  }
  return out;
}

function harmless(key: string, value: unknown): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  const numeric = typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value));
  return numeric && TOKEN_COUNT_KEY.test(key);
}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * Cut a string to `maxBytes`, ending it with `…(truncated, N bytes)`, N being the original size.
 * Under the limit it is returned as is.
 */
export function truncateText(text: string, maxBytes = DEV_TOOLS_FIELD_BYTES): string {
  const size = byteLength(text);
  if (size <= maxBytes) return text;
  const suffix = `…(truncated, ${size} bytes)`;
  const keep = Math.max(0, maxBytes - byteLength(suffix));
  let cut = Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8');
  // A cut through a multi-byte character leaves a replacement char: drop it.
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}

/**
 * Serialize a tool result as the text the MCP client receives, capped at `maxBytes`, and always valid
 * JSON. Over the cap, a list (`{ items }` or a bare array) loses rows from the end and gains
 * `truncated: true` and `next`; any other object has its largest arrays and strings cut (strings end
 * with `…(truncated, N bytes)`) and gains `truncated: true`.
 */
export function capDevToolResult(value: unknown, maxBytes = DEV_TOOLS_MAX_BYTES): string {
  if (typeof value === 'string') return truncateText(value, maxBytes);
  const text = JSON.stringify(value ?? null);
  if (byteLength(text) <= maxBytes) return text;

  const list = Array.isArray(value)
    ? { rest: {} as Record<string, unknown>, items: value as unknown[] }
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { items?: unknown }).items)
      ? {
          rest: value as Record<string, unknown>,
          items: (value as { items: unknown[] }).items,
        }
      : null;
  if (list === null) return shrinkToFit(JSON.parse(text), maxBytes);

  const shaped = (count: number) =>
    JSON.stringify({
      ...list.rest,
      items: list.items.slice(0, count),
      truncated: true,
      next: list.rest.next ?? null,
    });
  // Largest prefix that fits (binary search on the row count).
  let low = 0;
  let high = list.items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(shaped(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const fitted = shaped(low);
  return byteLength(fitted) <= maxBytes ? fitted : shrinkToFit(JSON.parse(fitted), maxBytes);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Cut the biggest array or string of a JSON value, again and again, until it serializes under
 * `maxBytes`. An array keeps its first half, a string its first half (marked as truncated).
 */
function shrinkToFit(value: Json, maxBytes: number): string {
  let root: Json =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...value, truncated: true }
      : value;
  for (let round = 0; round < 200; round++) {
    const text = JSON.stringify(root);
    if (byteLength(text) <= maxBytes) return text;
    const target = biggestNode(root);
    if (target === null) break;
    const { parent, key, node } = target;
    const cut: Json = Array.isArray(node)
      ? node.slice(0, Math.floor(node.length / 2))
      : truncateText(node as string, Math.max(64, Math.floor(byteLength(node as string) / 2)));
    if (parent === null) root = cut;
    else (parent as Record<string | number, Json>)[key] = cut;
  }
  return JSON.stringify({ truncated: true, error: `the result is over ${maxBytes} bytes` });
}

interface NodeRef {
  parent: Json[] | { [key: string]: Json } | null;
  key: string | number;
  node: Json;
}

/** The largest array (with rows) or long string in `root`, by serialized size. */
function biggestNode(root: Json): NodeRef | null {
  let best: NodeRef | null = null;
  let bestSize = 0;
  const visit = (parent: NodeRef['parent'], key: string | number, node: Json) => {
    const shrinkable =
      (Array.isArray(node) && node.length > 0) || (typeof node === 'string' && node.length > 128);
    if (shrinkable) {
      const size = byteLength(JSON.stringify(node));
      if (size > bestSize) {
        best = { parent, key, node };
        bestSize = size;
      }
    }
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) visit(node, index, child);
    } else if (typeof node === 'object' && node !== null) {
      for (const [childKey, child] of Object.entries(node)) visit(node, childKey, child);
    }
  };
  visit(null, '', root);
  return best;
}
