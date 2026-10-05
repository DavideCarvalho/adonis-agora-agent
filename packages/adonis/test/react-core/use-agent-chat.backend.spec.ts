// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StoredMessage, ThreadDetail, ThreadSummary } from '../../src/index.js';
import type {
  AgentBackend,
  ChatStreamResponse,
  ResumeStreamRequest,
} from '../../src/react/core/backend.js';
import { useMessageFeedback } from '../../src/react/core/feedback/use-message-feedback.js';
import { AgentProvider } from '../../src/react/core/provider.js';
import { storedThreadToUiMessages } from '../../src/react/core/stored-thread-to-ui-messages.js';
import { useThreads } from '../../src/react/core/threads/use-threads.js';
import { useAgentChat } from '../../src/react/core/use-agent-chat.js';

const encoder = new TextEncoder();

/** Frames one per read; `hold` parks the stream (then drops it) until the returned `release`. */
function stream(frames: string[], end: 'close' | { dropAfter: Promise<void> } = 'close') {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const frame = frames[index];
      index += 1;
      if (frame !== undefined) {
        controller.enqueue(encoder.encode(frame));
      } else if (end === 'close') {
        controller.close();
      } else {
        await end.dropAfter;
        controller.error(new TypeError('network error'));
      }
    },
  });
}

const META = 'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n';
const frame = (id: number, event: object) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
const DONE = 'event: done\ndata: {}\n\n';

function summary(id: string, title: string): ThreadSummary {
  return { id, title, persona: null, transient: false, createdAt: 'x', updatedAt: 'x' };
}

interface FakeBackend extends AgentBackend {
  resumed: ResumeStreamRequest[];
  threads: ThreadSummary[];
  messages: StoredMessage[];
  feedbackCalls: Array<{ id: string; value: unknown }>;
}

function fakeBackend(
  open: () => ReadableStream<Uint8Array>,
  resume: () => Promise<ReadableStream<Uint8Array> | null> = async () => null,
): FakeBackend {
  const backend: FakeBackend = {
    resumed: [],
    threads: [summary('thr-1', 'Untitled')],
    messages: [],
    feedbackCalls: [],
    async openChatStream(): Promise<ChatStreamResponse> {
      return { body: open(), runId: 'run-1', threadId: 'thr-1' };
    },
    async resumeChatStream(request) {
      backend.resumed.push(request);
      const next = await resume();
      return next === null ? null : { body: next };
    },
    cancelStream: async () => ({ aborted: true }),
    listThreads: vi.fn(async () => backend.threads.map((thread) => ({ ...thread }))),
    async getThread(id): Promise<ThreadDetail> {
      return { ...summary(id, 'T'), messages: backend.messages };
    },
    updateThread: vi.fn(async () => ({ ok: true })),
    deleteThread: vi.fn(async () => undefined),
    async setMessageFeedback(id, input) {
      backend.feedbackCalls.push({ id, value: input.value });
      return {
        feedback:
          input.value === null ? null : { value: input.value, updatedAt: '2026-01-01T00:00:00Z' },
      };
    },
  };
  return backend;
}

async function drain(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('useAgentChat({ backend })', () => {
  it('streams a turn through the backend and exposes it as `backend`', async () => {
    const backend = fakeBackend(() =>
      stream([META, frame(1, { kind: 'text', text: 'hi there' }), DONE]),
    );
    const { result } = renderHook(() => useAgentChat({ backend }));

    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await drain();

    expect(result.current.backend).toBe(backend);
    const answer = result.current.messages.at(-1);
    expect(answer?.parts).toContainEqual(expect.objectContaining({ text: 'hi there' }));
    // The run rides the live message, so it can be rated before any reload.
    expect(answer?.metadata).toMatchObject({ runId: 'run-1' });
  });

  it('reads `reconnecting` while a dropped stream is retried, then settles', async () => {
    let drop!: () => void;
    const dropped = new Promise<void>((resolve) => {
      drop = resolve;
    });
    let resumeNow!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      resumeNow = resolve;
    });
    const backend = fakeBackend(
      () => stream([META, frame(1, { kind: 'text', text: 'Hel' })], { dropAfter: dropped }),
      async () => {
        await resumeGate;
        return stream([frame(2, { kind: 'text', text: 'lo' }), DONE]);
      },
    );
    const { result } = renderHook(() => useAgentChat({ backend, reconnect: { baseDelayMs: 0 } }));

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage({ text: 'hello' });
    });
    await drain();
    act(() => drop());
    await waitFor(() => expect(result.current.status).toBe('reconnecting'));
    expect(result.current.connection).toMatchObject({ status: 'reconnecting', after: 1 });

    await act(async () => {
      resumeNow();
      await sending;
    });
    await drain();

    expect(backend.resumed).toEqual([expect.objectContaining({ runId: 'run-1', after: 1 })]);
    expect(result.current.status).toBe('ready');
    const text = result.current.messages
      .at(-1)
      ?.parts.map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    expect(text).toBe('Hello');
  });
});

describe('useAgentChat after a run ended while the stream was away', () => {
  it('reloads the thread instead of leaving the partial answer', async () => {
    let drop!: () => void;
    const dropped = new Promise<void>((resolve) => {
      drop = resolve;
    });
    const backend = fakeBackend(
      () => stream([META, frame(1, { kind: 'text', text: 'Hal' })], { dropAfter: dropped }),
      async () => null,
    );
    backend.messages = [
      { id: 'u1', role: 'user', content: 'hello', createdAt: 'x' },
      { id: 'a1', role: 'assistant', content: 'Hallo, complete.', createdAt: 'x', runId: 'run-1' },
    ];
    const { result } = renderHook(() => useAgentChat({ backend, reconnect: { baseDelayMs: 0 } }));

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage({ text: 'hello' });
    });
    await drain();
    await act(async () => {
      drop();
      await sending;
    });
    await drain();

    expect(result.current.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(result.current.messages[1]?.parts).toContainEqual({
      type: 'text',
      text: 'Hallo, complete.',
    });
  });
});

describe('useThreads', () => {
  it('lists, renames and removes optimistically, and refetches when a chat settles a run', async () => {
    const backend = fakeBackend(() =>
      stream([META, frame(1, { kind: 'title', title: 'Refunds' }), DONE]),
    );
    const { result } = renderHook(() => ({
      threads: useThreads({ backend }),
      chat: useAgentChat({ backend }),
    }));
    await waitFor(() => expect(result.current.threads.threads).toHaveLength(1));

    // The streamed title lands in place; the settled run refetches the list.
    backend.threads = [summary('thr-1', 'Refunds'), summary('thr-2', 'Other')];
    await act(async () => {
      await result.current.chat.sendMessage({ text: 'hello' });
    });
    await drain();
    expect(result.current.threads.threads.map((thread) => thread.title)).toEqual([
      'Refunds',
      'Other',
    ]);

    await act(async () => {
      await result.current.threads.rename('thr-2', 'Renamed');
    });
    expect(backend.updateThread).toHaveBeenCalledWith('thr-2', { title: 'Renamed' });
    expect(result.current.threads.threads[1]?.title).toBe('Renamed');

    await act(async () => {
      await result.current.threads.remove('thr-1');
    });
    expect(backend.deleteThread).toHaveBeenCalledWith('thr-1');
    expect(result.current.threads.threads.map((thread) => thread.id)).toEqual(['thr-2']);
  });

  it('rolls a rename back when the server refuses it', async () => {
    const backend = fakeBackend(() => stream([DONE]));
    backend.updateThread = vi.fn(async () => {
      throw new Error('nope');
    });
    const { result } = renderHook(() => useThreads({ backend }));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    await act(async () => {
      await expect(result.current.rename('thr-1', 'New')).rejects.toThrow('nope');
    });
    expect(result.current.threads[0]?.title).toBe('Untitled');
  });
});

describe('useMessageFeedback', () => {
  const stored: StoredMessage = {
    id: 'msg-9',
    role: 'assistant',
    content: 'answer',
    createdAt: 'x',
    runId: 'run-1',
    feedback: { value: 'down', updatedAt: 'x' },
  };

  it('reads a replayed rating and toggles it off through the stored id', async () => {
    const backend = fakeBackend(() => stream([DONE]));
    const [replayed] = storedThreadToUiMessages([stored]) as [UIMessage];
    const { result } = renderHook(() => useMessageFeedback({ backend }));

    expect(result.current.feedbackOf(replayed)?.value).toBe('down');
    await act(async () => {
      await result.current.toggle(replayed, 'down');
    });

    expect(backend.feedbackCalls).toEqual([{ id: 'msg-9', value: null }]);
    expect(result.current.feedbackOf(replayed)).toBeNull();
  });

  it('rates a live message through the row its run persisted', async () => {
    const backend = fakeBackend(() => stream([DONE]));
    const { feedback: _rated, ...unrated } = stored;
    backend.messages = [unrated];
    const live: UIMessage = {
      id: 'client-generated',
      role: 'assistant',
      parts: [],
      metadata: { runId: 'run-1' },
    };
    const { result } = renderHook(() => useMessageFeedback({ backend, threadId: () => 'thr-1' }));

    await act(async () => {
      await result.current.rate(live, 'up');
    });

    expect(backend.feedbackCalls).toEqual([{ id: 'msg-9', value: 'up' }]);
    expect(result.current.feedbackOf(live)?.value).toBe('up');
  });

  it('rolls back and reports when the server refuses', async () => {
    const backend = fakeBackend(() => stream([DONE]));
    backend.setMessageFeedback = async () => {
      throw new Error('403');
    };
    const [replayed] = storedThreadToUiMessages([stored]) as [UIMessage];
    const { result } = renderHook(() => useMessageFeedback({ backend }));

    await act(async () => {
      await expect(result.current.rate(replayed, 'up')).rejects.toThrow('403');
    });

    expect(result.current.feedbackOf(replayed)?.value).toBe('down');
    expect(result.current.error?.message).toBe('403');
  });
});

describe('AgentProvider attachments', () => {
  it('builds its client with the upload strategy, so chat.backend uploads through it', async () => {
    const strategy = vi.fn(async (uploaded: File) => ({
      mediaId: 'm1',
      url: '',
      contentType: uploaded.type,
      name: uploaded.name,
    }));
    const { result } = renderHook(() => useAgentChat(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(AgentProvider, { attachments: { upload: strategy } }, children),
    });
    const attachment = await result.current.backend.uploadAttachment?.(
      new File(['x'], 'a.png', { type: 'image/png' }),
    );
    expect(attachment).toMatchObject({ mediaId: 'm1', name: 'a.png' });
    expect(strategy).toHaveBeenCalledTimes(1);
  });
});
