import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionProposal } from '../../../index.js';
import type { AgentBackend } from '../backend.js';
import { proposalNeedsPolling, reconcileProposalMessages } from './proposals.js';

export interface ActionProposalsState {
  items: ActionProposal[];
  error: Error | null;
  refresh(): Promise<void>;
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
        latest.current.setMessages((current) =>
          reconcileProposalMessages(current, proposals, facts),
        );
      } catch (cause) {
        if (mounted.current && latest.current.threadId === threadId)
          setError(cause instanceof Error ? cause : new Error(String(cause)));
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
  }, [threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stream completion/reconnection triggers a scoped read.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    if (!items.some(proposalNeedsPolling) || pollMs <= 0) return;
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [items, pollMs, refresh]);
  useEffect(() => {
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
  }, [refresh]);
  return { items, error, refresh };
}
