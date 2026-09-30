import { describe, expect, it, vi } from 'vitest';
import {
  AgentChatDisconnectedError,
  type ChatPart,
  createAgentChatClient,
} from '../src/client/index.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function fakeResponse(init: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  frames?: string[] | null;
}): Response {
  const headers = init.headers ?? {};
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get: (key: string) => headers[key] ?? headers[key.toLowerCase()] ?? null,
    },
    body: init.frames ? sseStream(init.frames) : null,
  } as unknown as Response;
}

const META = (runId: string, threadId = 't1') =>
  `event: meta\ndata: ${JSON.stringify({ runId, threadId })}\n\n`;
const TEXT = (text: string) => `data: ${JSON.stringify({ kind: 'text', text })}\n\n`;
const DONE = 'event: done\ndata: {}\n\n';

function textOf(parts: ChatPart[]): string {
  return parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

describe('createAgentChatClient.send', () => {
  it('streams a completed turn without re-attaching', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({
        headers: { 'X-Agent-Run-Id': 'r1' },
        frames: [META('r1'), TEXT('Olá'), TEXT(' mundo'), DONE],
      }),
    );
    const onRunId = vi.fn();
    const client = createAgentChatClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.send({ body: { message: 'oi' }, onRunId });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/agent/chat');
    expect(textOf(result.parts)).toBe('Olá mundo');
    expect(result.runId).toBe('r1');
    expect(result.threadId).toBe('t1');
    expect(onRunId).toHaveBeenCalledWith('r1');
  });

  it('re-attaches and replays from the start when the POST stream is cut before done', async () => {
    // POST drops mid-stream (no `done`); the re-attach GET replays the WHOLE message + done.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/agent/chat') {
        return fakeResponse({
          headers: { 'X-Agent-Run-Id': 'r9' },
          frames: [META('r9'), TEXT('Hel')],
        });
      }
      return fakeResponse({ frames: [TEXT('Hello'), TEXT(' world'), DONE] });
    });
    const client = createAgentChatClient({
      fetch: fetchImpl as unknown as typeof fetch,
      resume: { backoffMs: () => 0 },
    });

    const result = await client.send({ body: { message: 'oi' } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe('/agent/chat/r9/stream');
    // Rebuilt from the replay — not "Hel" + "Hello world".
    expect(textOf(result.parts)).toBe('Hello world');
  });

  it('gives up after maxAttempts and throws with the partial parts', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/agent/chat') {
        return fakeResponse({
          headers: { 'X-Agent-Run-Id': 'r5' },
          frames: [META('r5'), TEXT('parcial')],
        });
      }
      return fakeResponse({ ok: false, status: 503, frames: null }); // every re-attach fails
    });
    const client = createAgentChatClient({
      fetch: fetchImpl as unknown as typeof fetch,
      resume: { maxAttempts: 2, backoffMs: () => 0 },
    });

    await expect(client.send({ body: { message: 'oi' } })).rejects.toMatchObject({
      name: 'AgentChatDisconnectedError',
    });
    try {
      await client.send({ body: { message: 'oi' } });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentChatDisconnectedError);
      expect(textOf((error as AgentChatDisconnectedError).parts)).toBe('parcial');
    }
    // 1 POST + 2 failed re-attach attempts, per send.
    expect(fetchImpl.mock.calls.filter((c) => c[0] === '/agent/chat/r5/stream').length).toBe(4);
  });

  it('sends merged headers (e.g. an anti-CSRF token) on every request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({ frames: [DONE] }),
    );
    const client = createAgentChatClient({
      fetch: fetchImpl as unknown as typeof fetch,
      getHeaders: () => ({ 'X-XSRF-TOKEN': 'tok' }),
    });

    await client.send({ body: { message: 'oi' } });

    const requestInit = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((requestInit.headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('tok');
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });
});
