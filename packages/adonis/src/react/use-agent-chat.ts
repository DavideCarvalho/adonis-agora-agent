import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AgentChatClientOptions,
  AgentChatDisconnectedError,
  type AgentChatRequestBody,
  type ChatPart,
  createAgentChatClient,
} from '../client/index.js';

/** A message in the chat transcript — the user's text, or the assistant's streamed parts. */
export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  /** `true` while this assistant message is still receiving stream frames. */
  streaming?: boolean;
}

export type AgentChatStatus = 'idle' | 'streaming' | 'error';

export interface UseAgentChatOptions extends AgentChatClientOptions {
  /**
   * Builds the request body for a typed message. Defaults to `{ message }`. Override to attach
   * `pageContext`, `agent`, `persona`, etc. The `threadId` is injected by the hook after the first
   * turn, so a custom `buildBody` should NOT set it.
   */
  buildBody?: (message: string) => AgentChatRequestBody;
}

export interface UseAgentChatResult {
  messages: AgentChatMessage[];
  status: AgentChatStatus;
  error: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => void;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * React binding over {@link createAgentChatClient}: owns the transcript, thread id, and streaming
 * status, and drives one `AbortController` per turn. Reconnection (re-attach on a dropped stream) is
 * handled by the client — the hook just renders whatever parts it reports. Pass client options
 * (`basePath`, `fetch`, `getHeaders`, `resume`) straight through.
 */
export function useAgentChat(options: UseAgentChatOptions = {}): UseAgentChatResult {
  const { buildBody, ...clientOptions } = options;
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [status, setStatus] = useState<AgentChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const threadIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  // Keep one client instance stable across renders; the latest options ride on a ref so option
  // changes take effect on the next send without re-creating the client.
  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;
  const buildBodyRef = useRef(buildBody);
  buildBodyRef.current = buildBody;
  const clientRef = useRef(
    createAgentChatClient({
      ...clientOptions,
      getHeaders: () => optionsRef.current.getHeaders?.() ?? {},
    }),
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streamingIdRef.current) {
      return;
    }
    setError(null);

    const userMessage: AgentChatMessage = {
      id: randomId(),
      role: 'user',
      parts: [{ type: 'text', text: trimmed }],
    };
    const assistantId = randomId();
    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', parts: [], streaming: true },
    ]);
    setStatus('streaming');

    const controller = new AbortController();
    abortRef.current = controller;
    streamingIdRef.current = assistantId;

    const applyParts = (parts: ChatPart[]) =>
      setMessages((prev) =>
        prev.map((message) => (message.id === assistantId ? { ...message, parts } : message)),
      );
    const stopStreaming = () =>
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, streaming: false } : message,
        ),
      );

    const body: AgentChatRequestBody = {
      ...(buildBodyRef.current?.(trimmed) ?? { message: trimmed }),
      ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
    };

    try {
      const result = await clientRef.current.send({
        body,
        signal: controller.signal,
        onParts: applyParts,
        onThreadId: (id) => {
          threadIdRef.current = id;
        },
      });
      if (result.queued !== undefined) {
        // Another turn holds the thread (another tab, another device): the server queued the
        // message. If it started at once, follow its run; otherwise there is no answer to show yet
        // — it arrives when the turn ahead settles (a reload of the thread shows it).
        if (result.queued.runId !== undefined) {
          await clientRef.current.resume(result.queued.runId, {
            signal: controller.signal,
            onParts: applyParts,
          });
        } else {
          setMessages((prev) => prev.filter((message) => message.id !== assistantId));
        }
      }
      stopStreaming();
      setStatus('idle');
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      // Keep whatever streamed before the drop so the user doesn't lose a long answer.
      if (caught instanceof AgentChatDisconnectedError && caught.parts.length > 0) {
        applyParts(caught.parts);
      }
      stopStreaming();
      setError(caught instanceof Error ? caught.message : 'Failed to reach the agent.');
      setStatus('error');
    } finally {
      abortRef.current = null;
      streamingIdRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const streamingId = streamingIdRef.current;
    if (streamingId) {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === streamingId ? { ...message, streaming: false } : message,
        ),
      );
      streamingIdRef.current = null;
    }
    setStatus('idle');
  }, []);

  return { messages, status, error, send, cancel };
}
