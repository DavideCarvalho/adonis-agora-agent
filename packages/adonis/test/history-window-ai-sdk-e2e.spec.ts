import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { aiSdkModel } from '../src/ai-sdk/ai-sdk-model.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ModelMessage,
  runAgentLoop,
  SlidingWindowHistory,
  ToolRegistry,
} from '../src/index.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';

// A summarizing `historyWindow` used to put the summary in the thread as a `system` message. Through
// the real `streamText`, AI SDK 7 rejects that (`AI_InvalidPromptError: System messages are not
// allowed in the prompt or messages fields. Use the instructions option instead.`) and every turn of
// a thread long enough to be summarized failed — the fake model the window specs use never reaches
// the SDK's prompt validation, so only an end-to-end run shows it. These go through the real
// `aiSdkModel` and `streamText`, with nothing but the provider mocked.

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

function systemTexts(prompt: Prompt | undefined): { index: number; text: string }[] {
  return (prompt ?? []).flatMap((message, index) =>
    message.role === 'system' ? [{ index, text: message.content }] : [],
  );
}

describe('historyWindow summary through the real AI SDK', () => {
  it('answers the turn, with the summary in the system prompt and no system message in the conversation', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    for (let i = 0; i < 3; i += 1) {
      await store.appendMessage({ threadId: thread.id, role: 'user', content: `old-user-${i}` });
      await store.appendMessage({ threadId: thread.id, role: 'assistant', content: `old-${i}` });
    }
    const seen: { prompt?: Prompt } = {};
    const deps: AgentLoopDeps = {
      model: aiSdkModel(model(seen)),
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      systemPrompt: 'test',
      day: '2026-10-23',
      historyWindow: new SlidingWindowHistory({
        maxMessages: 2,
        summarize: async () => ({ text: 'they talked about the baby' }),
      }),
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
    // The instructions are the provider prompt's one system message, at its head; the summary is
    // part of it, after the agent's own prompt.
    const systems = systemTexts(seen.prompt);
    expect(systems).toHaveLength(1);
    expect(systems[0]?.index).toBe(0);
    expect(systems[0]?.text.startsWith('test')).toBe(true);
    expect(systems[0]?.text).toContain(
      '<conversation_summary>\nthey talked about the baby\n</conversation_summary>',
    );
    expect(seen.prompt?.slice(1).map((message) => message.role)).toEqual(['assistant', 'user']);
  });

  it('hoists a system message handed to the adapter mid-conversation instead of failing the call', async () => {
    const seen: { prompt?: Prompt } = {};
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'late note' },
      { role: 'user', content: 'second' },
    ];

    const result = await aiSdkModel(model(seen)).runTurn({
      system: 'base',
      messages,
      tools: [],
      sink: { write: () => {}, end: () => {} },
    });

    expect(result.text).toBe('ok');
    expect(systemTexts(seen.prompt)).toEqual([{ index: 0, text: 'base\n\nlate note' }]);
    expect(seen.prompt?.slice(1).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});
