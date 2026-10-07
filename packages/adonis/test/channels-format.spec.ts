import { describe, expect, it, vi } from 'vitest';
import {
  escapeTelegramMarkdown,
  InMemoryChannelDedupe,
  redisChannelDedupe,
  splitMessage,
  toChannelMarkdown,
  unescapeTelegramMarkdown,
} from '../src/channels/index.js';

describe('toChannelMarkdown', () => {
  const source = [
    '# Your orders',
    '',
    'You have **two** orders, see [the list](https://shop.example/orders).',
    '* first: _pending_',
    '+ second: ~~cancelled~~ `A-2`',
    '',
    '*Order A-1* — paid, 10.00',
  ].join('\n');

  it('whatsapp: bold with one star, links spelled out, bullets as dashes', () => {
    expect(toChannelMarkdown(source, 'whatsapp')).toBe(
      [
        '*Your orders*',
        '',
        'You have *two* orders, see the list (https://shop.example/orders).',
        '- first: _pending_',
        '- second: ~cancelled~ `A-2`',
        '',
        // a component fallback's mrkdwn bold stays bold
        '*Order A-1* — paid, 10.00',
      ].join('\n'),
    );
  });

  it('telegram: MarkdownV2 with every reserved character escaped', () => {
    expect(toChannelMarkdown(source, 'telegram')).toBe(
      [
        '*Your orders*',
        '',
        'You have *two* orders, see [the list](https://shop.example/orders)\\.',
        '• first: _pending_',
        '• second: ~cancelled~ `A-2`',
        '',
        '*Order A\\-1* — paid, 10\\.00',
      ].join('\n'),
    );
  });

  it('none: the words only', () => {
    expect(toChannelMarkdown(source, 'none')).toBe(
      [
        'Your orders',
        '',
        'You have two orders, see the list (https://shop.example/orders).',
        '- first: pending',
        '- second: cancelled A-2',
        '',
        'Order A-1 — paid, 10.00',
      ].join('\n'),
    );
  });

  it('leaves code alone and does not read snake_case or arithmetic as formatting', () => {
    const text = 'Use `user_id` and 2*3*4 in my_var.\n```ts\nconst a_b = 1 * 2;\n```';
    expect(toChannelMarkdown(text, 'whatsapp')).toBe(
      'Use `user_id` and 2*3*4 in my_var.\n```const a_b = 1 * 2;```',
    );
    expect(toChannelMarkdown(text, 'telegram')).toBe(
      'Use `user_id` and 2\\*3\\*4 in my\\_var\\.\n```ts\nconst a_b = 1 * 2;```',
    );
  });

  it('telegram escaping round-trips', () => {
    const text = 'a_b *c* [d](e) 1.5! #tag (x) {y} |z| =w+v- ~t~ >q `r` \\';
    expect(unescapeTelegramMarkdown(escapeTelegramMarkdown(text))).toBe(text);
  });
});

describe('splitMessage', () => {
  it('returns short text as one message', () => {
    expect(splitMessage('  hello  ', 10)).toEqual(['hello']);
  });

  it('cuts at a paragraph break first', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
    expect(splitMessage(text, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)]);
  });

  it('cuts after a sentence when there is no break', () => {
    const text = 'One sentence here. Another sentence follows it. And a third one.';
    const pieces = splitMessage(text, 30);
    expect(pieces[0]).toBe('One sentence here.');
    expect(pieces.every((piece) => piece.length <= 30)).toBe(true);
    expect(pieces.join(' ')).toBe(text);
  });

  it('cuts at a space, and mid-word only when it must', () => {
    expect(splitMessage('alpha beta gamma', 11)).toEqual(['alpha beta', 'gamma']);
    expect(splitMessage('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });

  it('refuses a nonsensical limit', () => {
    expect(() => splitMessage('a', 0)).toThrow(RangeError);
  });
});

describe('dedupe', () => {
  it('in memory: claims once per TTL', () => {
    vi.useFakeTimers();
    try {
      const dedupe = new InMemoryChannelDedupe();
      expect(dedupe.claim('whatsapp:1', 1000)).toBe(true);
      expect(dedupe.claim('whatsapp:1', 1000)).toBe(false);
      expect(dedupe.claim('whatsapp:2', 1000)).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(dedupe.claim('whatsapp:1', 1000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('in memory: forgets the oldest keys past its cap', () => {
    const dedupe = new InMemoryChannelDedupe(2);
    dedupe.claim('a', 60_000);
    dedupe.claim('b', 60_000);
    dedupe.claim('c', 60_000);
    expect(dedupe.claim('a', 60_000)).toBe(true);
    expect(dedupe.claim('c', 60_000)).toBe(false);
  });

  it('redis: SET NX PX', async () => {
    const keys = new Set<string>();
    const calls: unknown[][] = [];
    const redis = {
      async set(...args: [string, string, 'PX', number, 'NX']) {
        calls.push(args);
        if (keys.has(args[0])) return null;
        keys.add(args[0]);
        return 'OK';
      },
    };
    const dedupe = redisChannelDedupe(redis);
    expect(await dedupe.claim('telegram:9', 5000)).toBe(true);
    expect(await dedupe.claim('telegram:9', 5000)).toBe(false);
    expect(calls[0]).toEqual(['agora:channel:dedupe:telegram:9', '1', 'PX', 5000, 'NX']);
  });
});
