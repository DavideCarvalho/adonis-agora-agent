// `@adonis-agora/agent/react` driving this package's own AG-UI producer (`agUiAdapter()`) over real
// HTTP: the REAL local Adonis React consumer (`agUiChatStream` → `useAgentChat`) against
// the REAL `POST /agent/ag-ui`, so a drift between the AG-UI this package writes and the AG-UI that
// client reads fails here rather than in an app.

import type { UIMessageChunk } from 'ai';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agUiAdapter } from '../src/ag-ui/index.js';
import {
  attachmentStores,
  defineTool,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
} from '../src/index.js';
import {
  type AgentBackend,
  AgentChatTransport,
  type ResumeStreamRequest,
  reframeAgUiStream,
} from '../src/react/core/index.js';
import {
  AgentProvider,
  agUiBackend,
  agUiChatStream,
  useAgentChat,
  useThreads,
} from '../src/react/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
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
    const user = [...(model.seen[0] ?? [])].reverse().find((entry) => entry.role === 'user');
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
      source: 'ask',
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
    // Parked on what the chat shows: not over, so no `done` — the transport re-attaches.
    expect(frames.some((frame) => frame.event === 'done')).toBe(false);
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

/** An AG-UI body with SSE ids, as the Adonis producer writes it (the run's own sequence). */
function numbered(events: [number | undefined, Record<string, unknown>][]): string {
  return events
    .map(
      ([id, event]) => `${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

/** A run that stopped on an approval for `c` after three events of its own. */
const parkedOnApproval = numbered([
  [undefined, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }],
  [undefined, { type: 'CUSTOM', name: 'agora.run', value: { runId: 'lib', threadId: 't1' } }],
  [1, { type: 'STEP_STARTED', stepName: 'step-1' }],
  [
    2,
    {
      type: 'TOOL_CALL_START',
      toolCallId: 'c',
      toolCallName: 'refund',
      metadata: { 'agora.toolKind': 'action' },
    },
  ],
  [2, { type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: '{"id":7}' }],
  [2, { type: 'TOOL_CALL_END', toolCallId: 'c' }],
  [
    3,
    {
      type: 'CUSTOM',
      name: 'agora.approval-requested',
      value: { id: 'c', runId: 'lib', toolName: 'refund', input: { id: 7 }, approver: 'requester' },
    },
  ],
  [3, { type: 'STEP_FINISHED', stepName: 'step-1' }],
  [
    3,
    {
      type: 'RUN_FINISHED',
      threadId: 't1',
      runId: 'r1',
      outcome: {
        type: 'interrupt',
        interrupts: [{ id: 'i1', reason: 'tool_approval', toolCallId: 'c' }],
      },
    },
  ],
]);

const proposalDecided = numbered([
  [undefined, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }],
  [
    undefined,
    {
      type: 'CUSTOM',
      name: 'agora.action-proposal-decision',
      value: { threadId: 't1', proposalDecision: { status: 'approved', proposalId: 'p1' } },
    },
  ],
  [undefined, { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }],
  [undefined, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Approved.' }],
  [undefined, { type: 'TEXT_MESSAGE_END', messageId: 'm' }],
  [undefined, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }],
]);

describe('reframeAgUiStream — following the run past an interrupt', () => {
  it("moves the cursor to the run's own sequence once a frame's events are re-framed, and ends without done", async () => {
    const raw = await new Response(
      reframeAgUiStream(bodyOf(parkedOnApproval), { threadId: 't1' }),
    ).text();
    const blocks = raw.split('\n\n').filter((block) => block.length > 0);
    const kinds = blocks.map((block) => {
      if (block.startsWith('event: ')) return /^event: (.*)$/m.exec(block)?.[1];
      if (block.startsWith('id: ') && !block.includes('data: ')) return `#${block.slice(4)}`;
      const data = JSON.parse(block.slice(block.indexOf('data: ') + 6)) as { kind: string };
      return data.kind;
    });
    expect(kinds).toEqual([
      'meta',
      'step-start',
      '#1',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      '#2',
      'approval-requested',
      'step-finish',
      '#3',
    ]);
    // Event frames carry no id of their own: a count of re-framed frames is not the run's sequence.
    expect(blocks.filter((block) => block.startsWith('id: ') && block.includes('data: '))).toEqual(
      [],
    );
    expect(raw).not.toContain('event: done');
    expect(raw).not.toContain('AgUiInterrupt');
  });

  it('writes the proposal decision a text decision answers with', async () => {
    const frames = await reframe(
      JSON.parse(
        `[${proposalDecided
          .split('\n\n')
          .filter((block) => block.length > 0)
          .map((block) => block.slice(block.indexOf('data: ') + 6))
          .join(',')}]`,
      ) as Record<string, unknown>[],
    );
    expect(frames).toContainEqual({
      kind: 'proposal-decision',
      threadId: 't1',
      proposalDecision: { status: 'approved', proposalId: 'p1' },
      text: 'Approved.',
    });
    expect(frames.at(-1)).toEqual({ event: 'done' });
  });
});

describe('AgentChatTransport over a re-framed AG-UI stream', () => {
  function backendWith(
    open: string,
    resumes: string[],
  ): AgentBackend & {
    resumed: ResumeStreamRequest[];
  } {
    const resumed: ResumeStreamRequest[] = [];
    return {
      resumed,
      async openChatStream() {
        return { body: reframeAgUiStream(bodyOf(open), { threadId: 't1' }), threadId: 't1' };
      },
      async resumeChatStream(request) {
        resumed.push(request);
        const next = resumes.shift();
        return next === undefined
          ? null
          : { body: bodyOf(next), runId: request.runId, threadId: 't1' };
      },
      cancelStream: async () => ({ aborted: true }),
      listThreads: async () => [],
      getThread: async () => {
        throw new Error('unused');
      },
      updateThread: async () => ({ ok: true }),
      deleteThread: async () => undefined,
    };
  }

  async function collect(chunks: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
    const out: UIMessageChunk[] = [];
    const reader = chunks.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(value);
    }
  }

  const send = {
    trigger: 'submit-message' as const,
    chatId: 't1',
    messageId: undefined,
    messages: [
      { id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'refund 7' }] },
    ],
    abortSignal: undefined,
  };

  it('re-attaches to the parked run at its own sequence and streams the rest into the same message', async () => {
    const backend = backendWith(parkedOnApproval, [
      [
        'event: meta\ndata: {"runId":"lib","threadId":"t1"}\n\n',
        `id: 4\ndata: ${JSON.stringify({ kind: 'approval-settled', id: 'c', approved: true })}\n\n`,
        `id: 5\ndata: ${JSON.stringify({ kind: 'tool-output', id: 'c', output: { refunded: true } })}\n\n`,
        `id: 6\ndata: ${JSON.stringify({ kind: 'step-start' })}\n\n`,
        `id: 7\ndata: ${JSON.stringify({ kind: 'text', text: 'Done.' })}\n\n`,
        `id: 8\ndata: ${JSON.stringify({ kind: 'step-finish' })}\n\n`,
        'event: done\ndata: {}\n\n',
      ].join(''),
    ]);
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 1 } });
    const chunks = await collect(await transport.sendMessages(send));

    expect(backend.resumed).toEqual([expect.objectContaining({ runId: 'lib', after: 3 })]);
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-available', toolCallId: 'c' }),
    );
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Done.' }));
    expect(JSON.stringify(chunks)).not.toContain('AgUiInterrupt');
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('answers a text decision with the transient data-proposal-decision part', async () => {
    const backend = backendWith(proposalDecided, []);
    const transport = new AgentChatTransport({ backend });
    const chunks = await collect(await transport.sendMessages(send));
    expect(chunks).toContainEqual({
      type: 'data-proposal-decision',
      data: {
        threadId: 't1',
        proposalDecision: { status: 'approved', proposalId: 'p1' },
        text: 'Approved.',
      },
      transient: true,
    });
    expect(backend.resumed).toEqual([]);
  });
});

describe('agUiBackend() — an approval decided on the native routes', { timeout: 30_000 }, () => {
  it('streams the rest of the run into the same message once the call is approved', async () => {
    const refund = defineTool(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        input: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      () => ({ refunded: true }),
    );
    booted = await bootAgentApp({
      model: new FakeModelProvider((args) => {
        const last = args.messages.at(-1);
        if ((last?.toolResults?.length ?? 0) > 0) return { text: 'Done.' };
        if (last?.content === 'refund 7') {
          return { text: '', toolCall: { name: 'refund', input: { id: 7 } } };
        }
        return { text: 'hi' };
      }),
      tools: [refund],
      adapters: [agUiAdapter({ quietMs: 80 })],
    });
    const backend = agUiBackend({
      baseUrl: booted.url,
      headers: { 'x-actor-id': 'u1' },
      fetch: recording,
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(AgentProvider, { backend }, children);
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    // A thread the chat already holds: nothing re-loads it (and re-attaches) behind the turn.
    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      void result.current.sendMessage({ text: 'refund 7' });
    });
    await waitFor(() =>
      expect(JSON.stringify(result.current.messages)).toContain('approval-requested'),
    );
    // Past the quiet window: the AG-UI run has ended on its interrupt before anyone decides.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const toolCallId = /"toolCallId":"(call-[^"]*-refund)"/.exec(
      JSON.stringify(result.current.messages),
    )?.[1] as string;
    await act(async () => {
      await backend.approveToolCall?.({ toolCallId });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() =>
      expect(result.current.messages.map((message) => [message.role, textOf(message)])).toEqual([
        ['user', 'hello'],
        ['assistant', 'hi'],
        ['user', 'refund 7'],
        ['assistant', 'Done.'],
      ]),
    );
    expect(JSON.stringify(result.current.messages)).toContain('"refunded":true');
    expect(JSON.stringify(result.current.messages)).not.toContain('AgUiInterrupt');
    // The rest came over the native stream route, after the AG-UI run's last event of the run.
    expect(
      seen.some((request) => /^\/agent\/chat\/[^/]+\/stream\?after=\d+$/.test(request.path)),
    ).toBe(true);
  });
});
