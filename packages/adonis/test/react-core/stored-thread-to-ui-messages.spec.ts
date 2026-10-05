import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../src/index.js';
import { storedMessageToUiMessage } from '../../src/react/core/stored-message-to-ui-message.js';
import { storedThreadToUiMessages } from '../../src/react/core/stored-thread-to-ui-messages.js';

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('storedThreadToUiMessages', () => {
  it('merges consecutive assistant rows (tool call in between) into one UIMessage with ordered parts', () => {
    const rows: StoredMessage[] = [
      message({
        id: 'a1',
        content: "I'll check that.",
        toolCalls: [{ id: 't1', name: 'listUsers', input: { limit: 5 } }],
        toolResults: [{ id: 't1', name: 'listUsers', output: { users: [] } }],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
      }),
      message({
        id: 'a2',
        content: 'There are no users.',
        followUps: ['Anything else?'],
        usage: { inputTokens: 150, outputTokens: 30, costUsd: 0.002 },
      }),
    ];

    const [ui] = storedThreadToUiMessages(rows);

    expect(ui).toBeDefined();
    // id = the LAST row's id (the final-answer row — carries followUps and turn-level metadata).
    expect(ui?.id).toBe('a2');
    expect(ui?.role).toBe('assistant');
    // parts concatenate in row order: row1 text, row1 tools, row2 text — matching the live stream's
    // step-bracketed ordering for the same turn.
    expect(ui?.parts).toEqual([
      { type: 'text', text: "I'll check that." },
      {
        type: 'tool-listUsers',
        toolCallId: 't1',
        state: 'output-available',
        input: { limit: 5 },
        output: { users: [] },
      },
      { type: 'text', text: 'There are no users.' },
    ]);
    // Aggregated usage summed across both merged rows.
    expect(ui?.metadata).toEqual({
      usage: { inputTokens: 250, outputTokens: 50, costUsd: 0.003 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('treats a null costUsd on some rows as 0 in the sum, not as poisoning the whole turn to null', () => {
    const rows: StoredMessage[] = [
      message({
        id: 'a1',
        content: 'step one',
        usage: { inputTokens: 10, outputTokens: 2, costUsd: null },
      }),
      message({
        id: 'a2',
        content: 'step two',
        usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.01 },
      }),
    ];

    const [ui] = storedThreadToUiMessages(rows);

    expect(ui?.metadata).toEqual({
      usage: { inputTokens: 30, outputTokens: 6, costUsd: 0.01 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('sums to a null costUsd only when EVERY merged row has a null/absent cost', () => {
    const rows: StoredMessage[] = [
      message({
        id: 'a1',
        content: 'step one',
        usage: { inputTokens: 10, outputTokens: 2, costUsd: null },
      }),
      message({ id: 'a2', content: 'step two', usage: { inputTokens: 20, outputTokens: 4 } }),
    ];

    const [ui] = storedThreadToUiMessages(rows);

    expect(ui?.metadata).toEqual({
      usage: { inputTokens: 30, outputTokens: 6, costUsd: null },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('omits usage when none of the merged rows carry any, keeping the turn start time', () => {
    const rows: StoredMessage[] = [
      message({ id: 'a1', content: 'step one' }),
      message({ id: 'a2', content: 'step two' }),
    ];

    const [ui] = storedThreadToUiMessages(rows);

    expect(ui?.parts).toEqual([
      { type: 'text', text: 'step one' },
      { type: 'text', text: 'step two' },
    ]);
    expect(ui?.metadata).toEqual({ createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('breaks the group on an interleaved user message — no merge across a user turn', () => {
    const rows: StoredMessage[] = [
      message({ id: 'a1', role: 'assistant', content: 'first answer' }),
      message({ id: 'u1', role: 'user', content: 'follow-up question' }),
      message({ id: 'a2', role: 'assistant', content: 'second answer' }),
    ];

    const ui = storedThreadToUiMessages(rows);

    expect(ui.map((entry) => entry.id)).toEqual(['a1', 'u1', 'a2']);
    expect(ui.every((entry) => !('usage' in ((entry.metadata as object | undefined) ?? {})))).toBe(
      true,
    );
  });

  it('leaves a single-message turn identical to storedMessageToUiMessage (its own usage and time)', () => {
    const row = message({
      id: 'a1',
      content: 'just one step',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });

    const [grouped] = storedThreadToUiMessages([row]);
    const direct = storedMessageToUiMessage(row);

    expect(grouped).toEqual(direct);
    expect(grouped?.metadata).toEqual({
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('passes non-assistant rows through storedMessageToUiMessage unchanged, one row per message', () => {
    const rows: StoredMessage[] = [
      message({ id: 'u1', role: 'user', content: 'hi' }),
      message({ id: 'a1', role: 'assistant', content: 'hello' }),
    ];

    const ui = storedThreadToUiMessages(rows);

    expect(ui).toHaveLength(2);
    expect(ui[0]).toEqual(storedMessageToUiMessage(rows[0] as StoredMessage));
    expect(ui[1]).toEqual(storedMessageToUiMessage(rows[1] as StoredMessage));
  });

  it('merges three consecutive assistant rows into one turn', () => {
    const rows: StoredMessage[] = [
      message({ id: 'a1', content: 'thinking...' }),
      message({
        id: 'a2',
        content: '',
        toolCalls: [{ id: 't1', name: 'executeSql', input: { query: 'SELECT 1' } }],
        toolResults: [{ id: 't1', name: 'executeSql', output: { rows: [] } }],
      }),
      message({ id: 'a3', content: 'done' }),
    ];

    const ui = storedThreadToUiMessages(rows);

    expect(ui).toHaveLength(1);
    expect(ui[0]?.id).toBe('a3');
    expect(ui[0]?.parts).toEqual([
      { type: 'text', text: 'thinking...' },
      {
        type: 'tool-executeSql',
        toolCallId: 't1',
        state: 'output-available',
        input: { query: 'SELECT 1' },
        output: { rows: [] },
      },
      { type: 'text', text: 'done' },
    ]);
  });

  it('returns an empty array for an empty thread', () => {
    expect(storedThreadToUiMessages([])).toEqual([]);
  });
});

describe('a message from another run', () => {
  it('is its own bubble, not the tail of the assistant turn before it', () => {
    const merged = storedThreadToUiMessages([
      message({ id: 'u1', role: 'user', content: 'look into this' }),
      message({
        id: 'a1',
        role: 'assistant',
        content: 'starting the research agent',
        runId: 'run-1',
      }),
      message({ id: 'a2', role: 'assistant', content: 'RESEARCH ANSWER', runId: 'run-child' }),
    ]);
    expect(merged.map((message) => message.id)).toEqual(['u1', 'a1', 'a2']);
  });

  it('still merges two rows of the SAME run, as one turn always has', () => {
    const merged = storedThreadToUiMessages([
      message({ id: 'a1', role: 'assistant', content: 'checking', runId: 'run-1' }),
      message({ id: 'a2', role: 'assistant', content: 'done', runId: 'run-1' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('a2');
  });
});
