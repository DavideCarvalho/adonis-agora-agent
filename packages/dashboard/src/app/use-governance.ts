import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AgentClient } from '../client/agent-client.js';
import type {
  GovernanceRange,
  ListRunsFilter,
  RunSummaryRow,
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

export function useUsageTrend(range: GovernanceRange) {
  const client = useAgentClient();
  return useAsync(() => client.usageTrend(range), [client, rangeKey(range)]);
}

export function useRecentThreads(limit = 20) {
  const client = useAgentClient();
  return useAsync(() => client.recentThreads(limit), [client, limit]);
}

export function useRecentToolCalls(limit = 20) {
  const client = useAgentClient();
  return useAsync(() => client.recentToolCalls(limit), [client, limit]);
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

/** The state of a cursor-paginated, filterable run list. */
export interface RunsState {
  runs: RunSummaryRow[];
  /** Cursor for the next page; `null` when the last page has been loaded. */
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  /** Fetch and append the next page (no-op once `nextCursor` is `null`). */
  loadMore: () => void;
}

/**
 * Runs list with forward pagination: (re)loads the first page whenever the filter changes and
 * accumulates subsequent pages via {@link RunsState.loadMore}. Uses a monotonic generation token so a
 * stale in-flight page from a superseded filter is discarded (last-write-wins), mirroring
 * {@link useAsync}. The cursor is tracked in a ref so `loadMore` always fires against the freshest page.
 */
export function useRuns(filter: ListRunsFilter): RunsState {
  const client = useAgentClient();
  const key = runsFilterKey(filter);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const [runs, setRuns] = useState<RunSummaryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | null>(null);
  const genRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized filter key is the trigger.
  useEffect(() => {
    const gen = ++genRef.current;
    setRuns([]);
    setNextCursor(null);
    cursorRef.current = null;
    setLoading(true);
    setError(null);
    client
      .listRuns(filterRef.current)
      .then((page) => {
        if (genRef.current !== gen) return;
        setRuns(page.runs);
        setNextCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (genRef.current !== gen) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, key]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (cursor === null) return;
    const gen = genRef.current;
    cursorRef.current = null; // guard against double-fire while this page is in flight
    setLoading(true);
    client
      .listRuns({ ...filterRef.current, cursor })
      .then((page) => {
        if (genRef.current !== gen) return;
        setRuns((prev) => [...prev, ...page.runs]);
        setNextCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (genRef.current !== gen) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client]);

  return { runs, nextCursor, loading, error, loadMore };
}

export function useRunDetail(runId: string) {
  const client = useAgentClient();
  return useAsync(() => client.runDetail(runId), [client, runId]);
}

export function usePendingApprovals(filter: { actor?: string; limit?: number } = {}) {
  const client = useAgentClient();
  return useAsync(
    () => client.pendingApprovals(filter),
    [client, filter.actor ?? '', filter.limit ?? 0],
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
