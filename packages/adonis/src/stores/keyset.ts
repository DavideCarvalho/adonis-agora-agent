/**
 * The governance read-model's keyset cursors: the `(timestamp ms, primary key)` of the last row a
 * page returned, base64url JSON. Opaque to callers; only the stores read them back.
 *
 * Cursors handed out before keyset paging were a plain offset (`"50"`, from `listRuns`), and the
 * HTTP layer's window cursors encode `[offset]`. {@link readRunsCursor} still honours the first, so
 * a link or a half-walked "Load more" from an older server keeps working.
 */
import type { CursorPage } from '../pagination.js';

/** A position in a list ordered `(at DESC, id DESC)`. */
export interface KeysetPosition {
  /** Epoch milliseconds of the order column. */
  at: number;
  id: string;
}

export function encodeKeyset(at: number, id: string): string {
  return Buffer.from(JSON.stringify(['k', at, id]), 'utf8').toString('base64url');
}

/** The position a keyset cursor names, or `null` when `cursor` is not one this module wrote. */
export function decodeKeyset(cursor: string): KeysetPosition | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 'k' &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[1]) &&
      typeof value[2] === 'string'
    ) {
      return { at: value[1], id: value[2] };
    }
  } catch {
    // not ours
  }
  return null;
}

/**
 * A `listRuns` `after`: a keyset position, or the offset an older server handed out (`"50"`).
 * Anything else reads as the first page, as before.
 */
export function readRunsCursor(
  after: string | undefined,
): { position: KeysetPosition } | { offset: number } {
  if (after === undefined) return { offset: 0 };
  const position = decodeKeyset(after);
  if (position !== null) return { position };
  if (/^\d+$/.test(after)) return { offset: Number.parseInt(after, 10) };
  return { offset: 0 };
}

/** `(at, id) < (position)`: is `row` strictly older than `position` in `(at DESC, id DESC)`? */
export function isBefore(row: KeysetPosition, position: KeysetPosition): boolean {
  return row.at < position.at || (row.at === position.at && row.id < position.id);
}

/** `(at DESC, id DESC)` comparator. */
export function newestFirst(left: KeysetPosition, right: KeysetPosition): number {
  if (left.at !== right.at) return right.at - left.at;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * The seek predicate for `(column, "id") < (?, ?)`, spelled so every dialect (Postgres, MySQL,
 * SQLite) can still range-scan an index on `(column[, id])`.
 */
export function seekSql(
  column: string,
  position: KeysetPosition,
): { sql: string; bindings: unknown[] } {
  return {
    sql: `(${column} <= ? AND (${column} < ? OR "id" < ?))`,
    bindings: [position.at, position.at, position.id],
  };
}

/**
 * `limit + 1` rows → the page, with the next cursor at its last row. Forward-only, like every read
 * of this SPI: `prevCursor` stays `null`.
 */
export function keysetPage<T>(
  rows: Array<{ at: number; id: string; view: T }>,
  limit: number,
): CursorPage<T> {
  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => row.view),
    nextCursor: hasNext && last !== undefined ? encodeKeyset(last.at, last.id) : null,
    prevCursor: null,
    hasNext,
    hasPrev: false,
  };
}
