import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AgentClient } from '../client/agent-client.js';
import type {
  CursorPageResponse,
  GovernanceRange,
  ListRunsFilter,
  RunSummaryRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  ToolStatsRange,
} from '../client/types.js';

/**
 * The {@link AgentClient} the hooks call, provided at the app root. A default instance (deriving its
 * API base from the page) is used when no provider wraps the tree — tests inject a fake via the
 * exported context.
 */
export const AgentClientContext = createContext<AgentClient | null>(null);

export function useAgentClient(): AgentClient {
  const injected = useContext(AgentClientContext);
  // Lazily build one default client per hook-tree when nothing is injected.
  const fallback = useRef<AgentClient | null>(null);
  if (injected) return injected;
  if (fallback.current === null) fallback.current = new AgentClient();
  return fallback.current;
}

/** The lifecycle of one async read. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Re-run the fetch (e.g. a manual refresh). */
  reload: () => void;
}

/**
 * A tiny dependency-free `useQuery`: runs `run` on mount and whenever `deps` change, tracks
 * loading/error, and ignores a resolved response from a superseded call (last-write-wins) so a fast
 * range change never flashes stale data. No caching — the console is a live read surface.
 */
export function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the intentional trigger set.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    runRef
      .current()
      .then((value) => {
        if (live) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}

const rangeKey = (range: GovernanceRange) => `${range.fromDay}:${range.toDay}`;

export function useSpendByModel(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.spendByModel(range), [client, rangeKey(range)]);
}

export function useSpendByActor(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.spendByActor(range), [client, rangeKey(range)]);
}

export function useSpendByFeature(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.spendByFeature(range), [client, rangeKey(range)]);
}

export function useUsageTrend(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.usageTrend(range), [client, rangeKey(range)]);
}

/** Newest-first recent threads, one page at a time ({@link CursorListState.loadMore}). */
export function useRecentThreads(pageSize = 25): CursorListState<ThreadActivityRow> {
  const client = useAgentClient();
  return useCursorList(
    (after) => client.recentThreads({ first: pageSize, ...(after ? { after } : {}) }),
    [client, pageSize],
  );
}

/** Newest-first recent tool calls, one page at a time ({@link CursorListState.loadMore}). */
export function useRecentToolCalls(pageSize = 25): CursorListState<ToolCallActivityRow> {
  const client = useAgentClient();
  return useCursorList(
    (after) => client.recentToolCalls({ first: pageSize, ...(after ? { after } : {}) }),
    [client, pageSize],
  );
}

export function useQuotaToday() {
  const client = useAgentClient();
  return useAsync(() => client.quotaToday(), [client]);
}

/** Serialize a runs filter (minus its cursor) into a stable dep key. */
function runsFilterKey(filter: ListRunsFilter): string {
  return [
    filter.actor ?? '',
    filter.agent ?? '',
    filter.status ?? '',
    filter.from ?? '',
    filter.to ?? '',
  ].join('|');
}

/** A cursor-paged list read page by page: the rows loaded so far and how to load more. */
export interface CursorListState<T> {
  /** Every row loaded so far, `null` until the first page arrives. */
  data: T[] | null;
  /** Cursor for the next page; `null` when the last page has been loaded. */
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  /** Fetch and append the next page (no-op once `nextCursor` is `null`). */
  loadMore: () => void;
}

/**
 * A cursor-paged list: (re)loads the first page whenever `deps` change and appends the next ones
 * via {@link CursorListState.loadMore}. A monotonic generation token drops a page from a superseded
 * request (last-write-wins), and the cursor lives in a ref so `loadMore` always continues from the
 * freshest page.
 */
export function useCursorList<T>(
  fetchPage: (after: string | undefined) => Promise<CursorPageResponse<T>>,
  deps: readonly unknown[],
): CursorListState<T> {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const [data, setData] = useState<T[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | null>(null);
  const genRef = useRef(0);

  const load = useCallback((after: string | undefined, gen: number) => {
    setLoading(true);
    fetchRef
      .current(after)
      .then((page) => {
        if (genRef.current !== gen) return;
        setData((prev) =>
          after === undefined || prev === null ? page.data : [...prev, ...page.data],
        );
        setNextCursor(page.meta.nextCursor);
        cursorRef.current = page.meta.nextCursor;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (genRef.current !== gen) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const gen = ++genRef.current;
    setData(null);
    setNextCursor(null);
    cursorRef.current = null;
    setError(null);
    load(undefined, gen);
  }, [...deps, load]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (cursor === null) return;
    cursorRef.current = null; // guard against double-fire while this page is in flight
    load(cursor, genRef.current);
  }, [load]);

  return { data, nextCursor, loading, error, loadMore };
}

/**
 * Runs list with forward pagination: (re)loads the first page whenever the filter changes and
 * appends the next ones via {@link CursorListState.loadMore}.
 */
export function useRuns(filter: ListRunsFilter): CursorListState<RunSummaryRow> {
  const client = useAgentClient();
  return useCursorList(
    (after) => client.listRuns({ ...filter, ...(after ? { after } : {}) }),
    [client, runsFilterKey(filter)],
  );
}

export function useRunDetail(runId: string) {
  const client = useAgentClient();
  return useAsync(() => client.runDetail(runId), [client, runId]);
}

/** The first page of the approvals inbox (oldest first), as rows. */
export function usePendingApprovals(filter: { actor?: string; first?: number } = {}) {
  const client = useAgentClient();
  return useAsync(
    async () => (await client.pendingApprovals(filter)).data,
    [client, filter.actor ?? '', filter.first ?? 0],
  );
}

export function useToolStats(range: ToolStatsRange = {}) {
  const client = useAgentClient();
  return useAsync(() => client.perToolStats(range), [client, range.from ?? '', range.to ?? '']);
}

export function useReliability(range: ToolStatsRange = {}) {
  const client = useAgentClient();
  return useAsync(() => client.runReliability(range), [client, range.from ?? '', range.to ?? '']);
}

export function useThreadDetail(threadId: string) {
  const client = useAgentClient();
  return useAsync(() => client.threadDetail(threadId), [client, threadId]);
}

export function usePricing() {
  const client = useAgentClient();
  return useAsync(() => client.pricing(), [client]);
}

/** Generative-UI telemetry over the range; errors with a `501` when the store does not record it. */
export function useGenuiStats(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.genuiStats(range), [client, rangeKey(range)]);
}
