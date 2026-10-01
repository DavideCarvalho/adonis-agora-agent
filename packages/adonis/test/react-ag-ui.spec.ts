// `@adonis-agora/agent/react` driving this package's own AG-UI producer (`agUiAdapter()`) over real
// HTTP: the REAL `@dudousxd/nestjs-agent-react` consumer (`agUiChatStream` → `useAgentChat`) against
// the REAL `POST /agent/ag-ui`, so a drift between the AG-UI this package writes and the AG-UI that
// client reads fails here rather than in an app.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agUiAdapter } from '../src/ag-ui/index.js';
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '../src/index.js';
import {
  AgentProvider,
  agUiBackend,
  agUiChatStream,
  useAgentChat,
  useThreads,
} from '../src/react/index.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';
import { act, pageDocument as document, renderHook, waitFor } from './helpers/dom.js';

/** Answers `re: <message>`. */
class EchoModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages]
      .reverse()
      .find((entry) => entry.role === 'user' && entry.content);
    const text = `re: ${last?.content ?? ''}`;
    await args.sink.write({ t: 'text', v: text });
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

interface Seen {
  method: string;
  path: string;
  headers: Headers;
}

let booted: BootedApp | undefined;
let seen: Seen[] = [];

const consoleError = console.error;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('not wrapped in act')) consoleError(...args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await booted?.close();
  booted = undefined;
  seen = [];
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

const recording: typeof fetch = (input, init) => {
  const target = new URL(String(input));
  seen.push({
    method: init?.method ?? 'GET',
    path: target.pathname + target.search,
    headers: new Headers(init?.headers),
  });
  return fetch(input, init);
};

const textOf = (message: { parts: Array<{ type: string; text?: string }> }) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');

describe('agUiBackend() — useAgentChat over AG-UI against the Adonis producer', {
  timeout: 30_000,
}, () => {
  it('runs the turn over POST /agent/ag-ui and everything else over the REST routes', async () => {
    booted = await bootAgentApp({ model: new EchoModel(), adapters: [agUiAdapter()] });
    document.cookie = 'XSRF-TOKEN=tok';
    const backend = agUiBackend({
      baseUrl: booted.url,
      headers: { 'x-actor-id': 'u1' },
      fetch: recording,
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(AgentProvider, { backend }, children);

    const created: string[] = [];
    const { result } = renderHook(
      () => useAgentChat({ onThreadCreated: (id) => created.push(id) }),
      { wrapper },
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.messages.map((message) => [message.role, textOf(message)])).toEqual([
      ['user', 'hello'],
      ['assistant', 're: hello'],
    ]);
    expect(created).toHaveLength(1);

    // The turn went over AG-UI, carrying the session's CSRF token and the connection's headers.
    const run = seen.find((request) => request.path === '/agent/ag-ui');
    expect(run?.method).toBe('POST');
    expect(run?.headers.get('x-xsrf-token')).toBe('tok');
    expect(run?.headers.get('x-actor-id')).toBe('u1');
    expect(seen.some((request) => request.path === '/agent/chat')).toBe(false);

    // The thread AG-UI ran on is the one the REST surface lists — the rest of the backend is the
    // CSRF-aware client, reached through the Proxy rather than lost to a spread.
    const threads = renderHook(() => useThreads(), { wrapper });
    await waitFor(() => expect(threads.result.current.threads).toHaveLength(1));
    expect(threads.result.current.threads[0]?.id).toBe(created[0]);
  });
});

describe('agUiChatStream — the Adonis re-export', () => {
  it('reads the CSRF token per call, under the headers the caller passes', async () => {
    const headers: Array<Record<string, string>> = [];
    const fake: typeof fetch = async (_input, init) => {
      headers.push({ ...(init?.headers as Record<string, string>) });
      return new Response('data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    document.cookie = 'XSRF-TOKEN=first';
    await agUiChatStream({ body: { message: 'hi' } }, { url: 'http://x/agent/ag-ui', fetch: fake });
    document.cookie = 'XSRF-TOKEN=rotated';
    await agUiChatStream(
      { body: { message: 'hi' } },
      { url: 'http://x/agent/ag-ui', fetch: fake, headers: { authorization: 'Bearer t' } },
    );
    expect(headers.map((sent) => sent['X-XSRF-TOKEN'])).toEqual(['first', 'rotated']);
    expect(headers[1]?.authorization).toBe('Bearer t');
  });
});
