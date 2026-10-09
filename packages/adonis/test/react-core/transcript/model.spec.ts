import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  type AnyToolUIPart,
  buildTranscriptBlocks,
  describeTimestamp,
  describeUsage,
  extractMessageText,
  formatRelativeTime,
  type TranscriptReasoningBlock,
} from '../../../src/react/core/transcript/model.js';

const openAll = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

function tool(id: string): AnyToolUIPart {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    input: {},
    output: {},
  } as AnyToolUIPart;
}

function message(parts: UIMessage['parts'], id = 'm1'): UIMessage {
  return { id, role: 'assistant', parts };
}

describe('buildTranscriptBlocks', () => {
  it('groups consecutive tool parts into one block', () => {
    const blocks = buildTranscriptBlocks(message([tool('a'), tool('b'), tool('c')]), openAll);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('tools');
    expect(blocks[0]?.kind === 'tools' && blocks[0].parts.map((part) => part.toolCallId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it("fills the approval prompt's verb from the input, as the server does", () => {
    const blocks = buildTranscriptBlocks(
      message([
        {
          type: 'tool-purge',
          toolCallId: 'p',
          state: 'approval-requested',
          input: { key: 'sessions' },
        } as unknown as AnyToolUIPart,
      ]),
      {
        ...openAll,
        toolCatalog: {
          purge: {
            label: 'Cache purge',
            running: 'Purging {key}',
            done: 'Purged {key}',
            confirm: { title: 'Purge {key}?', verb: 'Purge {key}' },
          },
        },
      },
    );
    const call = blocks[0]?.kind === 'tools' ? blocks[0].calls[0] : undefined;
    expect(call?.description.confirm).toEqual({
      title: 'Purge sessions?',
      verb: 'Purge sessions',
      detail: null,
    });
  });

  describe('a failed call retried at once', () => {
    const call = (id: string, name: string, state: 'ok' | 'failed' | 'running') =>
      ({
        type: `tool-${name}`,
        toolCallId: id,
        state:
          state === 'ok'
            ? 'output-available'
            : state === 'failed'
              ? 'output-error'
              : 'input-streaming',
        input: {},
        ...(state === 'ok' ? { output: {} } : {}),
        ...(state === 'failed' ? { errorText: 'invalid UI tree' } : {}),
      }) as AnyToolUIPart;
    const ids = (parts: UIMessage['parts'], options = {}) =>
      buildTranscriptBlocks(message(parts), { ...openAll, ...options }).flatMap((block) =>
        block.kind === 'tools' ? block.calls.map((each) => each.toolCallId) : [],
      );

    it('is left out when the same tool then succeeds — across a step boundary too', () => {
      expect(
        ids([
          call('a', 'ui__render', 'failed'),
          { type: 'step-start' },
          call('b', 'ui__render', 'failed'),
          { type: 'step-start' },
          call('c', 'ui__render', 'ok'),
        ]),
      ).toEqual(['c']);
    });

    it('is left out while the retry is still running', () => {
      expect(
        ids([
          call('a', 'ui__render', 'failed'),
          { type: 'step-start' },
          call('b', 'ui__render', 'running'),
        ]),
      ).toEqual(['b']);
    });

    it('stays when the retry failed too, another tool came next, or hiding is off', () => {
      expect(ids([call('a', 'ui__render', 'failed'), call('b', 'ui__render', 'failed')])).toEqual([
        'a',
        'b',
      ]);
      expect(
        ids([
          call('a', 'ui__render', 'failed'),
          call('b', 'search', 'ok'),
          call('c', 'ui__render', 'ok'),
        ]),
      ).toEqual(['a', 'b', 'c']);
      expect(
        ids([call('a', 'ui__render', 'failed'), call('b', 'ui__render', 'ok')], {
          hideRetriedFailures: false,
        }),
      ).toEqual(['a', 'b']);
    });
  });

  it('splits a tool run when text comes between the calls', () => {
    const blocks = buildTranscriptBlocks(
      message([tool('a'), { type: 'text', text: 'thinking out loud' }, tool('b')]),
      openAll,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'text', 'tools']);
  });

  it('splits a tool run at a step boundary', () => {
    const blocks = buildTranscriptBlocks(
      message([tool('a'), { type: 'step-start' }, tool('b')]),
      openAll,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'tools']);
  });

  it('keeps block keys unique per message so a list can key off them', () => {
    const blocks = buildTranscriptBlocks(
      message([{ type: 'text', text: 'one' }, tool('a'), { type: 'text', text: 'two' }, tool('b')]),
      openAll,
    );
    expect(blocks.map((block) => block.key)).toEqual([
      'm1-text-0',
      'm1-tools-0',
      'm1-text-1',
      'm1-tools-1',
    ]);
  });

  it('models a reasoning run as its own block', () => {
    const blocks = buildTranscriptBlocks(
      message([
        { type: 'reasoning', text: 'the user wants X', state: 'done' },
        { type: 'text', text: 'X it is' },
      ]),
      openAll,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['reasoning', 'text']);
    expect(blocks[0]?.kind === 'reasoning' && blocks[0].text).toBe('the user wants X');
  });

  it('opens a streaming reasoning run and folds a finished one', () => {
    const [streaming] = buildTranscriptBlocks(
      message([{ type: 'reasoning', text: 'mid-thought', state: 'streaming' }]),
      openAll,
    ) as TranscriptReasoningBlock[];
    const [done] = buildTranscriptBlocks(
      message([{ type: 'reasoning', text: 'done thinking', state: 'done' }]),
      openAll,
    ) as TranscriptReasoningBlock[];
    expect(streaming?.isOpen).toBe(true);
    expect(done?.isOpen).toBe(false);
  });

  it('routes a reasoning toggle back with the block key', () => {
    const toggled: Array<[string, boolean | undefined]> = [];
    const [block] = buildTranscriptBlocks(
      message([{ type: 'reasoning', text: 'hmm', state: 'done' }]),
      { ...openAll, toggleReasoning: (key, open) => toggled.push([key, open]) },
    ) as TranscriptReasoningBlock[];
    block?.toggle();
    expect(toggled).toEqual([['m1-reasoning-0', undefined]]);
  });

  it('drops a tool run with no parts rather than emitting an empty group', () => {
    const blocks = buildTranscriptBlocks(message([{ type: 'text', text: 'hi' }]), openAll);
    expect(blocks.map((block) => block.kind)).toEqual(['text']);
  });
});

describe('extractMessageText', () => {
  it('joins text parts with a blank line and trims', () => {
    expect(
      extractMessageText([
        { type: 'text', text: '  first' },
        { type: 'text', text: 'second  ' },
      ]),
    ).toBe('first\n\nsecond');
  });

  it('leaves reasoning out of the copyable text', () => {
    expect(
      extractMessageText([
        { type: 'reasoning', text: 'internal monologue', state: 'done' },
        { type: 'text', text: 'the answer' },
      ]),
    ).toBe('the answer');
  });
});

describe('describeUsage', () => {
  it('labels a sub-dollar turn to three decimals and totals the tokens', () => {
    const summary = describeUsage({ inputTokens: 1200, outputTokens: 800, costUsd: 0.0123 });
    expect(summary.totalTokens).toBe(2000);
    expect(summary.tokensLabel).toBe('2.0k tokens');
    expect(summary.costLabel).toBe('$0.012');
  });

  it('keeps a sub-cent cost visible instead of rounding it to zero', () => {
    expect(describeUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0.0004 }).costLabel).toBe(
      '$0.0004',
    );
  });
});

describe('describeTimestamp', () => {
  it('returns null for an unparseable stamp', () => {
    expect(describeTimestamp('not a date')).toBeNull();
    expect(describeTimestamp(null)).toBeNull();
  });

  it('describes a fresh stamp as just now', () => {
    expect(describeTimestamp(new Date().toISOString())?.relative).toBe('just now');
  });
});

describe('formatRelativeTime', () => {
  it('treats a stamp a few seconds in the future as just now', () => {
    expect(formatRelativeTime(new Date(Date.now() + 3_000))).toBe('just now');
  });

  it('falls back to a calendar date beyond a week', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(old)).toBe(
      old.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });
});
