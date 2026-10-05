import type { UIMessage } from 'ai';
import { useCallback, useRef, useState } from 'react';
import type { MessageFeedback, MessageFeedbackValue } from '../../../index.js';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { useAgentBackend } from '../provider.js';
import type { AgentMessageMetadata } from '../stored-thread-to-ui-messages.js';

export interface UseMessageFeedbackOptions {
  /** Default: the enclosing `<AgentProvider>`'s. Must implement `setMessageFeedback`. */
  backend?: AgentBackend;
  /**
   * The thread the messages belong to — `useAgentChat(...).getThreadId`, or an id. Needed to rate a
   * message streamed in this session: its id is the client's own, so the persisted row it became is
   * looked up by the run that wrote it.
   */
  threadId?: string | (() => string | undefined);
}

export interface MessageFeedbackState {
  /** The rating to show: the one set in this session, else the persisted one, else `null`. */
  feedbackOf: (message: UIMessage) => MessageFeedback | null;
  /** A rating for this message is on its way to the server. */
  isPending: (message: UIMessage) => boolean;
  /** Set `'up'`/`'down'` (optionally with a comment), or clear with `null`. Optimistic. */
  rate: (message: UIMessage, value: MessageFeedbackValue | null, comment?: string) => Promise<void>;
  /** Thumbs-button semantics: the same value again clears it, another value replaces it. */
  toggle: (message: UIMessage, value: MessageFeedbackValue) => Promise<void>;
  /** The last failure; cleared by the next successful rating. */
  error: Error | null;
}

type Local = { feedback: MessageFeedback | null };

/**
 * Thumbs-up/down (+ comment) on assistant messages, over `POST <base>/messages/:id/feedback`.
 * Headless: it holds the state and the calls, the host draws the buttons. A rating shows at once
 * and rolls back if the server refuses it.
 */
export function useMessageFeedback(options: UseMessageFeedbackOptions = {}): MessageFeedbackState {
  const backend = useAgentBackend(options.backend);
  const latest = useRef({ ...options, backend });
  latest.current = { ...options, backend };
  const [local, setLocal] = useState<ReadonlyMap<string, Local>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const localRef = useRef(local);
  localRef.current = local;
  // Live message id → the persisted row it resolved to, so a message is looked up once.
  const resolved = useRef(new Map<string, string>());

  const feedbackOf = useCallback(
    (message: UIMessage): MessageFeedback | null => {
      const mine = local.get(message.id);
      if (mine !== undefined) return mine.feedback;
      return metadataOf(message).feedback ?? null;
    },
    [local],
  );

  const isPending = useCallback((message: UIMessage) => pending.has(message.id), [pending]);

  const storedIdFor = useCallback(async (message: UIMessage): Promise<string> => {
    const runId = metadataOf(message).runId;
    if (runId === undefined) return message.id;
    const known = resolved.current.get(message.id);
    if (known !== undefined) return known;
    const { backend, threadId } = latest.current;
    const thread = typeof threadId === 'function' ? threadId() : threadId;
    if (thread === undefined) {
      throw new Error('useMessageFeedback: a streamed message needs `threadId` to be rated');
    }
    const detail = await backend.getThread(thread);
    const row = [...detail.messages]
      .reverse()
      .find((candidate) => candidate.role === 'assistant' && candidate.runId === runId);
    if (row === undefined) {
      throw new Error(`useMessageFeedback: run ${runId} has no persisted answer yet`);
    }
    resolved.current.set(message.id, row.id);
    return row.id;
  }, []);

  const rate = useCallback(
    async (message: UIMessage, value: MessageFeedbackValue | null, comment?: string) => {
      const setFeedback = requireBackendMethod(latest.current.backend, 'setMessageFeedback');
      const had = localRef.current.get(message.id);
      const optimistic: MessageFeedback | null =
        value === null
          ? null
          : {
              value,
              ...(comment !== undefined && comment.trim().length > 0
                ? { comment: comment.trim() }
                : {}),
              updatedAt: new Date().toISOString(),
            };
      setLocal((current) => new Map(current).set(message.id, { feedback: optimistic }));
      setPending((current) => new Set(current).add(message.id));
      try {
        const storedId = await storedIdFor(message);
        const { feedback } = await setFeedback(storedId, {
          value,
          ...(comment !== undefined ? { comment } : {}),
        });
        setLocal((current) => new Map(current).set(message.id, { feedback }));
        setError(null);
      } catch (caught) {
        setLocal((current) => {
          const next = new Map(current);
          if (had === undefined) next.delete(message.id);
          else next.set(message.id, had);
          return next;
        });
        const failure = caught instanceof Error ? caught : new Error(String(caught));
        setError(failure);
        throw failure;
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
      }
    },
    [storedIdFor],
  );

  const toggle = useCallback(
    (message: UIMessage, value: MessageFeedbackValue) => {
      const mine = localRef.current.get(message.id);
      const current = mine !== undefined ? mine.feedback : (metadataOf(message).feedback ?? null);
      return rate(message, current?.value === value ? null : value);
    },
    [rate],
  );

  return { feedbackOf, isPending, rate, toggle, error };
}

function metadataOf(message: UIMessage): AgentMessageMetadata {
  const metadata = message.metadata;
  return metadata !== null && typeof metadata === 'object'
    ? (metadata as AgentMessageMetadata)
    : {};
}
