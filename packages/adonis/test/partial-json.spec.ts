import { describe, expect, it } from 'vitest';
import { parsePartialJson } from '../src/partial-json.js';

const parse = (text: string) => parsePartialJson(text);

describe('parsePartialJson', () => {
  it('reads a complete document as JSON.parse does', () => {
    const text = JSON.stringify({ a: [1, -2.5e3, true, false, null, 'x\n"y"é'], b: {} });
    const parsed = parse(`  ${text}  `);
    expect(parsed?.value).toEqual(JSON.parse(text));
    expect(parsed?.complete).toBe(true);
  });

  it('keeps what an open object or array holds, and says which containers are open', () => {
    const parsed = parse('{"type":"Card","props":{"title":"Sal');
    const value = parsed?.value as { type: string; props: { title: string } };
    expect(value).toEqual({ type: 'Card', props: { title: 'Sal' } });
    expect(parsed?.complete).toBe(false);
    expect(parsed?.isOpen(value)).toBe(true);
    expect(parsed?.isOpen(value.props)).toBe(true);
    // The string being written is named, so a reader knows `Sal` is not final.
    expect(parsed?.pendingMember(value.props)).toBe('title');
    expect(parsed?.pendingMember(value)).toBe('props');
  });

  it('names a type string cut mid-way, and not a finished one', () => {
    const cut = parse('{"type":"Car');
    expect(cut?.value).toEqual({ type: 'Car' });
    expect(cut?.pendingMember(cut.value as object)).toBe('type');
    const done = parse('{"type":"Card",');
    expect(done?.pendingMember(done.value as object)).toBeUndefined();
  });

  it('leaves out numbers and literals at the cut, and keys with no value yet', () => {
    expect(parse('{"a":12')?.value).toEqual({});
    expect(parse('{"a":12,')?.value).toEqual({ a: 12 });
    expect(parse('{"a":-')?.value).toEqual({});
    expect(parse('{"a":1.')?.value).toEqual({});
    expect(parse('{"a":1e')?.value).toEqual({});
    expect(parse('{"a":tr')?.value).toEqual({});
    expect(parse('{"a":true')?.value).toEqual({ a: true });
    expect(parse('{"a":nul')?.value).toEqual({});
    expect(parse('{"a"')?.value).toEqual({});
    expect(parse('{"a":')?.value).toEqual({});
    expect(parse('{"ke')?.value).toEqual({});
    const array = parse('[1,2,3');
    expect(array?.value).toEqual([1, 2]);
    expect(array?.pendingMember(array.value as object)).toBe(2);
  });

  it('handles escapes cut mid-way', () => {
    expect(parse('"ab\\')?.value).toBe('ab');
    expect(parse('"ab\\u00')?.value).toBe('ab');
    expect(parse('"ab\\u00e9')?.value).toBe('abé');
    expect(parse('"a\\"b')?.value).toBe('a"b');
  });

  it('reads nested children arrays as they grow', () => {
    const parsed = parse('{"type":"Stack","children":[{"type":"Chart","props":{}},{"type":"Ta');
    const value = parsed?.value as { children: Array<Record<string, unknown>> };
    expect(value.children).toHaveLength(2);
    expect(parsed?.isOpen(value.children)).toBe(true);
    expect(parsed?.isOpen(value.children[0] as object)).toBe(false);
    expect(parsed?.isOpen(value.children[1] as object)).toBe(true);
  });

  it('answers undefined for an empty prefix and for text that is not JSON', () => {
    expect(parse('')?.value).toBeUndefined();
    expect(parse('   ')?.complete).toBe(false);
    expect(parse('{"a" 1}')).toBeUndefined();
    expect(parse('{a:1}')).toBeUndefined();
    expect(parse('[1 2]')).toBeUndefined();
    expect(parse('nope')).toBeUndefined();
  });

  it('agrees with JSON.parse on every prefix of a real tree, closed or not', () => {
    const tree = {
      type: 'Card',
      props: { title: 'Sales "dashboard"', n: 1234.5 },
      children: [
        { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k', up: true }] } },
        { type: 'Chart', props: { data: [{ month: 'Jan', revenue: 1200 }] } },
      ],
    };
    const text = JSON.stringify(tree, null, 1);
    for (let cut = 0; cut <= text.length; cut += 1) {
      const parsed = parse(text.slice(0, cut));
      expect(parsed, `prefix ${cut}`).toBeDefined();
    }
    expect(parse(text)?.value).toEqual(tree);
  });
});
