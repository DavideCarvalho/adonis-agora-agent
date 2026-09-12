/**
 * A screen for the one thing a remote JSON Schema can do to the process that validates against it.
 *
 * Every validator in the MCP SDK compiles a schema's `pattern` to a native `RegExp`, and JS regex
 * matching backtracks: `(a+)+$` against 27 a's and a non-matching tail takes ~1s, 30 a's ~8s, 40 a's
 * longer than anyone will wait — synchronously, on the only thread the process has. The pattern is
 * written by the remote server and the string is written by the model, which the same server's tool
 * description is free to steer, so the whole thing fits inside one tool definition.
 *
 * What is detected is the shape that makes backtracking EXPONENTIAL: an unbounded repetition whose
 * body can match one piece of text in more than one way, so a failed match has to try every split.
 * It is a structural screen and not a decision procedure — `(ab|abc)+` is ambiguous across
 * alternatives and is not flagged here. A host that needs a guarantee rather than a screen gives
 * `validator` an engine that does not backtrack (AJV's `code.regExp` option takes an RE2 binding).
 */

/** A quantifier, reduced to the two things the analysis below asks about. */
interface Quantifier {
  /** Matches more than one length — `*`, `+`, `?`, `{n,}`, `{n,m}` with n < m. */
  variable: boolean;
  /** Has no upper bound — `*`, `+`, `{n,}`. Only an unbounded repeat backtracks exponentially. */
  unbounded: boolean;
}

interface Atom {
  /** The alternatives inside a group. Undefined for a literal, an escape or a character class. */
  body?: Branch[];
  quantifier?: Quantifier;
}

type Branch = Atom[];

const QUANTIFIER = /^(?:([*+?])|\{(\d+)(,(\d*))?\})/;

/**
 * Enough of a regex parser to see the nesting: alternatives, groups, quantifiers, and one opaque
 * atom for everything else. Anything it does not recognize is a literal, which makes the parse
 * total — a pattern this cannot read comes out as a flat list of tight atoms and is not flagged,
 * rather than throwing where the caller expects a verdict.
 */
class PatternParser {
  private index = 0;

  constructor(private readonly pattern: string) {}

  parse(): Branch[] {
    const branches = this.parseAlternation();
    // A `)` with no `(` — the pattern is not valid, and the compiler is about to say so.
    this.index = this.pattern.length;
    return branches;
  }

  private parseAlternation(): Branch[] {
    const branches: Branch[] = [];
    let branch: Branch = [];
    while (this.index < this.pattern.length) {
      const char = this.pattern[this.index];
      if (char === ')') {
        break;
      }
      if (char === '|') {
        this.index += 1;
        branches.push(branch);
        branch = [];
        continue;
      }
      branch.push(this.parseAtom());
    }
    branches.push(branch);
    return branches;
  }

  private parseAtom(): Atom {
    const char = this.pattern[this.index];
    if (char === '(') {
      this.index += 1;
      this.skipGroupPrefix();
      const body = this.parseAlternation();
      if (this.pattern[this.index] === ')') {
        this.index += 1;
      }
      return this.withQuantifier({ body });
    }
    if (char === '[') {
      this.skipCharacterClass();
      return this.withQuantifier({});
    }
    // An escape is two characters, so `\(` never opens a group and `\\` never escapes the next one.
    this.index += char === '\\' ? 2 : 1;
    return this.withQuantifier({});
  }

  private skipGroupPrefix(): void {
    if (this.pattern[this.index] !== '?') {
      return;
    }
    const closing = this.pattern.indexOf('>', this.index);
    // `(?<name>` — the only prefix whose length is not fixed. Every other one (`?:`, `?=`, `?!`,
    // `?<=`, `?<!`) ends before the first character of the body.
    if (
      this.pattern[this.index + 1] === '<' &&
      !'=!'.includes(this.pattern[this.index + 2] ?? '')
    ) {
      this.index = closing === -1 ? this.pattern.length : closing + 1;
      return;
    }
    this.index += this.pattern[this.index + 1] === '<' ? 3 : 2;
  }

  private skipCharacterClass(): void {
    this.index += 1;
    while (this.index < this.pattern.length && this.pattern[this.index] !== ']') {
      this.index += this.pattern[this.index] === '\\' ? 2 : 1;
    }
    this.index += 1;
  }

  private withQuantifier(atom: Atom): Atom {
    const match = QUANTIFIER.exec(this.pattern.slice(this.index));
    if (match === null) {
      return atom;
    }
    this.index += match[0].length;
    // A trailing `?` makes the repetition lazy, which changes the order the splits are tried and
    // not how many there are.
    if (this.pattern[this.index] === '?') {
      this.index += 1;
    }
    return { ...atom, quantifier: toQuantifier(match) };
  }
}

function toQuantifier(match: RegExpExecArray): Quantifier {
  const symbol = match[1];
  if (symbol !== undefined) {
    return { variable: true, unbounded: symbol !== '?' };
  }
  const min = Number(match[2]);
  const comma = match[3] !== undefined;
  const max =
    match[4] === undefined || match[4] === '' ? Number.POSITIVE_INFINITY : Number(match[4]);
  return {
    variable: comma ? min < max : false,
    unbounded: comma && max === Number.POSITIVE_INFINITY,
  };
}

/** Whether this atom can match more than one length — on its own, or through what it contains. */
function isVariable(atom: Atom): boolean {
  if (atom.quantifier?.variable === true) {
    return true;
  }
  return (atom.body ?? []).some((branch) => branch.some(isVariable));
}

/**
 * Whether repeating these alternatives is ambiguous: one alternative made entirely of parts that
 * can each stretch, so the boundary between two repetitions can fall in more than one place and a
 * failed match has to try all of them. `(a+)` qualifies and `(a+b)` does not — the `b` pins every
 * repetition to one position.
 */
function isAmbiguous(branches: Branch[]): boolean {
  return branches.some((branch) => branch.length > 0 && branch.every(isVariable));
}

function containsUnsafeRepeat(branches: Branch[]): boolean {
  for (const branch of branches) {
    for (const atom of branch) {
      if (atom.body === undefined) {
        continue;
      }
      if (atom.quantifier?.unbounded === true && isAmbiguous(atom.body)) {
        return true;
      }
      if (containsUnsafeRepeat(atom.body)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether this pattern can be made to backtrack exponentially. See the file comment for the limits. */
export function isUnsafeRegex(pattern: string): boolean {
  return containsUnsafeRepeat(new PatternParser(pattern).parse());
}

/**
 * The first pattern anywhere in a JSON Schema that {@link isUnsafeRegex} flags — `pattern` at any
 * depth, and the keys of `patternProperties`, which are regexes too.
 */
export function findUnsafePattern(schema: unknown): string | undefined {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      const found = findUnsafePattern(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof schema !== 'object' || schema === null) {
    return undefined;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && typeof value === 'string') {
      if (isUnsafeRegex(value)) {
        return value;
      }
      continue;
    }
    if (key === 'patternProperties' && typeof value === 'object' && value !== null) {
      const unsafeKey = Object.keys(value).find(isUnsafeRegex);
      if (unsafeKey !== undefined) {
        return unsafeKey;
      }
    }
    const found = findUnsafePattern(value);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
