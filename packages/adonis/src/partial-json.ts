/**
 * A JSON document cut off somewhere in the middle — a tool call's arguments while the model is still
 * writing them — read as far as it goes.
 *
 * What it returns is what a reader can trust about the prefix, and no more:
 *  - an object or array whose closing bracket has not arrived is returned with what it holds so far,
 *    and listed in {@link PartialJson.open};
 *  - a string cut mid-way is returned as written so far, and the member holding it is named by
 *    {@link PartialJson.pendingMember} (so `"type": "Car` is never mistaken for a finished `"Car"`);
 *  - a number, `true`, `false` or `null` at the cut is LEFT OUT (`12` may yet be `123`), and so is a
 *    key with no value yet; the member is named by `pendingMember` all the same.
 */
export interface PartialJson {
  /** The value read so far. `undefined` when not even its first character has arrived. */
  value: unknown;
  /** Whether the document is complete: the root value closed (trailing whitespace allowed). */
  complete: boolean;
  /** Is this object or array (one of `value`'s) still open? */
  isOpen(container: object): boolean;
  /** The key (object) or index (array) of `container` whose value is still being written. */
  pendingMember(container: object): string | number | undefined;
}

class Cut extends Error {}

/**
 * Parse a JSON prefix (see {@link PartialJson}). `undefined` when the text is not the beginning of a
 * JSON document at all — a syntax error before the cut.
 */
export function parsePartialJson(text: string): PartialJson | undefined {
  const open = new WeakSet<object>();
  const pending = new WeakMap<object, string | number>();
  let at = 0;

  const skipSpace = () => {
    while (at < text.length) {
      const char = text.charCodeAt(at);
      // space, \t, \n, \r
      if (char === 32 || char === 9 || char === 10 || char === 13) at += 1;
      else break;
    }
  };
  const fail = (): never => {
    throw new SyntaxError(`unexpected character at ${at}`);
  };

  /** A string from the opening quote at `at`. `cut`: the text ended inside it. */
  const readString = (): { value: string; cut: boolean } => {
    at += 1;
    let out = '';
    while (at < text.length) {
      const char = text[at] as string;
      if (char === '"') {
        at += 1;
        return { value: out, cut: false };
      }
      if (char === '\\') {
        const next = text[at + 1];
        if (next === undefined) {
          at = text.length;
          return { value: out, cut: true };
        }
        if (next === 'u') {
          const hex = text.slice(at + 2, at + 6);
          if (hex.length < 4) {
            at = text.length;
            return { value: out, cut: true };
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          at += 6;
          continue;
        }
        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        const escaped = escapes[next];
        if (escaped === undefined) fail();
        out += escaped;
        at += 2;
        continue;
      }
      out += char;
      at += 1;
    }
    return { value: out, cut: true };
  };

  /**
   * One value at `at`. Throws {@link Cut} when the text ends before anything of it can be kept (a
   * number, a literal); a string or container cut mid-way is returned with `cut: true`.
   */
  const readValue = (): { value: unknown; cut: boolean } => {
    skipSpace();
    if (at >= text.length) throw new Cut();
    const char = text[at];
    if (char === '{') return readObject();
    if (char === '[') return readArray();
    if (char === '"') return readString();
    const rest = text.slice(at);
    const number = /^-?\d*(?:\.\d*)?(?:[eE][+-]?\d*)?/.exec(rest)?.[0] ?? '';
    if (number.length > 0) {
      // A number that runs to the end of the text may not be finished (`12` may yet be `123`).
      if (at + number.length >= text.length) throw new Cut();
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) fail();
      at += number.length;
      return { value: Number(number), cut: false };
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (rest.startsWith(word)) {
        at += word.length;
        return { value, cut: false };
      }
      // The beginning of the word, and nothing after it yet.
      if (word.startsWith(rest)) throw new Cut();
    }
    return fail();
  };

  const readObject = (): { value: Record<string, unknown>; cut: boolean } => {
    const object: Record<string, unknown> = {};
    open.add(object);
    at += 1;
    skipSpace();
    if (text[at] === '}') {
      at += 1;
      open.delete(object);
      return { value: object, cut: false };
    }
    for (;;) {
      skipSpace();
      if (at >= text.length) return { value: object, cut: true };
      if (text[at] !== '"') fail();
      const key = readString();
      if (key.cut) return { value: object, cut: true };
      skipSpace();
      if (at >= text.length) {
        pending.set(object, key.value);
        return { value: object, cut: true };
      }
      if (text[at] !== ':') fail();
      at += 1;
      let member: { value: unknown; cut: boolean };
      try {
        member = readValue();
      } catch (error) {
        if (!(error instanceof Cut)) throw error;
        pending.set(object, key.value);
        return { value: object, cut: true };
      }
      object[key.value] = member.value;
      if (member.cut) {
        pending.set(object, key.value);
        return { value: object, cut: true };
      }
      skipSpace();
      if (at >= text.length) return { value: object, cut: true };
      if (text[at] === ',') {
        at += 1;
        continue;
      }
      if (text[at] === '}') {
        at += 1;
        open.delete(object);
        return { value: object, cut: false };
      }
      fail();
    }
  };

  const readArray = (): { value: unknown[]; cut: boolean } => {
    const array: unknown[] = [];
    open.add(array);
    at += 1;
    skipSpace();
    if (text[at] === ']') {
      at += 1;
      open.delete(array);
      return { value: array, cut: false };
    }
    for (;;) {
      let item: { value: unknown; cut: boolean };
      try {
        item = readValue();
      } catch (error) {
        if (!(error instanceof Cut)) throw error;
        pending.set(array, array.length);
        return { value: array, cut: true };
      }
      array.push(item.value);
      if (item.cut) {
        pending.set(array, array.length - 1);
        return { value: array, cut: true };
      }
      skipSpace();
      if (at >= text.length) return { value: array, cut: true };
      if (text[at] === ',') {
        at += 1;
        continue;
      }
      if (text[at] === ']') {
        at += 1;
        open.delete(array);
        return { value: array, cut: false };
      }
      fail();
    }
  };

  let root: { value: unknown; cut: boolean };
  try {
    root = readValue();
  } catch (error) {
    if (error instanceof Cut) root = { value: undefined, cut: true };
    else return undefined;
  }
  skipSpace();
  return {
    value: root.value,
    complete: !root.cut && at >= text.length,
    isOpen: (container) => open.has(container),
    pendingMember: (container) => pending.get(container),
  };
}
