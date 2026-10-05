import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  AgentChatTransport,
  type AgentStreamMeta,
} from '../../src/react/core/agent-chat-transport.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function fakeFetch(stream: ReadableStream<Uint8Array>): typeof fetch {
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    headers: new Headers({
      'x-agent-run-id': 'run-header',
      'x-agent-thread-id': 'thr-header',
    }),
  };
  return (async () => response) as unknown as typeof fetch;
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const userMessage: UIMessage = {
  id: 'm1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
};

function sendArgs(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    trigger: 'submit-message',
    chatId: 'thr-1',
    messageId: undefined,
    messages: [userMessage],
    abortSignal: undefined,
  };
}

describe('AgentChatTransport', () => {
  it('maps AgentStreamEvent frames (text + tool round) into a v7 UI-message chunk stream', async () => {
    const captured: AgentStreamMeta[] = [];
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"text","text":"Hello"}\n\n',
          'data: {"kind":"text","text":" world"}\n\n',
          'data: {"kind":"tool-input-available","id":"t1","name":"executeSql","input":{"query":"SELECT 1"}}\n\n',
          'data: {"kind":"tool-output","id":"t1","output":{"rows":[]}}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
      onMeta: (meta) => captured.push(meta),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));
    const types = chunks.map((chunk) => chunk.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'tool-input-available',
      'tool-output-available',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const text = chunks
      .filter(
        (chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta',
      )
      .map((chunk) => chunk.delta)
      .join('');
    expect(text).toBe('Hello world');

    const toolAvailable = chunks.find((chunk) => chunk.type === 'tool-input-available');
    expect(toolAvailable).toMatchObject({ toolCallId: 't1', toolName: 'executeSql' });
    const toolOutput = chunks.find((chunk) => chunk.type === 'tool-output-available');
    expect(toolOutput).toMatchObject({ toolCallId: 't1', output: { rows: [] } });
  });

  it('maps a message-metadata frame onto the message metadata chunk', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"text","text":"Hi"}\n\n',
          'data: {"kind":"message-metadata","metadata":{"model":"openai/gpt","error":"cut short"}}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.find((chunk) => chunk.type === 'message-metadata')).toEqual({
      type: 'message-metadata',
      messageMetadata: { model: 'openai/gpt', error: 'cut short' },
    });
  });

  it('carries a refusal through as the SDK denial, never as an error chunk', async () => {
    // The state a card branches on. Mapped to `tool-output-error`, a person's own "no" reaches the
    // UI as the red treatment a crash gets, under whatever text the error carried.
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"tool-input-available","id":"t1","name":"purgeCache","input":{"key":"cfg"},"toolKind":"action"}\n\n',
          'data: {"kind":"tool-output-denied","id":"t1","reason":"wrong environment"}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.some((chunk) => chunk.type === 'tool-output-error')).toBe(false);
    expect(chunks.find((chunk) => chunk.type === 'tool-output-denied')).toEqual({
      type: 'tool-output-denied',
      toolCallId: 't1',
    });
  });

  it('forwards per-send attachments (image/PDF) in the POST body alongside the message text', async () => {
    let capturedBody: unknown;
    const capturingFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: sseStream(['event: done\ndata: {}\n\n']),
        headers: new Headers(),
      };
    }) as unknown as typeof fetch;
    const transport = new AgentChatTransport({ fetch: capturingFetch });

    const attachments = [
      { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
      { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
    ];
    await collect(await transport.sendMessages({ ...sendArgs(), body: { attachments } }));

    expect(capturedBody).toMatchObject({ message: 'hello', attachments });
  });

  it('surfaces runId/threadId from the meta frame', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          'data: {"kind":"text","text":"hi"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    await collect(await transport.sendMessages(sendArgs()));

    // The meta frame wins over the header fallback.
    expect(transport.runId).toBe('run-1');
    expect(transport.threadId).toBe('thr-1');
  });

  it('returns null from reconnectToStream when no run is resumable', async () => {
    const transport = new AgentChatTransport({
      fetch: (() => {
        throw new Error('reconnect must not hit the network');
      }) as unknown as typeof fetch,
      getResumeRunId: () => undefined,
    });

    const result = await transport.reconnectToStream({ chatId: 'thr-1' });
    expect(result).toBeNull();
  });

  it('carries toolKind through to tool-input-start/available chunks as toolMetadata', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"tool-input-start","id":"t1","name":"purgeCache","toolKind":"action"}\n\n',
          'data: {"kind":"tool-input-available","id":"t1","name":"purgeCache","input":{},"toolKind":"action"}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    const inputStart = chunks.find((chunk) => chunk.type === 'tool-input-start');
    expect(inputStart).toMatchObject({ toolMetadata: { toolKind: 'action' } });
    const inputAvailable = chunks.find((chunk) => chunk.type === 'tool-input-available');
    expect(inputAvailable).toMatchObject({ toolMetadata: { toolKind: 'action' } });
  });

  it('omits toolMetadata when the backend does not report toolKind (older backends)', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"tool-input-start","id":"t1","name":"listUsers"}\n\n',
          'data: {"kind":"tool-input-available","id":"t1","name":"listUsers","input":{}}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    const inputStart = chunks.find((chunk) => chunk.type === 'tool-input-start') as Record<
      string,
      unknown
    >;
    const inputAvailable = chunks.find((chunk) => chunk.type === 'tool-input-available') as Record<
      string,
      unknown
    >;
    expect('toolMetadata' in inputStart).toBe(false);
    expect('toolMetadata' in inputAvailable).toBe(false);
  });

  it('surfaces costUsd from a step-finish frame as message-metadata', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"text","text":"hi"}\n\n',
          'data: {"kind":"step-finish","usage":{"inputTokens":10,"outputTokens":5},"costUsd":0.0042}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    const metadata = chunks.find((chunk) => chunk.type === 'message-metadata');
    expect(metadata).toMatchObject({ messageMetadata: { costUsd: 0.0042 } });
  });

  it('surfaces a null costUsd when no pricing store/provider figure is available', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"step-finish","usage":{"inputTokens":10,"outputTokens":5},"costUsd":null}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    const metadata = chunks.find((chunk) => chunk.type === 'message-metadata');
    expect(metadata).toMatchObject({ messageMetadata: { costUsd: null } });
  });

  it('emits no message-metadata chunk when step-finish carries no costUsd (older backends)', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"text","text":"hi"}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.some((chunk) => chunk.type === 'message-metadata')).toBe(false);
  });
});
