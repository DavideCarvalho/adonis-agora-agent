/**
 * The small part of Structured Field Values (RFC 9651) this client needs: Dictionaries and Lists of
 * Strings, Integers, Tokens and Booleans, with parameters. `Poppy-Extensions` is a List, and the
 * operations extension's `Poppy-Approval` and `Poppy-Operation` are Dictionaries.
 */

export type BareItem = string | number | boolean | { token: string };

export interface SfItem {
  value: BareItem;
  params: Record<string, BareItem>;
}

const KEY_RE = /^[a-z*][a-z0-9_.*-]*$/;

/** A String as RFC 9651 section 4.1.6 writes it: printable ASCII, `"` and `\` escaped. */
export function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new TypeError('a Structured Field String holds printable ASCII only');
  }
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function serializeBare(value: BareItem): string {
  if (typeof value === 'string') return sfString(value);
  if (typeof value === 'boolean') return value ? '?1' : '?0';
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > 999_999_999_999_999) {
      throw new TypeError('a Structured Field Integer has at most 15 digits');
    }
    return String(value);
  }
  return value.token;
}

/** Serializes a Dictionary whose members are bare items (RFC 9651 section 4.1.2). */
export function serializeDictionary(members: Record<string, BareItem | undefined>): string {
  return Object.entries(members)
    .filter((e): e is [string, BareItem] => e[1] !== undefined)
    .map(([key, value]) => {
      if (!KEY_RE.test(key)) throw new TypeError(`bad Structured Field key ${key}`);
      return value === true ? key : `${key}=${serializeBare(value)}`;
    })
    .join(', ');
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  fail(): never {
    throw new SyntaxError('invalid Structured Field');
  }
  sp() {
    while (this.s[this.i] === ' ') this.i++;
  }
  ows() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }
  key(): string {
    const m = /[a-z*][a-z0-9_.*-]*/y;
    m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) this.fail();
    this.i = m.lastIndex;
    return r[0];
  }
  bare(): BareItem {
    const c = this.s[this.i];
    if (c === '"') {
      let out = '';
      this.i++;
      for (;;) {
        const ch = this.s[this.i++];
        if (ch === undefined) this.fail();
        if (ch === '\\') {
          const next = this.s[this.i++];
          if (next !== '"' && next !== '\\') this.fail();
          out += next;
        } else if (ch === '"') {
          return out;
        } else if (ch < ' ' || ch > '~') {
          this.fail();
        } else {
          out += ch;
        }
      }
    }
    if (c === '?') {
      const b = this.s[this.i + 1];
      if (b !== '0' && b !== '1') this.fail();
      this.i += 2;
      return b === '1';
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      const m = /-?\d{1,15}(?:\.\d{1,3})?/y;
      m.lastIndex = this.i;
      const r = m.exec(this.s);
      if (!r) this.fail();
      this.i = m.lastIndex;
      return Number(r[0]);
    }
    if (c === ':') {
      const end = this.s.indexOf(':', this.i + 1);
      if (end === -1) this.fail();
      const b64 = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return { token: `:${b64}:` };
    }
    const m = /[A-Za-z*][A-Za-z0-9:/!#$%&'*+.^_`|~-]*/y;
    m.lastIndex = this.i;
    const r = m.exec(this.s);
    if (!r) this.fail();
    this.i = m.lastIndex;
    return { token: r[0] };
  }
  params(): Record<string, BareItem> {
    const out: Record<string, BareItem> = {};
    while (this.s[this.i] === ';') {
      this.i++;
      this.sp();
      const k = this.key();
      let v: BareItem = true;
      if (this.s[this.i] === '=') {
        this.i++;
        v = this.bare();
      }
      out[k] = v;
    }
    return out;
  }
  item(): SfItem {
    if (this.s[this.i] === '(') this.fail(); // Inner Lists aren't used here.
    const value = this.bare();
    return { value, params: this.params() };
  }
  /** After a member: the end, or a comma and another member. */
  next(): boolean {
    this.ows();
    if (this.i >= this.s.length) return false;
    if (this.s[this.i] !== ',') this.fail();
    this.i++;
    this.ows();
    if (this.i >= this.s.length) this.fail();
    return true;
  }
}

/**
 * Parses a Dictionary (RFC 9651 section 4.2.2). Throws `SyntaxError` on a malformed one: the whole
 * field is then ignored, as section 4.2 says.
 */
export function parseDictionary(input: string): Map<string, SfItem> {
  const p = new Parser(input.trim());
  const out = new Map<string, SfItem>();
  if (p.s === '') return out;
  do {
    const key = p.key();
    if (p.s[p.i] === '=') {
      p.i++;
      out.set(key, p.item());
    } else {
      out.set(key, { value: true, params: p.params() });
    }
  } while (p.next());
  return out;
}

/** Parses a List of Items (RFC 9651 section 4.2.1). */
export function parseList(input: string): SfItem[] {
  const p = new Parser(input.trim());
  const out: SfItem[] = [];
  if (p.s === '') return out;
  do {
    out.push(p.item());
  } while (p.next());
  return out;
}
