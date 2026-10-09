/**
 * The sandbox's JSX: a small JavaScript + JSX → `React.createElement` transpiler that runs INSIDE
 * the sandbox frame (it is inlined into the frame's document, so the frame stays network-less and
 * needs no `unsafe-eval`), and the partial mode that lets a view the model is still writing be drawn
 * as it streams — only once what has arrived so far closes into something that parses.
 *
 * Every function here is self-contained (no imports, no module state): the frame runtime is built
 * from their source text (`Function.prototype.toString`), so the same code is unit-tested in Node and
 * run in the frame.
 */

/**
 * JavaScript with JSX → plain JavaScript calling `React.createElement`. No TypeScript, no JSX
 * namespaces. `class` and `for` attributes become `className` / `htmlFor`.
 *
 * `partial: true` reads a prefix of a program the model is still writing: an element, attribute,
 * expression or bracket cut off at the end is closed (an attribute or token cut half-way is dropped,
 * back to the last point the code was whole), so the result is a complete program drawing what has
 * arrived. Without it, malformed input throws a `SyntaxError`.
 */
export function transpileJsx(source: string, options?: { partial?: boolean }): string {
  const src = source;
  const n = src.length;
  const partial = options?.partial === true;
  let i = 0;
  /** The last significant token: '' (start), 'val', 'id:<word>' or a punctuation character. */
  let last = '';
  /** A partial read hit the end of the input: every open construct is being closed. */
  let eof = false;
  const EXPR_KEYWORDS = [
    'return',
    'case',
    'typeof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'yield',
    'await',
    'else',
    'do',
    'instanceof',
  ];
  /** Keywords after which the code cannot end. */
  const OPEN_KEYWORDS = [
    'const',
    'let',
    'var',
    'function',
    'if',
    'for',
    'while',
    'switch',
    'new',
    'typeof',
    'in',
    'of',
    'instanceof',
    'class',
    'extends',
    'case',
    'do',
    'else',
    'try',
    'catch',
    'finally',
    'throw',
    'delete',
    'void',
    'await',
    'yield',
    'async',
    'import',
    'export',
  ];
  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    middot: '·',
    times: '×',
    divide: '÷',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
    deg: '°',
    euro: '€',
    larr: '←',
    rarr: '→',
    uarr: '↑',
    darr: '↓',
    check: '✓',
  };
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} (at ${i})`);
  };
  const isIdStart = (c: string | undefined) => c !== undefined && /[A-Za-z_$]/.test(c);
  const isId = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  const exprStart = (): boolean => {
    if (last === '') return true;
    if (last === 'val') return false;
    if (last.startsWith('id:')) return EXPR_KEYWORDS.indexOf(last.slice(3)) >= 0;
    return last !== ')' && last !== ']' && last !== '}';
  };
  /** Can the code end right after the last token (closing what is open)? */
  const complete = (): boolean => {
    if (last === '' || last === 'val' || last === ')' || last === ']' || last === '}') return true;
    if (last === '{' || last === '[' || last === ',' || last === ';') return true;
    if (last.startsWith('id:')) return OPEN_KEYWORDS.indexOf(last.slice(3)) < 0;
    return false;
  };
  const decode = (text: string): string =>
    text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    });
  /** JSX text as React reads it: lines trimmed where they meet, blank lines dropped. */
  const jsxText = (raw: string): string => {
    const lines = raw.split(/\r\n|\n|\r/);
    if (lines.length === 1) return decode(raw);
    const kept: string[] = [];
    lines.forEach((line, index) => {
      let value = line;
      if (index > 0) value = value.replace(/^\s+/, '');
      if (index < lines.length - 1) value = value.replace(/\s+$/, '');
      if (value !== '') kept.push(value);
    });
    return decode(kept.join(' '));
  };
  const propKey = (name: string): string => {
    const mapped = name === 'class' ? 'className' : name === 'for' ? 'htmlFor' : name;
    return /^[A-Za-z_$][\w$]*$/.test(mapped) ? mapped : JSON.stringify(mapped);
  };
  const skipWs = () => {
    while (i < n && /\s/.test(src[i] as string)) i++;
  };

  /** A quoted string. `null` when a partial read ends inside it. */
  const str = (quote: string): string | null => {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) {
        const text = src.slice(i, j + 1);
        i = j + 1;
        return text;
      }
      if (c === '\n') fail('Unterminated string');
      j++;
    }
    if (partial) {
      eof = true;
      i = n;
      return null;
    }
    return fail('Unterminated string');
  };

  /** A template literal, its `${…}` read as code (JSX included). `null` when cut off. */
  const template = (): string | null => {
    let out = '`';
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return `${out}\``;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        const saved = last;
        last = '';
        const inner = js(true);
        last = saved;
        if (eof) return null;
        out += `\${${inner}}`;
        i++;
        continue;
      }
      out += c;
      i++;
    }
    if (partial) {
      eof = true;
      return null;
    }
    return fail('Unterminated template');
  };

  /** A regular expression literal. `null` when cut off. */
  const regex = (): string | null => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') fail('Unterminated regular expression');
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') inClass = true;
      else if (c === '/') {
        j++;
        while (j < n && /[a-z]/.test(src[j] as string)) j++;
        const text = src.slice(i, j);
        i = j;
        return text;
      }
      j++;
    }
    if (partial) {
      eof = true;
      i = n;
      return null;
    }
    return fail('Unterminated regular expression');
  };

  /** `{ … }` inside JSX: an expression, read as code. `null` when cut off with nothing whole in it. */
  const braced = (): string | null => {
    i++;
    const saved = last;
    last = '';
    const inner = js(true);
    last = saved;
    if (eof) return inner.trim() === '' ? null : inner;
    i++;
    return inner;
  };

  const create = (tag: string, props: string, children: string[]): string =>
    `React.createElement(${tag}, ${props}${children.length > 0 ? `, ${children.join(', ')}` : ''})`;

  /** One JSX element (or fragment), at its `<`. `null` when a partial read cut its name. */
  const element = (): string | null => {
    i++;
    skipWs();
    let raw = '';
    let tag = 'React.Fragment';
    const segments: string[] = [];
    let pairs: string[] = [];
    const flush = () => {
      if (pairs.length > 0) segments.push(`{${pairs.join(', ')}}`);
      pairs = [];
    };
    const props = () => {
      flush();
      if (segments.length === 0) return 'null';
      if (segments.length === 1 && (segments[0] as string).startsWith('{'))
        return segments[0] as string;
      return `Object.assign({}, ${segments.join(', ')})`;
    };
    if (src[i] === '>') {
      i++;
    } else {
      let j = i;
      while (j < n && /[\w$.:-]/.test(src[j] as string)) j++;
      raw = src.slice(i, j);
      if (j >= n && partial) {
        eof = true;
        i = n;
        return null;
      }
      if (raw === '') fail('Expected a tag name');
      i = j;
      tag = /^[a-z][\w-]*$/.test(raw) ? JSON.stringify(raw) : raw;
      for (;;) {
        skipWs();
        if (i >= n) {
          if (partial) {
            eof = true;
            return create(tag, props(), []);
          }
          fail('Unterminated JSX tag');
        }
        if (src[i] === '/' && src[i + 1] === '>') {
          i += 2;
          return create(tag, props(), []);
        }
        if (src[i] === '/' && i + 1 >= n && partial) {
          eof = true;
          i = n;
          return create(tag, props(), []);
        }
        if (src[i] === '>') {
          i++;
          break;
        }
        if (src[i] === '{') {
          const start = i;
          i++;
          skipWs();
          if (src.slice(i, i + 3) !== '...') {
            if (partial && i + 3 > n) {
              eof = true;
              i = n;
              return create(tag, props(), []);
            }
            i = start;
            fail('Expected a spread attribute');
          }
          i += 3;
          const saved = last;
          last = '';
          const spread = js(true);
          last = saved;
          if (eof) return create(tag, props(), []);
          i++;
          flush();
          segments.push(spread);
          continue;
        }
        let k = i;
        while (k < n && /[\w$:-]/.test(src[k] as string)) k++;
        const name = src.slice(i, k);
        if (name === '') fail('Expected an attribute');
        i = k;
        skipWs();
        if (i >= n && partial) {
          eof = true;
          return create(tag, props(), []);
        }
        if (src[i] !== '=') {
          pairs.push(`${propKey(name)}: true`);
          continue;
        }
        i++;
        skipWs();
        const quote = src[i];
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, i + 1);
          if (end < 0) {
            if (partial) {
              eof = true;
              i = n;
              return create(tag, props(), []);
            }
            fail('Unterminated attribute');
          }
          pairs.push(`${propKey(name)}: ${JSON.stringify(decode(src.slice(i + 1, end)))}`);
          i = end + 1;
          continue;
        }
        if (quote === '{') {
          const value = braced();
          // A value cut off is not the value: the attribute waits until it is whole.
          if (eof) return create(tag, props(), []);
          pairs.push(`${propKey(name)}: ${(value ?? '').trim()}`);
          continue;
        }
        if (quote === '<') {
          const value = element();
          if (value !== null) pairs.push(`${propKey(name)}: ${value}`);
          if (eof) return create(tag, props(), []);
          continue;
        }
        if (i >= n && partial) {
          eof = true;
          return create(tag, props(), []);
        }
        fail('Expected an attribute value');
      }
    }
    const children: string[] = [];
    for (;;) {
      if (i >= n) {
        if (partial) {
          eof = true;
          return create(tag, props(), children);
        }
        fail('Unterminated JSX element');
      }
      if (src[i] === '<' && (src[i + 1] === '/' || (i + 1 >= n && partial))) {
        const close = src.indexOf('>', i);
        if (close < 0) {
          if (partial) {
            eof = true;
            i = n;
            return create(tag, props(), children);
          }
          fail('Unterminated closing tag');
        }
        const name = src.slice(i + 2, close).trim();
        if (name !== raw) fail(`Expected </${raw}>, found </${name}>`);
        i = close + 1;
        return create(tag, props(), children);
      }
      if (src[i] === '<') {
        const child = element();
        if (child !== null) children.push(child);
        if (eof) return create(tag, props(), children);
        continue;
      }
      if (src[i] === '{') {
        const value = braced();
        if (value !== null && value.replace(/\/\*[\s\S]*?\*\//g, '').trim() !== '')
          children.push(value);
        if (eof) return create(tag, props(), children);
        continue;
      }
      let j = i;
      while (j < n && src[j] !== '<' && src[j] !== '{') j++;
      // A partial read never shows half an entity.
      let rawText = src.slice(i, j);
      if (j >= n && partial) rawText = rawText.replace(/&[#\w]*$/, '');
      const text = jsxText(rawText);
      if (text !== '') children.push(JSON.stringify(text));
      i = j;
    }
  };

  /**
   * Code, until the end (or, for an embedded expression, the `}` that closes it — not consumed).
   * A partial read ending here closes the brackets still open, after going back to the last token
   * the code could end on.
   */
  function js(stopAtBrace: boolean): string {
    let out = '';
    const stack: string[] = [];
    let safeLength = 0;
    let safeStack: string[] = [];
    /** The code may end right here (closing what is open). */
    let whole = true;
    const mark = (ok = true) => {
      whole = ok && complete();
      if (whole) {
        safeLength = out.length;
        safeStack = stack.slice();
      }
    };
    const closing = (open: string) => (open === '{' ? '}' : open === '(' ? ')' : ']');
    const finish = (): string => {
      const body = whole ? out : out.slice(0, safeLength);
      const open = whole ? stack : safeStack;
      return body + open.slice().reverse().map(closing).join('');
    };
    while (i < n) {
      const c = src[i] as string;
      if (c === '}' && stack.length === 0 && stopAtBrace) return out;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        out += c;
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? n : end;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) {
          if (partial) {
            eof = true;
            i = n;
            break;
          }
          fail('Unterminated comment');
        }
        out += src.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const text = str(c);
        if (text === null) break;
        out += text;
        last = 'val';
        mark();
        continue;
      }
      if (c === '`') {
        const text = template();
        if (text === null) break;
        out += text;
        last = 'val';
        mark();
        continue;
      }
      if (c === '/' && exprStart()) {
        const text = regex();
        if (text === null) break;
        out += text;
        last = 'val';
        mark();
        continue;
      }
      if (
        c === '<' &&
        exprStart() &&
        (isIdStart(src[i + 1]) || src[i + 1] === '>' || (partial && i + 1 >= n))
      ) {
        if (i + 1 >= n) {
          eof = true;
          i = n;
          break;
        }
        const jsx = element();
        if (jsx !== null) {
          out += jsx;
          last = 'val';
          mark();
        }
        if (eof) break;
        continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isId(src[j])) j++;
        if (j >= n && partial) {
          // The word may be cut (`ret` of `return`): it does not count until something follows.
          eof = true;
          i = n;
          break;
        }
        const word = src.slice(i, j);
        out += word;
        i = j;
        last = `id:${word}`;
        mark();
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
        let j = i + 1;
        while (j < n && /[\w.]/.test(src[j] as string)) j++;
        if (j >= n && partial) {
          eof = true;
          i = n;
          break;
        }
        out += src.slice(i, j);
        i = j;
        last = 'val';
        mark();
        continue;
      }
      // Whether the code may end right after this bracket: `[` opening an array literal and `(`
      // opening a call may (`[]`, `f()`); `v[`, a grouping `(`, `if (` and an empty `()` (arrow
      // parameters still to come) may not.
      let ok = true;
      if (c === '[') ok = exprStart();
      else if (c === '(') {
        const keyword = last.startsWith('id:') ? last.slice(3) : '';
        ok =
          !exprStart() &&
          ['if', 'for', 'while', 'switch', 'catch', 'function', 'with'].indexOf(keyword) < 0;
      } else if (c === ')') ok = last !== '(';
      if (c === '{' || c === '(' || c === '[') stack.push(c);
      else if (c === '}' || c === ')' || c === ']') stack.pop();
      out += c;
      i++;
      last = c;
      mark(ok);
    }
    if (i >= n && partial) {
      eof = true;
      return finish();
    }
    if (stopAtBrace) fail('Unexpected end of input');
    return out;
  }

  return js(false);
}

/**
 * A sandbox program as the model writes it, made runnable in the frame: `import` lines dropped (the
 * kit, React and its hooks are already in scope) and `export` / `export default` taken off the
 * declarations — `export default function App()` is `function App()`.
 */
export function prepareSandboxJsx(source: string): string {
  return source
    .replace(/^\s*import\s[^;\n]*(?:from\s*['"][^'"\n]*['"])?\s*;?[ \t]*$/gm, '')
    .replace(/^(\s*)export\s+default\s+(?=(async\s+)?function|class)/gm, '$1')
    .replace(/^(\s*)export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm, '$1')
    .replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/gm, '$1');
}
