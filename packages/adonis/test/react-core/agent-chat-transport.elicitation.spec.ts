import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { AgentChatTransport } from '../../src/react/core/agent-chat-transport.js';

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
    headers: new Headers(),
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

function sendArgs(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    trigger: 'submit-message',
    chatId: 'thr-1',
    messageId: undefined,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refactor this' }] }],
    abortSignal: undefined,
  };
}

const QUESTIONS = [
  {
    id: 'scope',
    prompt: 'How much should I cover?',
    options: [
      { value: 'file', label: 'This file', hotkey: 'a' },
      { value: 'module', label: 'The whole module', hotkey: 'b' },
    ],
    defaults: ['module'],
  },
];

function elicitationFrame(id: string, source: 'intake' | 'ask'): string {
  const request = { id, source, preamble: 'A few questions first.', questions: QUESTIONS };
  return `data: ${JSON.stringify({ kind: 'elicitation', id, request })}\n\n`;
}

const OUTCOME = {
  answers: { scope: ['file'] },
  skipped: false,
  defaulted: [],
  summary: 'The user answered:\nHow much should I cover? → This file',
};

describe('AgentChatTransport — elicitation', () => {
  it('opens a tool part for an authored intake, so its settlement is not an orphan', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          elicitationFrame('intake-run-1', 'intake'),
          `data: ${JSON.stringify({ kind: 'tool-output', id: 'intake-run-1', output: OUTCOME })}\n\n`,
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'finish',
    ]);
    // The question set rides the part's input, under the same name the row is persisted with —
    // so a reloaded thread's `tool-ask` part carries the identical shape.
    expect(chunks[2]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 'intake-run-1',
      toolName: 'ask',
      input: { preamble: 'A few questions first.', questions: QUESTIONS },
    });
    expect(chunks[3]).toMatchObject({
      type: 'tool-output-available',
      toolCallId: 'intake-run-1',
      output: OUTCOME,
    });
  });

  it("leaves the model's own ask call alone — the part it already opened is the one that settles", async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"tool-input-start","id":"call-1","name":"ask","toolKind":"action"}\n\n',
          `data: ${JSON.stringify({ kind: 'tool-input-available', id: 'call-1', name: 'ask', input: { questions: QUESTIONS }, toolKind: 'action' })}\n\n`,
          elicitationFrame('call-1', 'ask'),
          `data: ${JSON.stringify({ kind: 'tool-output', id: 'call-1', output: OUTCOME })}\n\n`,
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'finish',
    ]);
  });

  it('no longer drops the frame: an elicitation always leaves a tool part behind', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([elicitationFrame('intake-run-2', 'intake'), 'event: done\ndata: {}\n\n']),
      ),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.some((chunk) => chunk.type === 'tool-input-available')).toBe(true);
  });
});
