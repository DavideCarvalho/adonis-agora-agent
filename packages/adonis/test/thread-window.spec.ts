import { describe, expect, it } from 'vitest';
import type {
  AgentLoopDeps,
  AgentLoopHooks,
  HistoryWindow,
  ModelMessage,
  StoredMessage,
  ThreadTurnPage,
  ThreadTurnQuery,
  ThreadTurnReader,
} from '../src/index.js';
import {
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
import { Journal } from './helpers/journal.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * The columns a SQL adapter's window read projects to — `usage`, `followUps` and `runId` stay in the
 * table. Mirrored here so the double is faithful about what it does NOT return, not just about how
 * many rows it returns.
 */
function projected(message: StoredMessage): StoredMessage {
  const { usage: _usage, followUps: _followUps, runId: _runId, ...turnColumns } = message;
  return turnColumns;
}

/**
 * A store that offers the window read, standing in for the Lucid adapter: newest `messageLimit`
 * rows, oldest-first, projected — and `hasAssistantMessage` answered over the WHOLE thread, which is
 * the part a page-derived implementation would get wrong. Records every query it was handed.
 */
class WindowingStore extends InMemoryAgentStore implements ThreadTurnReader {
  readonly queries: ThreadTurnQuery[] = [];

  async loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null> {
    this.queries.push(query);
    const thread = await this.getThread(query.threadId);
    if (thread === null) {
      return null;
    }
    const all = thread.messages;
    const limit = query.messageLimit;
    const window =
      limit === undefined ? all : limit <= 0 ? [] : all.slice(Math.max(0, all.length - limit));
    return {
      title: thread.title,
      hasAssistantMessage: all.some((message) => message.role === 'assistant'),
      messages: window.map(projected),
    };
  }
}

/** A thread `turns` exchanges deep, each assistant message carrying a fat tool result. */
async function seed(store: InMemoryAgentStore, turns: number, outputBytes: number) {
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  for (let index = 0; index < turns; index += 1) {
    await store.appendMessage({ threadId: thread.id, role: 'user', content: `question ${index}` });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: `answer ${index}`,
      runId: `old-run-${index}`,
      usage: { inputTokens: 10, outputTokens: 20 },
      followUps: ['and then?'],
      toolCalls: [{ id: `old-${index}`, name: 'lookup', input: {} }],
      toolResults: [
        { id: `old-${index}`, name: 'lookup', output: { rows: 'r'.repeat(outputBytes) } },
      ],
    });
  }
  return thread;
}

interface PassOptions {
  journal: Journal;
  store: InMemoryAgentStore;
  threadId: string;
  historyWindow?: HistoryWindow;
}

/** One turn through the loop, returning the prompt the model was handed. */
async function pass(options: PassOptions): Promise<ModelMessage[]> {
  const sink = new InMemoryTokenStreamSink();
  let observed: ModelMessage[] = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args) => {
      observed = [...args.messages];
      return { text: 'answered' };
    }),
    store: options.store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.historyWindow !== undefined ? { historyWindow: options.historyWindow } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => options.journal.at(name, () => fn()),
    patched: (id) => options.journal.patched(id),
  };
  options.journal.rewind();
  await runAgentLoop(deps, { threadId: options.threadId, actor: ACTOR, userText: 'hi' }, hooks);
  return observed;
}

function contents(messages: ModelMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe('agent loop — reading the thread through the store’s window', () => {
  it('asks for the window’s row ceiling and sends exactly that window', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 20, 64);

    const observed = await pass({
      journal: new Journal(),
      store,
      threadId: thread.id,
      historyWindow: new SlidingWindowHistory({ maxMessages: 4 }),
    });

    expect(store.queries).toEqual([{ threadId: thread.id, messageLimit: 4 }]);
    expect(contents(observed)).toEqual(['answer 18', 'question 19', 'answer 19', 'hi']);
  });

  it('journals the payload the full read journals, byte for byte', async () => {
    // Same thread contents on both sides, so the ONLY difference is which read the store offered.
    const windowing = new WindowingStore();
    const windowingThread = await seed(windowing, 20, 512);
    const full = new InMemoryAgentStore();
    const fullThread = await seed(full, 20, 512);

    const windowed = new Journal();
    await pass({
      journal: windowed,
      store: windowing,
      threadId: windowingThread.id,
      historyWindow: new SlidingWindowHistory({ maxMessages: 4 }),
    });
    const whole = new Journal();
    await pass({
      journal: whole,
      store: full,
      threadId: fullThread.id,
      historyWindow: new SlidingWindowHistory({ maxMessages: 4 }),
    });

    // The checkpoint is a wire contract with every run already in flight: a resume reads this string
    // back rather than calling the store at all, so the two reads have to be indistinguishable here.
    expect(windowed.recorded('load:thread')).toBe(whole.recorded('load:thread'));
    expect(windowed.names()).toEqual(whole.names());
    // And the shape itself is pinned, not just the two paths' agreement with each other: a field
    // added to what `load:thread` records changes the payload for BOTH, so only naming the keys
    // catches it.
    expect(Object.keys(JSON.parse(windowed.recorded('load:thread'))).sort()).toEqual([
      'hasAssistantMessage',
      'messages',
      'title',
    ]);
  });

  it('falls back to the full read for a store that offers no window', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 3, 64);
    const journal = new Journal();

    const observed = await pass({
      journal,
      store,
      threadId: thread.id,
      historyWindow: new SlidingWindowHistory({ maxMessages: 2 }),
    });

    expect(contents(observed)).toEqual(['answer 2', 'hi']);
    expect(journal.names()).toContain('load:thread');
  });

  it('asks for no row limit where the window summarizes — the fold reads what it dropped', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 6, 64);

    const observed = await pass({
      journal: new Journal(),
      store,
      threadId: thread.id,
      historyWindow: new SlidingWindowHistory({
        maxMessages: 2,
        summarize: async (messages) => ({ text: `folded ${messages.length}` }),
      }),
    });

    // A read bounded to what `select` KEEPS drops nothing, so the summary would stand in for no
    // messages at all — silently, in a prompt that is missing them.
    expect(store.queries).toEqual([{ threadId: thread.id }]);
    expect(observed[0]?.content).toContain('folded 11');
  });

  it('asks for no row limit where the ceiling names no message count', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 6, 64);
    // A window whose ceiling is a token budget alone: no row count follows from it, since one
    // message can be four tokens or forty thousand.
    const tokenOnly: HistoryWindow = {
      select: (messages) => ({ keep: messages.slice(-3), drop: messages.slice(0, -3) }),
    };

    await pass({ journal: new Journal(), store, threadId: thread.id, historyWindow: tokenOnly });

    expect(store.queries).toEqual([{ threadId: thread.id }]);
  });

  it('asks for no row limit where no ceiling is configured at all', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 3, 64);

    await pass({ journal: new Journal(), store, threadId: thread.id });

    expect(store.queries).toEqual([{ threadId: thread.id }]);
  });

  it('takes “has this been answered” from the thread, not from the window', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 1, 64);
    // A later question nobody answered, so the newest 2 rows hold no assistant message at all —
    // while the conversation plainly has been answered.
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'still there?' });
    const journal = new Journal();

    await pass({
      journal,
      store,
      threadId: thread.id,
      historyWindow: new SlidingWindowHistory({ maxMessages: 2 }),
    });

    const payload = JSON.parse(journal.recorded('load:thread')) as {
      messages: ModelMessage[];
      hasAssistantMessage: boolean;
    };
    expect(payload.messages.some((message) => message.role === 'assistant')).toBe(false);
    // Read off the page instead, a `thread-start` intake would re-introduce itself every turn.
    expect(payload.hasAssistantMessage).toBe(true);
  });

  it('journals a fraction of the bytes the full read materializes', async () => {
    const store = new WindowingStore();
    // The measured case: a 50-turn thread whose turns each ran a 50 KB tool.
    const thread = await seed(store, 50, 50 * 1024);
    const transcript = await store.getThread(thread.id);

    const whole = JSON.stringify(transcript).length;
    const window = JSON.stringify(
      await store.loadThreadForTurn({ threadId: thread.id, messageLimit: 4 }),
    ).length;
    const toolOutputs = JSON.stringify(
      (transcript?.messages ?? []).map((message) => message.toolResults ?? null),
    ).length;

    // ~2.6 MB, of which nearly all is tool output the prompt was never going to carry — paid on
    // every turn, and again on every replay, to send a window bounded to four messages.
    expect(whole).toBeGreaterThan(2_000_000);
    expect(toolOutputs / whole).toBeGreaterThan(0.95);
    // ~103 KB: the window itself, which is the prompt the model is being sent anyway.
    expect(window).toBeLessThan(whole / 20);
  });
});
