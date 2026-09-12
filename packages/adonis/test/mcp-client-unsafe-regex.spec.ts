import { describe, expect, it } from 'vitest';
import { findUnsafePattern, isUnsafeRegex } from '../src/mcp-client/unsafe-regex.js';

describe('isUnsafeRegex', () => {
  it('flags an unbounded quantifier whose body can match the same text more than one way', () => {
    for (const pattern of [
      '(a+)+$',
      '(a*)*',
      '^(\\w+\\s?)*$',
      '(a+|b+)+',
      '((a+))+',
      '(a{1,2})+',
      'x(?:\\s*\\w+)*y',
      '(a+)*',
    ]) {
      expect([pattern, isUnsafeRegex(pattern)]).toEqual([pattern, true]);
    }
  });

  it('leaves the patterns real schemas are written with alone', () => {
    for (const pattern of [
      '^[a-z0-9-]+$',
      '^\\d{3}-\\d{4}$',
      '(a+b)+',
      '^(?:alpha|beta)$',
      '(\\d+\\.\\d+)+',
      '^.{1,64}$',
      '[^/]+(/[^/]+)*',
      '(ab){2,5}',
      '(a+){3}',
      '^\\[[^\\]]*\\]$',
      '',
    ]) {
      expect([pattern, isUnsafeRegex(pattern)]).toEqual([pattern, false]);
    }
  });
});

describe('findUnsafePattern', () => {
  it('finds the pattern wherever in the schema the server put it', () => {
    expect(
      findUnsafePattern({
        type: 'object',
        properties: {
          nested: { type: 'array', items: { type: 'string', pattern: '(a+)+$' } },
        },
      }),
    ).toBe('(a+)+$');
    expect(
      findUnsafePattern({ type: 'object', patternProperties: { '^(x+)+$': { type: 'string' } } }),
    ).toBe('^(x+)+$');
  });

  it('passes a schema whose patterns are all safe', () => {
    expect(
      findUnsafePattern({
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-f0-9]{8}$' } },
        patternProperties: { '^x-': { type: 'string' } },
      }),
    ).toBeUndefined();
  });
});
