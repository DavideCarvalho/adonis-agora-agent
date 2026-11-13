import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadSummary } from '../../../index.js';
import type { AgentBackend } from '../backend.js';
import { useAgentBackend } from '../provider.js';
import { notifyThreads, onThreadsEvent } from './threads-events.js';

export interface UseThreadsOptions {
  /**
   * The backend to list. Default: the enclosing `<AgentProvider>`'s. Must be STABLE across renders:
   * the list refreshes itself when a chat on the SAME backend creates a thread, settles a run or
   * streams a title.
   */
  backend?: AgentBackend;
  /** `false` holds the first request (e.g. until the user is signed in). Default `true`. */
  enabled?: boolean;
  /** Threads per page (`first`). Default 50; the server caps it at 200. */
  pageSize?: number;
}

/** The most a refresh re-reads at once: the server's page cap. */
const MAX_PAGE = 200;

export interface ThreadsState {
  /** Newest first, as the server orders them. `[]` until loaded. */
  threads: ThreadSummary[];
  isLoading: boolean;
  error: Error | null;
  /** More threads wait on the server: {@link ThreadsState.loadMore} reads the next page. */
  hasMore: boolean;
  /** Append the next page. A no-op when {@link ThreadsState.hasMore} is `false`. */
  loadMore: () => Promise<void>;
  /** Ask the server again, for as many threads as are loaded (at least one page). */
  refresh: () => Promise<void>;
  /** Rename on the server; the list shows the new title at once and rolls back on failure. */
  rename: (id: string, title: string) => Promise<void>;
  /** Delete on the server; the thread leaves the list at once and comes back on failure. */
  remove: (id: string) => Promise<void>;
}

/**
 * The actor's conversations, kept current without the host wiring refetches: a chat on the same
 * backend reports thread creation and settled runs (refetch) and streamed titles (patched in
 * place). Headless — it renders nothing.
 */
export function useThreads(options: UseThreadsOptions = {}): ThreadsState {
  const { enabled = true, pageSize = 50 } = options;
  const backend = useAgentBackend(options.backend);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // Only the newest request may write: a slow response must not overwrite a newer one.
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    setIsLoading(true);
    try {
      const first = Math.min(MAX_PAGE, Math.max(pageSize, threadsRef.current.length));
      const page = await backend.listThreads({ first });
      if (mine !== generation.current) return;
      setThreads(page.data);
      setNextCursor(page.meta.nextCursor);
      setError(null);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine === generation.current) setIsLoading(false);
    }
  }, [backend, pageSize]);

  const loadMore = useCallback(async (): Promise<void> => {
    const after = nextCursorRef.current;
    if (after === null) return;
    const mine = ++generation.current;
    setIsLoading(true);
    try {
      const page = await backend.listThreads({ after, first: pageSize });
      if (mine !== generation.current) return;
      setThreads((current) => {
        const known = new Set(current.map((thread) => thread.id));
        return [...current, ...page.data.filter((thread) => !known.has(thread.id))];
      });
      setNextCursor(page.meta.nextCursor);
      setError(null);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mine === generation.current) setIsLoading(false);
    }
  }, [backend, pageSize]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return onThreadsEvent(backend, (event) => {
      if (event.type === 'title') {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === event.threadId ? { ...thread, title: event.title } : thread,
          ),
        );
      } else if (event.type === 'removed') {
        setThreads((current) => current.filter((thread) => thread.id !== event.threadId));
      } else {
        void refresh();
      }
    });
  }, [backend, enabled, refresh]);

  const rename = useCallback(
    async (id: string, title: string): Promise<void> => {
      const before = threadsRef.current;
      setThreads((current) =>
        current.map((thread) => (thread.id === id ? { ...thread, title } : thread)),
      );
      try {
        await backend.updateThread(id, { title });
        notifyThreads(backend, { type: 'title', threadId: id, title });
      } catch (caught) {
        setThreads(before);
        throw caught;
      }
    },
    [backend],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const before = threadsRef.current;
      setThreads((current) => current.filter((thread) => thread.id !== id));
      try {
        await backend.deleteThread(id);
        notifyThreads(backend, { type: 'removed', threadId: id });
      } catch (caught) {
        setThreads(before);
        throw caught;
      }
    },
    [backend],
  );

  return {
    threads,
    isLoading,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    refresh,
    rename,
    remove,
  };
}
