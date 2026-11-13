/**
 * The ecosystem's cursor-pagination vocabulary.
 *
 * These types **intentionally mirror `@adonis-agora/filter`'s `CursorParams` / `CursorPage<T>` /
 * `CursorPageResponse<T>`
 * STRUCTURALLY** — same property names, same meanings — so every `@adonis-agora/*` package speaks the
 * one pagination interface and a consumer can move a page between them without a translation layer.
 * The mirroring is deliberate and must be kept in sync by hand: the browser entry points (`./react`,
 * `./client`) import these types and must not pull the server-side filter lib in. If
 * `@adonis-agora/filter` changes the shape, change it here too.
 *
 * `CursorParams` / `CursorPage` are the store SPI's (rows under `items`); `CursorPageResponse` is
 * what the HTTP lists answer (rows under `data`). The SPI's one intentional difference is that its
 * paginated reads are **forward-only**, so {@link CursorParams} omits `before`/`last` — see its
 * docblock.
 */

/**
 * Cursor pagination parameters, as a caller supplies them.
 *
 * - `after` — return the page immediately following this opaque cursor.
 * - `first` — page size.
 *
 * **Forward-only.** `@adonis-agora/filter`'s `CursorParams` also carries `before`/`last` for backward
 * paging, because it builds keyset predicates over SQL it controls and can therefore run the keyset
 * comparison in reverse. Neither backend behind this package's paginated surfaces can:
 *
 * - Qdrant's scroll returns an opaque `next_page_offset` (the id to resume *after*) and offers no
 *   "previous page" token at all — there is nothing to send.
 * - The governance run read-model paginates the runs table with an opaque forward cursor of the same
 *   shape, and its consumers (a "load more" table) only ever page forward.
 *
 * So `before`/`last` are omitted rather than declared-and-ignored: a parameter that type-checks and
 * then silently does nothing is worse than one that does not exist.
 */
export interface CursorParams {
  /** Opaque cursor from a prior page's {@link CursorPage.nextCursor}; omit for the first page. */
  after?: string;
  /** Page size. Each surface documents its own default and ceiling. */
  first?: number;
}

/**
 * One page of cursor-paginated results.
 *
 * - `items` — the rows for this page, in the surface's documented order.
 * - `nextCursor` — opaque cursor to pass back as {@link CursorParams.after} for the next page, or
 *   `null` when this was the last page.
 * - `prevCursor` / `hasPrev` — **always `null` / `false` here.** Every backend in this package is
 *   forward-only (see {@link CursorParams}), so there is no backward cursor to hand out. The fields
 *   are still present because the point of this type is that it is the SAME shape as
 *   `@adonis-agora/filter`'s `CursorPage`: a consumer written against one renders the other without a
 *   conditional, and a surface that later gains backward paging fills them in without a breaking
 *   change. They are constants, not a bug.
 * - `hasNext` — mirrors `nextCursor !== null`.
 *
 * Cursor values are **opaque**: they encode whatever the backend needs to resume (for Qdrant, its own
 * `next_page_offset`), and callers must treat them as bytes to hand back, never parse.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** The `meta` of a cursor-paged HTTP list. A cursor is `null` when there is no page that way. */
export interface CursorPageMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * What the agent's cursor-paged HTTP lists answer (`GET /agent/threads`, `/agent/attachments`,
 * `/agent/approvals/mine`, `/agent/governance/runs`…): `{ data, meta }`, the same shape as
 * `@adonis-agora/filter`'s `CursorPageResponse`. Pass `meta.nextCursor` back as `after` (and
 * `meta.prevCursor` as `before`, where the list pages backward).
 */
export interface CursorPageResponse<T> {
  data: T[];
  meta: CursorPageMeta;
}

/** The paging half of a cursor-paged HTTP list request. */
export interface ListPageParams {
  /** Read the page after this cursor (`meta.nextCursor` of the previous page). */
  after?: string;
  /** Page size. */
  first?: number;
}
