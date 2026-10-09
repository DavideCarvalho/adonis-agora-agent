import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiSdkModel,
  aiSdkModels,
  resetOpenRouterCostWarnings,
} from '../src/ai-sdk/ai-sdk-model.js';
import type { SinkWriter } from '../src/index.js';

// A genuine end-to-end run through the real `streamText`: the mock model emits the exact finish
// chunk `@openrouter/ai-sdk-provider@3` emits (`providerMetadata.openrouter.usage.cost`), so the
// spec pins the key the provider ACTUALLY writes rather than one a hand-rolled fake made up.

type StreamChunk =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>> extends {
    stream: ReadableStream<infer C>;
  }
    ? C
    : never;

type FinishMetadata = Extract<StreamChunk, { type: 'finish' }>['providerMetadata'];

function createSink(): SinkWriter {
  return { write() {}, end() {} };
}

function mockModel(opts: { provider?: string; modelId?: string; metadata?: FinishMetadata }) {
  const chunks: StreamChunk[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'ok' },
    { type: 'text-end', id: '1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
      ...(opts.metadata !== undefined ? { providerMetadata: opts.metadata } : {}),
    },
  ];
  return new MockLanguageModelV3({
    provider: opts.provider ?? 'openrouter.chat',
    modelId: opts.modelId ?? 'deepseek/deepseek-v4.1-flash',
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

/** The `providerMetadata` the OpenRouter provider (v3) attaches to its finish chunk. */
function openRouterMetadata(cost?: number): FinishMetadata {
  return {
    openrouter: {
      provider: 'DeepInfra',
      usage: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        ...(cost !== undefined ? { cost } : {}),
      },
    },
  };
}

const turn = () => ({
  system: '',
  messages: [{ role: 'user' as const, content: 'go' }],
  tools: [],
  sink: createSink(),
});

afterEach(() => {
  vi.restoreAllMocks();
  resetOpenRouterCostWarnings();
});

describe('aiSdkModel — gateway-reported cost (real SDK)', () => {
  it("reads OpenRouter's `providerMetadata.openrouter.usage.cost`", async () => {
    const result = await aiSdkModel(mockModel({ metadata: openRouterMetadata(0.00131) })).runTurn(
      turn(),
    );
    expect(result.costUsd).toBe(0.00131);
  });

  it('still reads the legacy `total_cost` shapes', async () => {
    const top = await aiSdkModel(
      mockModel({ metadata: { openrouter: { total_cost: 0.5 } } }),
    ).runTurn(turn());
    expect(top.costUsd).toBe(0.5);
    const nested = await aiSdkModel(
      mockModel({ metadata: { openrouter: { usage: { total_cost: 0.25 } } } }),
    ).runTurn(turn());
    expect(nested.costUsd).toBe(0.25);
  });

  it("reads the Vercel AI Gateway's `providerMetadata.gateway.cost`", async () => {
    const result = await aiSdkModel(
      mockModel({ provider: 'gateway', metadata: { gateway: { cost: '0.0042' } } }),
    ).runTurn(turn());
    expect(result.costUsd).toBe(0.0042);
  });

  it('asks OpenRouter for usage accounting on every call', async () => {
    const model = mockModel({ metadata: openRouterMetadata(0.001) });
    await aiSdkModel(model).runTurn(turn());
    expect(model.doStreamCalls[0]?.providerOptions?.openrouter).toEqual({
      usage: { include: true },
    });
  });

  it("keeps the app's own OpenRouter provider options, and its own `usage`", async () => {
    const model = mockModel({ metadata: openRouterMetadata(0.001) });
    await aiSdkModel(model, {
      providerOptions: { openrouter: { usage: { include: false }, transforms: ['middle-out'] } },
    }).runTurn(turn());
    expect(model.doStreamCalls[0]?.providerOptions?.openrouter).toEqual({
      usage: { include: false },
      transforms: ['middle-out'],
    });
  });

  it('sends no OpenRouter options to a non-OpenRouter model', async () => {
    const model = mockModel({ provider: 'openai.chat', modelId: 'gpt-4o-mini' });
    await aiSdkModel(model).runTurn(turn());
    expect(model.doStreamCalls[0]?.providerOptions?.openrouter).toBeUndefined();
  });

  it('warns ONCE per model when an OpenRouter model reports no cost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = aiSdkModel(mockModel({ metadata: openRouterMetadata(undefined) }));
    const first = await provider.runTurn(turn());
    await provider.runTurn(turn());
    expect(first.costUsd).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('deepseek/deepseek-v4.1-flash');
  });

  it('does not warn for a direct provider that never reports cost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await aiSdkModel(mockModel({ provider: 'openai.chat', modelId: 'gpt-4o-mini' })).runTurn(
      turn(),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('describeModels — what boot pricing checks', () => {
  it('aiSdkModel describes its one model and whether it reports cost', () => {
    expect(aiSdkModel(mockModel({})).describeModels?.()).toEqual([
      { modelId: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter', reportsCost: true },
    ]);
    expect(
      aiSdkModel(mockModel({ provider: 'openai.chat', modelId: 'gpt-4o-mini' })).describeModels?.(),
    ).toEqual([{ modelId: 'gpt-4o-mini', provider: 'openai', reportsCost: false }]);
  });

  it('a gateway string id reports cost', () => {
    expect(aiSdkModel('openai/gpt-4o-mini').describeModels?.()).toEqual([
      { modelId: 'openai/gpt-4o-mini', provider: 'vercel', reportsCost: true },
    ]);
  });

  it('aiSdkModels describes every offered model', () => {
    const provider = aiSdkModels({
      fast: mockModel({}),
      smart: mockModel({ provider: 'anthropic.messages', modelId: 'claude-sonnet-5' }),
    });
    expect(provider.describeModels?.()).toEqual([
      { modelId: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter', reportsCost: true },
      { modelId: 'claude-sonnet-5', provider: 'anthropic', reportsCost: false },
    ]);
  });
});
