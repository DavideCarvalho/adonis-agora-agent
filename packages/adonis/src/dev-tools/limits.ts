/** Every dev-tool result is capped at this many bytes of text. */
export const DEV_TOOLS_MAX_BYTES = 48 * 1024;
/** Rows a list tool returns at most. */
export const DEV_TOOLS_MAX_ROWS = 100;
/** A single blob field (a run's input, a message) is cut to this many bytes. */
export const DEV_TOOLS_FIELD_BYTES = 4 * 1024;

const SENSITIVE_KEY = /(secret|token|password|authorization|cookie|api[_-]?key)/i;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const REDACTED = '[redacted]';

/**
 * The final redaction pass over everything a dev tool returns (and over the arguments the audit line
 * logs): a key that names a secret (`secret`, `token`, `password`, `authorization`, `cookie`,
 * `api_key`) loses its value. Numbers, booleans, `null` and numeric strings survive, so counts such as
 * `inputTokens` stay readable.
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
      SENSITIVE_KEY.test(key) && !harmless(child) ? REDACTED : redactDevToolOutput(child, seen);
  }
  return out;
}

function harmless(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && NUMERIC.test(value))
  );
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
 * Serialize a tool result as the text the MCP client receives, capped at `maxBytes`. Over it, a list
 * (`{ items }` or a bare array) loses rows from the end and gains `truncated: true` and `next`; any
 * other value is cut as text.
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
  if (list === null) return truncateText(text, maxBytes);

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
  return byteLength(fitted) <= maxBytes ? fitted : truncateText(fitted, maxBytes);
}
