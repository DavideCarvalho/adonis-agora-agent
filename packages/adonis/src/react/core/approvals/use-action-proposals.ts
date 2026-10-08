import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionProposal } from '../../../index.js';
import type { AgentBackend } from '../backend.js';
import { proposalNeedsPolling, reconcileProposalMessages } from './proposals.js';

export interface ActionProposalsState {
  items: ActionProposal[];
  error: Error | null;
  /**
   * The server does not serve proposals: its `action-proposals` route answered `404`, `405` or
   * `501`. Nothing is read again for the rest of the session — no polling, no refetch on focus.
   */
  unsupported: boolean;
  refresh(): Promise<void>;
}

/** Statuses meaning the server has no proposals route, rather than that this read failed. */
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);
/** What the libraries' own route answers for a thread it does not know (yet): not "unsupported". */
const UNKNOWN_THREAD = new Set(['Thread not found', 'Unknown thread']);
/** The longest wait between two reads after failed ones (the wait doubles per failure). */
const MAX_BACKOFF_MS = 30_000;

/** Backends whose server answered that it serves no proposals — for the rest of the session. */
const unsupportedBackends = new WeakSet<object>();

function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** `cause` says the proposals route is not there at all (not a transient failure of one read). */
export function isProposalsUnsupported(cause: unknown): boolean {
  const status = statusOf(cause);
  if (status === undefined || !UNSUPPORTED_STATUSES.has(status)) return false;
  return !(status === 404 && cause instanceof Error && UNKNOWN_THREAD.has(cause.message));
}

export function useActionProposals(
  backend: AgentBackend,
  threadId: string | undefined,
  setMessages: (update: (current: UIMessage[]) => UIMessage[]) => void,
  refreshKey: string,
  pollMs = 1000,
): ActionProposalsState {
  const [items, setItems] = useState<ActionProposal[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [unsupported, setUnsupported] = useState(() => unsupportedBackends.has(backend));
  // Reads that failed in a row: each one doubles the wait before the next poll.
  const [failures, setFailures] = useState(0);
  const latest = useRef({ threadId, setMessages });
  latest.current = { threadId, setMessages };
  const mounted = useRef(true);
  const requests = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (threadId === undefined || backend.listActionProposals === undefined) return;
    if (unsupportedBackends.has(backend)) return;
    const pending = requests.current.get(threadId);
    if (pending) return pending;
    const request = (async () => {
      try {
        const proposals = await backend.listActionProposals?.({ threadId });
        if (!mounted.current || latest.current.threadId !== threadId || !Array.isArray(proposals))
          return;
        const admitted = proposals.some(
          (proposal) => proposal.outcomeDelivery?.status === 'admitted',
        );
        const facts = admitted
          ? (await backend.getThread(threadId)).messages.filter(
              (message) => message.actionProposalOutcome !== undefined,
            )
          : [];
        if (!mounted.current || latest.current.threadId !== threadId) return;
        setItems(proposals);
        setError(null);
        setFailures(0);
        latest.current.setMessages((current) =>
          reconcileProposalMessages(current, proposals, facts),
        );
      } catch (cause) {
        if (isProposalsUnsupported(cause)) {
          // Not this read failing: the server has no such route. Stop asking, quietly.
          unsupportedBackends.add(backend);
          if (mounted.current) {
            setUnsupported(true);
            setError(null);
          }
          return;
        }
        if (mounted.current && latest.current.threadId === threadId) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setFailures((count) => count + 1);
        }
      }
    })();
    requests.current.set(threadId, request);
    try {
      await request;
    } finally {
      requests.current.delete(threadId);
    }
  }, [backend, threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed thread clears the prior scoped state.
  useEffect(() => {
    setItems([]);
    setError(null);
    setFailures(0);
  }, [threadId]);
  // A backend another chat already found unsupported (or a new backend that may not be).
  useEffect(() => {
    setUnsupported(unsupportedBackends.has(backend));
  }, [backend]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stream completion/reconnection triggers a scoped read.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  // One read per wait while a proposal is still moving; every read (its new `items`, or one more
  // failure) schedules the next. Failed reads back off: pollMs, ×2, ×4, … up to 30 s.
  useEffect(() => {
    if (unsupported || !items.some(proposalNeedsPolling) || pollMs <= 0) return;
    const wait = failures === 0 ? pollMs : Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS);
    const timer = setTimeout(() => {
      void refresh();
    }, wait);
    return () => clearTimeout(timer);
  }, [items, failures, unsupported, pollMs, refresh]);
  useEffect(() => {
    if (unsupported) return;
    const refetch = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    window.addEventListener('focus', refetch);
    window.addEventListener('online', refetch);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', refetch);
      window.removeEventListener('online', refetch);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, unsupported]);
  return { items, error, unsupported, refresh };
}
