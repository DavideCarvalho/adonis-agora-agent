/**
 * The HTTP list wire of the agent's routes — `@adonis-agora/filter`'s format: `filter[field]`,
 * `sort`, and cursor paging (`after`/`before` + `first`/`last`), answered as
 * `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`.
 *
 * Server-only: the providers import it, the browser entry points never do.
 */
import {
  applyCustomFilter,
  BaseFilter,
  type CursorPageResponse,
  cursorPage,
  decodeCursor,
  encodeCursor,
  InvalidColumnFilterError,
  parseCursorParams,
  resolveSort,
} from '@adonis-agora/filter';

export type { CursorPageResponse };
export { InvalidColumnFilterError };

/** Raw decoded query string, as `ctx.request.qs()` hands it over. */
export type ListQuery = Record<string, unknown>;

/** Page sizes of the routes: `first`/`last` default to `defaultSize`, capped at `maxSize`. */
export interface ListSizes {
  defaultSize: number;
  maxSize: number;
}

/** A filter with no fields: every `filter[...]` is refused (`400`). */
export class NoFieldsFilter extends BaseFilter<Record<string, never>> {}

/** Run `filter[...]` through `cls` onto `draft`; an unknown field or operator throws (→ `400`). */
export async function applyListFilter<D>(
  draft: D,
  cls: new () => BaseFilter<D>,
  qs: ListQuery,
): Promise<D> {
  await applyCustomFilter(draft, cls, { request: { qs: () => ({ ...qs }) } });
  return draft;
}

/**
 * Accept only the endpoint's one order (`'-createdAt'`, `'requestedAt'`…): no `sort` or exactly
 * that order passes, anything else throws (→ `400`).
 */
export function assertFixedSort(raw: unknown, order: string): void {
  const descending = order.startsWith('-');
  const field = descending ? order.slice(1) : order;
  const items = resolveSort(raw as string | undefined, { sortable: [field], default: order });
  const wanted = descending ? 'desc' : 'asc';
  if (items.length !== 1 || items[0]?.direction !== wanted) {
    throw new InvalidColumnFilterError(`This list is always sorted by "${order}".`);
  }
}

/** One value of a single-valued filter field (`equals` only), as a non-empty string. */
export function singleValue(field: string, value: unknown, operator: string): string {
  if (operator !== 'equals') {
    throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidColumnFilterError(`"${field}" takes one value.`);
  }
  const text = String(value);
  if (text === '') throw new InvalidColumnFilterError(`"${field}" needs a value.`);
  return text;
}

// ── Window paging: a cursor over a list the store can only cap ──────────────────────────────────
//
// The cursor names a position in the list (`encodeCursor([n])`): `after` reads the rows from it
// on, `before` the rows that end at it. The route asks the store for `offset + size + 1` rows and
// slices, so the stores keep their `limit`-only read.

/** Where one page of a windowed list starts, and how many rows it holds. */
export interface ListWindow {
  offset: number;
  size: number;
}

function windowPosition(cursor: string): number {
  const values = decodeCursor(cursor);
  const position = values?.length === 1 ? values[0] : undefined;
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
    throw new InvalidColumnFilterError('Invalid cursor.');
  }
  return position;
}

/** Read `after`/`before` + `first`/`last` for a windowed list. A bad cursor throws (→ `400`). */
export function parseListWindow(qs: ListQuery, sizes: ListSizes): ListWindow {
  const params = parseCursorParams(qs, sizes);
  if (params.after !== undefined)
    return { offset: windowPosition(params.after), size: params.size };
  if (params.before !== undefined) {
    const end = windowPosition(params.before);
    const offset = Math.max(0, end - params.size);
    return { offset, size: end - offset };
  }
  return { offset: 0, size: params.size };
}

/** How many rows to ask the store for: the page plus one, to know whether another follows. */
export function windowFetchSize(window: ListWindow): number {
  return window.offset + window.size + 1;
}

/** Slice the page out of the rows the store returned and wrap it with its cursors. */
export function windowPage<T>(rows: readonly T[], window: ListWindow): CursorPageResponse<T> {
  const end = window.offset + window.size;
  const hasNext = rows.length > end;
  const hasPrev = window.offset > 0;
  return cursorPage(rows.slice(window.offset, end), {
    nextCursor: hasNext ? encodeCursor([end]) : null,
    prevCursor: hasPrev ? encodeCursor([window.offset]) : null,
    hasNext,
    hasPrev,
  });
}

/**
 * Read `after` + `first` for a list that only pages forward (the store hands out its own opaque
 * `after` cursor). `before`/`last` throw (→ `400`).
 */
export function parseForwardParams(
  qs: ListQuery,
  sizes: ListSizes,
): { after?: string; size: number } {
  const params = parseCursorParams(qs, sizes);
  if (params.before !== undefined || (qs.last !== undefined && qs.first === undefined)) {
    throw new InvalidColumnFilterError('This list pages forward only: use after and first.');
  }
  return { ...(params.after !== undefined ? { after: params.after } : {}), size: params.size };
}

export { cursorPage, decodeCursor, encodeCursor };

// ── The governance lists' filters ───────────────────────────────────────────────────────────────

const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
type RunStatusValue = (typeof RUN_STATUSES)[number];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What `GET /agent/governance/runs` narrows by. */
export interface RunsDraft {
  actor?: string;
  agent?: string;
  status?: RunStatusValue;
  from?: string;
  to?: string;
}

function day(field: string, value: unknown): string {
  if (typeof value !== 'string' || !DAY.test(value)) {
    throw new InvalidColumnFilterError(`"${field}" takes UTC days (YYYY-MM-DD).`);
  }
  return value;
}

/**
 * `filter[actor]`, `filter[agent]`, `filter[status]` (one value each) and `filter[startedAt]`
 * (`gte`, `lte`, `between` or `equals`, in UTC days) over the runs read-model.
 */
export class RunsFilter extends BaseFilter<RunsDraft> {
  declare $query: RunsDraft;

  actor(value: unknown, operator: string): void {
    this.$query.actor = singleValue('actor', value, operator);
  }

  agent(value: unknown, operator: string): void {
    this.$query.agent = singleValue('agent', value, operator);
  }

  status(value: unknown, operator: string): void {
    const status = singleValue('status', value, operator);
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      throw new InvalidColumnFilterError(
        `"status" is one of ${RUN_STATUSES.join(', ')}; got "${status}".`,
      );
    }
    this.$query.status = status as RunStatusValue;
  }

  startedAt(value: unknown, operator: string): void {
    if (operator === 'gte') this.$query.from = day('startedAt', value);
    else if (operator === 'lte') this.$query.to = day('startedAt', value);
    else if (operator === 'equals') {
      this.$query.from = day('startedAt', value);
      this.$query.to = this.$query.from;
    } else if (operator === 'between') {
      const bounds = Array.isArray(value) ? value : String(value).split(',');
      if (bounds.length !== 2) {
        throw new InvalidColumnFilterError('"startedAt" between takes two UTC days.');
      }
      this.$query.from = day('startedAt', bounds[0]);
      this.$query.to = day('startedAt', bounds[1]);
    } else {
      throw new InvalidColumnFilterError(
        `"startedAt" does not support the "${operator}" operator.`,
      );
    }
  }
}

/** What `GET /agent/governance/approvals/pending` narrows by. */
export interface ApprovalsDraft {
  actor?: string;
}

/** `filter[actor]` (one value) over the cross-actor approvals inbox. */
export class ApprovalsFilter extends BaseFilter<ApprovalsDraft> {
  declare $query: ApprovalsDraft;

  actor(value: unknown, operator: string): void {
    this.$query.actor = singleValue('actor', value, operator);
  }
}
