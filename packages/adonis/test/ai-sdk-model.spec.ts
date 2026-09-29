import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import type { ModelMessage, SinkWriter, StreamFrame, ToolDefinition } from '../src/index.js';

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

// Mock the SDK boundary: `tool`/`jsonSchema` are identity-ish so we can inspect what got passed,
// and `streamText` is a spy whose return value each test controls.
vi.mock('ai', () => ({
  streamText: (args: unknown) => streamTextMock(args),
  tool: (definition: unknown) => definition,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
}));

interface CollectingSink extends SinkWriter {
  readonly written: string;
}

function createSink(): CollectingSink {
  let written = '';
  return {
    write(frame: StreamFrame) {
      if (frame.t === 'text') written += frame.v;
    },
    end() {},
    get written() {
      return written;
    },
  };
}

function noJsonSchemaTool(name: string): ToolDefinition {
  const inputSchema: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value }),
    },
  };
  return { name, kind: 'read', description: `${name} tool`, inputSchema };
}

// AI SDK v7 moved `response`/`providerMetadata` off the top-level result onto the final step
// (a promise). This mirrors that shape so the adapter reads `modelId`/cost from `finalStep`.
function fakeFinalStep(providerMetadata: unknown) {
  return Promise.resolve({
    response: { modelId: 'openai/gpt-4o', id: 'resp-1', timestamp: new Date() },
    providerMetadata,
  });
}

function fakeStreamResult(overrides: Record<string, unknown> = {}) {
  return {
    stream: (async function* generate() {
      yield { type: 'text-delta', id: '1', text: 'Hel' };
      yield { type: 'reasoning-delta', id: 'r', text: 'thinking' };
      yield { type: 'text-delta', id: '1', text: 'lo' };
      yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } };
    })(),
    toolCalls: Promise.resolve([{ toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } }]),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
      outputTokenDetails: { reasoningTokens: 3 },
    }),
    finalStep: fakeFinalStep({ gateway: { cost: 0.0123 } }),
    ...overrides,
  };
}

describe('aiSdkModel', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue(fakeStreamResult());
  });

  it('streams text deltas to the sink in order and accumulates the final text', async () => {
    const sink = createSink();
    const model = aiSdkModel('openai/gpt-4o');

    const result = await model.runTurn({
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      sink,
    });

    // Only text deltas reach the text channel, in stream order; reasoning rides its own frames.
    expect(sink.written).toBe('Hello');
    expect(result.text).toBe('Hello');
  });

  it('streams reasoning and tool-call announcements as agent-protocol frames', async () => {
    streamTextMock.mockReturnValue(
      fakeStreamResult({
        stream: (async function* generate() {
          yield { type: 'reasoning-delta', id: 'r', text: 'thinking' };
          yield { type: 'tool-input-start', id: 'call-1', toolName: 'refund' };
          yield { type: 'tool-input-delta', id: 'call-1', delta: '{"id":' };
          yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'refund', input: { id: 1 } };
        })(),
      }),
    );
    const frames: StreamFrame[] = [];
    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [{ ...noJsonSchemaTool('refund'), kind: 'action' }],
      sink: { write: (frame) => void frames.push(frame), end: () => {} },
    });
    expect(frames).toEqual([
      { t: 'event', event: { kind: 'reasoning', text: 'thinking' } },
      {
        t: 'event',
        event: { kind: 'tool-input-start', id: 'call-1', name: 'refund', toolKind: 'action' },
      },
      { t: 'event', event: { kind: 'tool-input-delta', id: 'call-1', delta: '{"id":' } },
      {
        t: 'event',
        event: {
          kind: 'tool-input-available',
          id: 'call-1',
          name: 'refund',
          input: { id: 1 },
          toolKind: 'action',
        },
      },
    ]);
  });

  it('runs a turn on the picked model: resolved when asked, verbatim for a gateway id', async () => {
    const run = (
      model: Parameters<typeof aiSdkModel>[0],
      opts?: Parameters<typeof aiSdkModel>[1],
    ) =>
      aiSdkModel(model, opts).runTurn({
        system: '',
        messages: [],
        tools: [],
        sink: createSink(),
        model: 'openai/gpt-4o-mini',
      });
    await run('openai/gpt-4o');
    expect(streamTextMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'openai/gpt-4o-mini' });
    streamTextMock.mockReturnValue(fakeStreamResult());
    await run('openai/gpt-4o', { resolveModel: (id) => `resolved:${id}` });
    expect(streamTextMock.mock.calls.at(-1)?.[0]).toMatchObject({
      model: 'resolved:openai/gpt-4o-mini',
    });
    expect(streamTextMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('resolveModel');
  });

  it('maps SDK tool calls to ToolCallRequest', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'search', input: { q: 'x' } }]);
  });

  it('maps SDK usage to MessageUsage including cache and reasoning breakdowns', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
  });

  it('surfaces a gateway-reported cost as costUsd and the response modelId', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBe(0.0123);
    expect(result.modelId).toBe('openai/gpt-4o');
  });

  it('reads OpenRouter total_cost when there is no gateway cost', async () => {
    streamTextMock.mockReturnValue(
      fakeStreamResult({ finalStep: fakeFinalStep({ openrouter: { total_cost: 0.5 } }) }),
    );

    const result = await aiSdkModel('openrouter/anthropic/claude').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBe(0.5);
  });

  it('omits costUsd when the provider reports no gateway/OpenRouter cost', async () => {
    streamTextMock.mockReturnValue(fakeStreamResult({ finalStep: fakeFinalStep(undefined) }));

    const result = await aiSdkModel('anthropic/claude').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBeUndefined();
    expect('costUsd' in result).toBe(false);
  });

  it('passes tools to the SDK WITHOUT an execute function', async () => {
    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [noJsonSchemaTool('search')],
      sink: createSink(),
    });

    const call = streamTextMock.mock.calls[0]?.[0];
    expect(call.tools.search).toBeDefined();
    expect('execute' in call.tools.search).toBe(false);
    expect(call.tools.search.description).toBe('search tool');
  });

  it('maps assistant tool-calls and tool-results into SDK messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
        toolResults: [{ id: 'c1', name: 'search', output: { hits: 2 } }],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'text', value: '{"hits":2}' },
          },
        ],
      },
    ]);
  });

  it('maps a user-role tool-result carrier (agent loop feedback) to a `tool` message immediately following the assistant tool-call, with no empty user message in between', async () => {
    // This mirrors what `agent-loop.ts` pushes after executing a tool call: NOT an assistant
    // message (the assistant tool-call message already went in on a prior turn) — a synthetic
    // `{ role: 'user', content: '', toolResults }` carrier meant only to feed the result back.
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'search for x' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
      },
      {
        role: 'user',
        content: '',
        toolResults: [{ id: 'c1', name: 'search', output: { hits: 2 } }],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'search for x' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'text', value: '{"hits":2}' },
          },
        ],
      },
    ]);

    // Explicitly assert the adjacency the AI SDK requires: the `tool` message must directly
    // follow the assistant `tool-call` message — no empty user turn wedged between them.
    const assistantIndex = passed.findIndex((m: { role: string }) => m.role === 'assistant');
    expect(passed[assistantIndex + 1].role).toBe('tool');
    expect(
      passed.some((m: { role: string; content: string }) => m.role === 'user' && m.content === ''),
    ).toBe(false);
  });

  it('maps a user message with an image attachment to text + image content parts', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: 'what is in this picture?',
        attachments: [
          {
            mediaId: 'm1',
            url: 'https://example.test/pic.png',
            contentType: 'image/png',
            name: 'pic.png',
          },
        ],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed[0].role).toBe('user');
    const parts = passed[0].content;
    expect(parts[0]).toEqual({ type: 'text', text: 'what is in this picture?' });
    expect(parts[1].type).toBe('image');
    expect(parts[1].mediaType).toBe('image/png');
    expect(String(parts[1].image)).toBe('https://example.test/pic.png');
  });

  it('maps a non-image attachment to a file content part', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: 'summarize',
        attachments: [
          {
            mediaId: 'm2',
            url: 'https://example.test/report.pdf',
            contentType: 'application/pdf',
            name: 'report.pdf',
          },
        ],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const parts = streamTextMock.mock.calls[0]?.[0].messages[0].content;
    expect(parts[1].type).toBe('file');
    expect(parts[1].mediaType).toBe('application/pdf');
    expect(parts[1].filename).toBe('report.pdf');
    expect(String(parts[1].data)).toBe('https://example.test/report.pdf');
  });

  it('leaves a user message without attachments as a plain string (text-only unchanged)', async () => {
    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [{ role: 'user', content: 'plain text' }],
      tools: [],
      sink: createSink(),
    });

    expect(streamTextMock.mock.calls[0]?.[0].messages[0]).toEqual({
      role: 'user',
      content: 'plain text',
    });
  });

  it('passes a Standard Schema through directly when it carries the JSON Schema converter', async () => {
    const inputSchema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: 'object', properties: {} }),
          output: () => ({ type: 'object', properties: {} }),
        },
      },
    };
    const converterSchema: ToolDefinition = {
      name: 'lookup',
      kind: 'read',
      description: 'lookup tool',
      inputSchema,
    };

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [converterSchema],
      sink: createSink(),
    });

    const call = streamTextMock.mock.calls[0]?.[0];
    // Pass-through: the SDK receives the original standard schema, not a jsonSchema() wrapper.
    expect(call.tools.lookup.inputSchema).toBe(converterSchema.inputSchema);
  });
});
