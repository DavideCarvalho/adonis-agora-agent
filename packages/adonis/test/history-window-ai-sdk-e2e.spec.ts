import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  runAgentLoop,
  SlidingWindowHistory,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';

// A summarizing `historyWindow` puts the summary in the thread as a `system` message. Through the
// real `streamText`, AI SDK 7 rejected that (`AI_InvalidPromptError: System messages are not
// allowed…`) and every turn of a thread long enough to be summarized failed — the fake model the
// window specs use never reaches the SDK's prompt validation, so only an end-to-end run shows it.

type Prompt = Parameters<MockLanguageModelV3['doStream']>[0]['prompt'];

function model(seen: { prompt?: Prompt }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      seen.prompt = options.prompt;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
}

describe('historyWindow summary through the real AI SDK', () => {
  it('answers the turn, sending the summary to the model as a system message', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    for (let i = 0; i < 3; i += 1) {
      await store.appendMessage({ threadId: thread.id, role: 'user', content: `old-user-${i}` });
      await store.appendMessage({ threadId: thread.id, role: 'assistant', content: `old-${i}` });
    }
    const window = new SlidingWindowHistory({ maxMessages: 2 });
    const seen: { prompt?: Prompt } = {};
    const deps: AgentLoopDeps = {
      model: aiSdkModel(model(seen)),
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      systemPrompt: 'test',
      day: '2026-10-23',
      historyWindow: {
        select: (messages, ctx) => window.select(messages, ctx),
        summarize: async () => ({ text: 'they talked about the baby' }),
      },
    };
    const hooks: AgentLoopHooks = {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };

    await runAgentLoop(deps, { threadId: thread.id, actor, userText: 'oi' }, hooks);

    const detail = await store.getThread(thread.id);
    expect(detail?.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'ok' });
    const systems = (seen.prompt ?? []).filter((message) => message.role === 'system');
    expect(
      systems.some((message) => String(message.content).includes('they talked about the baby')),
    ).toBe(true);
  });
});
