import { describe, expect, it } from 'vitest';
import type { AgentLoopDeps, AgentLoopHooks, HistoryWindow, ModelMessage } from '../src/index.js';
import {
  DEFAULT_HISTORY_SUMMARY_INSTRUCTION,
  DefaultRolesPolicy,
  estimateMessageTokens,
  runAgentLoop,
  SlidingWindowHistory,
  summarizeWithModel,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { Journal } from './helpers/journal.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const CTX = { actor: ACTOR, threadId: 't1' };

function say(content: string): ModelMessage {
  return { role: 'user', content };
}

describe('SlidingWindowHistory', () => {
  it('leaves the history untouched when at or under the limit', () => {
    const window = new SlidingWindowHistory({ maxMessages: 5 });
    const messages = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ];
    expect(window.select(messages, CTX)).toEqual({ keep: messages, drop: [] });
  });

  it('keeps only the most recent N messages when over the limit', () => {
    const window = new SlidingWindowHistory({ maxMessages: 2 });
    const messages = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
      { role: 'user' as const, content: 'three' },
      { role: 'assistant' as const, content: 'four' },
    ];
    const { keep, drop } = window.select(messages, CTX);
    expect(keep.map((m) => m.content)).toEqual(['three', 'four']);
    expect(drop.map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('defaults to keeping the most recent 40 messages', () => {
    const window = new SlidingWindowHistory();
    const messages = Array.from({ length: 41 }, (_, i) => ({
      role: 'user' as const,
      content: String(i),
    }));
    const { keep } = window.select(messages, CTX);
    expect(keep).toHaveLength(40);
    expect(keep[0]?.content).toBe('1');
    expect(keep.at(-1)?.content).toBe('40');
  });

  it('keeps the newest messages that fit a token budget', () => {
    // ~4 chars per token plus a 4-token envelope: a 40-char message costs 14.
    const messages = [say('a'.repeat(40)), say('b'.repeat(40)), say('c'.repeat(40))];
    const window = new SlidingWindowHistory({ maxTokens: 30 });
    const { keep, drop } = window.select(messages, CTX);
    expect(keep.map((m) => m.content[0])).toEqual(['b', 'c']);
    expect(drop.map((m) => m.content[0])).toEqual(['a']);
  });

  it('applies both limits, whichever cuts more', () => {
    const messages = [say('a'), say('b'), say('c'), say('d')];
    // The count would keep three; the budget only fits two of these ~5-token messages.
    const window = new SlidingWindowHistory({ maxMessages: 3, maxTokens: 11 });
    expect(window.select(messages, CTX).keep.map((m) => m.content)).toEqual(['c', 'd']);
  });

  it('keeps the newest message even when it alone blows the budget', () => {
    const messages = [say('older'), say('x'.repeat(4000))];
    const window = new SlidingWindowHistory({ maxTokens: 1 });
    const { keep, drop } = window.select(messages, CTX);
    expect(keep).toHaveLength(1);
    expect(keep[0]?.content).toHaveLength(4000);
    expect(drop.map((m) => m.content)).toEqual(['older']);
  });

  it('counts a message’s tool calls and results against the budget', () => {
    const bare = estimateMessageTokens({ role: 'assistant', content: 'ok' });
    const withCalls = estimateMessageTokens({
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'c1', name: 'search', input: { q: 'a long query string' } }],
    });
    expect(withCalls).toBeGreaterThan(bare);
  });
});

describe('summarizeWithModel', () => {
  it('folds the dropped messages with one non-streamed call and reports its usage', async () => {
    let seen: { system: string; count: number } | undefined;
    const model = new FakeModelProvider((args) => {
      seen = { system: args.system, count: args.messages.length };
      return { text: 'they argued about ports' };
    });
    const summarize = summarizeWithModel(model);

    const summary = await summarize([say('one'), say('two')], CTX);

    expect(summary.text).toBe('they argued about ports');
    expect(summary.usage?.outputTokens).toBeGreaterThan(0);
    expect(seen).toEqual({ system: DEFAULT_HISTORY_SUMMARY_INSTRUCTION, count: 2 });
  });
});

interface PassOptions {
  journal: Journal;
  historyWindow?: HistoryWindow;
  /** How many user/assistant pairs already sit in the thread before this turn. */
  pairs?: number;
  /** Simulates a run whose history predates the marker — the gate must give the position back. */
  patched?: (id: string) => Promise<boolean>;
}

interface PassResult {
  observed: ModelMessage[];
  usagePurposes: string[];
}

async function pass(options: PassOptions): Promise<PassResult> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR, persona: 'default' });
  for (let i = 0; i < (options.pairs ?? 5); i += 1) {
    await store.appendMessage({ threadId: thread.id, role: 'user', content: `old-user-${i}` });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: `old-assistant-${i}`,
    });
  }

  let observed: ModelMessage[] = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args) => {
      // A copy: the loop pushes the assistant message onto this very array right after the call.
      observed = [...args.messages];
      return { text: 'final answer' };
    }),
    store,
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
    patched: options.patched ?? ((id) => options.journal.patched(id)),
  };
  options.journal.rewind();
  await runAgentLoop(deps, { threadId: thread.id, actor: ACTOR, userText: 'hi' }, hooks);
  return {
    observed,
    usagePurposes: store.usageRows().map((row) => row.purpose),
  };
}

describe('runAgentLoop historyWindow wiring', () => {
  it('compacts the history before the model call when a window is configured', async () => {
    const { observed } = await pass({
      journal: new Journal(),
      historyWindow: new SlidingWindowHistory({ maxMessages: 4 }),
    });
    // 10 old messages + the just-persisted new user message = 11; windowed down to 4.
    expect(observed).toHaveLength(4);
  });

  it('sends the full thread history when no window is configured', async () => {
    const journal = new Journal();
    const { observed } = await pass({ journal });
    expect(observed).toHaveLength(11);
    // And records EXACTLY the checkpoints it recorded before this option existed.
    expect(journal.namesBetween('load:thread', 'llm:0')).toEqual([]);
  });

  it('takes the split outside any checkpoint when nothing is summarized', async () => {
    const journal = new Journal();
    await pass({ journal, historyWindow: new SlidingWindowHistory({ maxMessages: 4 }) });
    // Only the version gate sits between the thread read and the turn: selection is pure, so a
    // replay re-runs it on the same cached messages and reaches the same split.
    expect(journal.namesBetween('load:thread', 'llm:0')).toEqual(['patch:agent:history-select']);
  });

  it('journals the summary and bills it, and hands it to the model as a leading system message', async () => {
    const journal = new Journal();
    const window = new SlidingWindowHistory({
      maxMessages: 2,
      summarize: async () => ({
        text: 'they discussed the manifest',
        usage: { inputTokens: 40, outputTokens: 9 },
        modelId: 'summarizer-1',
      }),
    });

    const { observed, usagePurposes } = await pass({ journal, historyWindow: window });

    expect(journal.namesBetween('load:thread', 'llm:0')).toEqual([
      'patch:agent:history-select',
      'history:summarize',
      'persist:usage:history',
    ]);
    expect(observed).toHaveLength(3);
    expect(observed[0]?.role).toBe('system');
    expect(observed[0]?.content).toContain('they discussed the manifest');
    expect(usagePurposes).toContain('summary');
  });

  it('does not summarize when the window dropped nothing', async () => {
    const journal = new Journal();
    let calls = 0;
    const window = new SlidingWindowHistory({
      maxMessages: 40,
      summarize: async () => {
        calls += 1;
        return { text: 'never' };
      },
    });

    await pass({ journal, historyWindow: window, pairs: 2 });

    expect(calls).toBe(0);
    expect(journal.namesBetween('load:thread', 'llm:0')).toEqual(['patch:agent:history-select']);
  });

  it('keeps replaying a run that recorded the single history:window checkpoint', async () => {
    const journal = new Journal();
    const window = new SlidingWindowHistory({ maxMessages: 4 });

    // A run recorded before the split existed: the gate answers `false` and the whole compaction
    // sits in one checkpoint, exactly where its history holds it.
    await pass({ journal, historyWindow: window, patched: async () => false });
    const recorded = journal.names();
    expect(journal.namesBetween('load:thread', 'llm:0')).toEqual(['history:window']);

    // Resumed by a process that has the gate: the position must go back to the recorded step, so
    // the resume replays the run through to the end without adding or renaming a checkpoint.
    await pass({ journal, historyWindow: window });
    expect(journal.names()).toEqual(recorded);
  });
});
