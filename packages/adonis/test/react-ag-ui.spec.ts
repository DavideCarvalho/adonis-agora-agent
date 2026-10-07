// `@adonis-agora/agent/react` driving this package's own AG-UI producer (`agUiAdapter()`) over real
// HTTP: the REAL local Adonis React consumer (`agUiChatStream` → `useAgentChat`) against
// the REAL `POST /agent/ag-ui`, so a drift between the AG-UI this package writes and the AG-UI that
// client reads fails here rather than in an app.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agUiAdapter } from '../src/ag-ui/index.js';
import {
  attachmentStores,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
} from '../src/index.js';
import { reframeAgUiStream } from '../src/react/core/index.js';
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
  readonly seen: ModelTurnArgs['messages'][] = [];
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.seen.push(args.messages);
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

describe('agUiBackend() — attachments and regenerate', { timeout: 30_000 }, () => {
  function setup(model: EchoModel, extra: Record<string, unknown> = {}) {
    return bootAgentApp({ model, adapters: [agUiAdapter()], ...extra }).then((app) => {
      booted = app;
      const backend = agUiBackend({ baseUrl: app.url, headers: { 'x-actor-id': 'u1' } });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(AgentProvider, { backend }, children);
      return { backend, wrapper };
    });
  }

  it('sends the files the composer uploaded with the turn', async () => {
    const model = new EchoModel();
    const { backend, wrapper } = await setup(model, { attachments: attachmentStores.memory() });
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    const uploaded = await backend.uploadAttachment?.(
      new File(['png-bytes'], 'cat.png', { type: 'image/png' }),
    );
    if (uploaded === undefined) throw new Error('no upload');
    await act(async () => {
      await result.current.sendMessage(
        {
          text: 'what is this?',
          files: [
            {
              type: 'file',
              mediaType: uploaded.contentType,
              filename: uploaded.name,
              url: uploaded.url,
              providerMetadata: { agent: { mediaId: uploaded.mediaId } },
            },
          ],
        },
        { body: { attachments: [{ mediaId: uploaded.mediaId }] } },
      );
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const user = model.seen[0]?.findLast((entry) => entry.role === 'user');
    expect(user?.content).toBe('what is this?');
    expect(user?.attachments).toMatchObject([
      { mediaId: uploaded.mediaId, contentType: 'image/png', name: 'cat.png' },
    ]);
  });

  it('regenerates the last answer instead of asking the question again', async () => {
    const model = new EchoModel();
    const { backend, wrapper } = await setup(model);
    const created: string[] = [];
    const { result } = renderHook(
      () => useAgentChat({ onThreadCreated: (id) => created.push(id) }),
      { wrapper },
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      result.current.regenerate();
    });
    await waitFor(() => expect(model.seen).toHaveLength(2));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The second turn answered the SAME question once: no second user message in its history.
    expect(model.seen[1]?.filter((entry) => entry.role === 'user')).toHaveLength(1);
    const thread = await backend.getThread(created[0] as string);
    expect(thread.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});

/** Re-frame a list of AG-UI events, returning the native frames' `data` (and terminal events). */
async function reframe(events: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const source = new Response(body).body as ReadableStream<Uint8Array>;
  const text = await new Response(reframeAgUiStream(source, { threadId: 't' })).text();
  return text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(block.slice(block.indexOf('data: ') + 6)) as Record<string, unknown>;
      return event === undefined ? data : { event, ...data };
    });
}

describe('reframeAgUiStream — what the Adonis producer says beyond AG-UI', () => {
  it("keeps a tool call's kind, a step's usage and a question set", async () => {
    const request = {
      id: 'ask-1',
      source: 'tool',
      questions: [{ id: 'q', prompt: 'Which?' }],
    };
    const frames = await reframe([
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'CUSTOM', name: 'agora.run', value: { runId: 'lib', threadId: 't' } },
      { type: 'STEP_STARTED', stepName: 'step-1' },
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: 'refund',
        metadata: { 'agora.toolKind': 'action' },
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"id":7}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      { type: 'STEP_FINISHED', stepName: 'step-1' },
      {
        type: 'CUSTOM',
        name: 'agora.step-usage',
        value: { usage: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.01, model: 'm' },
      },
      { type: 'STEP_STARTED', stepName: 'step-2' },
      { type: 'STEP_FINISHED', stepName: 'step-2' },
      { type: 'CUSTOM', name: 'agora.elicitation', value: { id: 'ask-1', runId: 'lib', request } },
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        outcome: {
          type: 'interrupt',
          interrupts: [
            {
              id: 'int-1',
              reason: 'input_required',
              toolCallId: 'ask-1',
              metadata: { 'agora.request': request },
            },
          ],
        },
      },
    ]);
    expect(frames).toContainEqual({
      kind: 'tool-input-start',
      id: 'c1',
      name: 'refund',
      toolKind: 'action',
    });
    expect(frames).toContainEqual({
      kind: 'tool-input-available',
      id: 'c1',
      name: 'refund',
      input: { id: 7 },
      toolKind: 'action',
    });
    const steps = frames.filter((frame) => frame.kind === 'step-finish');
    expect(steps).toEqual([
      {
        kind: 'step-finish',
        usage: { inputTokens: 10, outputTokens: 2 },
        costUsd: 0.01,
        model: 'm',
      },
      { kind: 'step-finish' },
    ]);
    expect(frames).toContainEqual({ kind: 'elicitation', id: 'ask-1', request });
    // The question block renders it: no generic interrupt widget on top.
    expect(frames.some((frame) => frame.component === 'AgUiInterrupt')).toBe(false);
    expect(frames.at(-1)).toEqual({ event: 'done' });
  });

  it('still hands an interrupt it has no frame for to the app as AgUiInterrupt', async () => {
    const frames = await reframe([
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        outcome: { type: 'interrupt', interrupts: [{ id: 'x', reason: 'custom' }] },
      },
    ]);
    expect(frames).toContainEqual(
      expect.objectContaining({
        component: 'AgUiInterrupt',
        props: { interrupts: [{ id: 'x', reason: 'custom' }] },
      }),
    );
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
