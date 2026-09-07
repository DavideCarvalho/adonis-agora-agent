import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  runAgentLoop,
  SlidingWindowHistory,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const CTX = { actor: ACTOR, threadId: 't1' };

describe('SlidingWindowHistory', () => {
  it('leaves the history untouched when at or under the limit', () => {
    const window = new SlidingWindowHistory({ maxMessages: 5 });
    const messages = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ];
    expect(window.apply(messages, CTX)).toEqual(messages);
  });

  it('keeps only the most recent N messages when over the limit', () => {
    const window = new SlidingWindowHistory({ maxMessages: 2 });
    const messages = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
      { role: 'user' as const, content: 'three' },
      { role: 'assistant' as const, content: 'four' },
    ];
    expect(window.apply(messages, CTX).map((m) => m.content)).toEqual(['three', 'four']);
  });

  it('defaults to keeping the most recent 40 messages', () => {
    const window = new SlidingWindowHistory();
    const messages = Array.from({ length: 41 }, (_, i) => ({
      role: 'user' as const,
      content: String(i),
    }));
    const result = window.apply(messages, CTX);
    expect(result).toHaveLength(40);
    expect(result[0]?.content).toBe('1');
    expect(result.at(-1)?.content).toBe('40');
  });
});

describe('runAgentLoop historyWindow wiring', () => {
  async function seedOldMessages(store: InMemoryAgentStore, threadId: string, pairs: number) {
    for (let i = 0; i < pairs; i += 1) {
      await store.appendMessage({ threadId, role: 'user', content: `old-user-${i}` });
      await store.appendMessage({ threadId, role: 'assistant', content: `old-assistant-${i}` });
    }
  }

  it('compacts the history before the model call when a window is configured', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    await seedOldMessages(store, thread.id, 5);

    let observedCount = -1;
    const model = new FakeModelProvider((args) => {
      observedCount = args.messages.length;
      return { text: 'final answer' };
    });

    const deps: AgentLoopDeps = {
      model,
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-06-30',
      systemPrompt: 'You are a test agent.',
      historyWindow: new SlidingWindowHistory({ maxMessages: 4 }),
    };
    const hooks: AgentLoopHooks = {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };

    const result = await runAgentLoop(
      deps,
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      hooks,
    );

    expect(result.text).toBe('final answer');
    // 10 old messages + the just-persisted new user message = 11; windowed down to 4.
    expect(observedCount).toBe(4);
  });

  it('sends the full thread history when no window is configured', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
    await seedOldMessages(store, thread.id, 5);

    let observedCount = -1;
    const model = new FakeModelProvider((args) => {
      observedCount = args.messages.length;
      return { text: 'final answer' };
    });

    const deps: AgentLoopDeps = {
      model,
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-06-30',
      systemPrompt: 'You are a test agent.',
    };
    const hooks: AgentLoopHooks = {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };

    await runAgentLoop(deps, { threadId: thread.id, actor: ACTOR, userText: 'hi' }, hooks);

    expect(observedCount).toBe(11);
  });
});
