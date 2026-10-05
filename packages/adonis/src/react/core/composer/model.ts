/** One completion a source offers. */
export interface AutocompleteItem {
  /** Unique within its source. */
  id: string;
  /** What the reader sees, and what the default filter matches against. */
  label: string;
  /** What replaces the typed token. Defaults to `label` — set it when the label is prose. */
  value?: string;
  description?: string;
  /**
   * A short trailing note a renderer right-aligns — where this came from, a keyboard shortcut, a
   * type. Deliberately outside the default filter: typing a query should narrow by what the item
   * IS, not by an aside about it.
   */
  hint?: string;
  /** Whatever the host's renderer needs: an icon key, a scope, the row this came from. */
  data?: unknown;
}

/**
 * Where a trigger character is allowed to open the menu.
 *
 * - `'start'` — only as the very first character of the input. This is the rule a slash command
 *   wants: `/deploy` is a command, `src/foo` and `and/or` are not.
 * - `'word'` — at the start of any word: the input's start, or immediately after whitespace. This
 *   is the rule a mention wants: `@ada` in the middle of a sentence is a mention, `ada@example` is
 *   an address.
 *
 * There is no default on purpose. Which rule a trigger takes is the difference between an
 * autocomplete that feels invisible and one that fires while somebody types a file path.
 */
export type TriggerPosition = 'start' | 'word';

export interface AutocompleteSource {
  /** Identifies the source to the host; also names the listbox when `label` is omitted. */
  id: string;
  /** Human-facing name for the open menu. */
  label?: string;
  /** The single character that opens this source. Two sources never share one. */
  trigger: string;
  position: TriggerPosition;
  /**
   * The candidates for `query`. May be async; a result that arrives after the query moved on is
   * discarded, and `signal` aborts the request that produced it. Throwing is allowed — the menu
   * reports the failure and typing carries on.
   */
  getItems: (
    query: string,
    signal: AbortSignal,
  ) => AutocompleteItem[] | Promise<AutocompleteItem[]>;
  /**
   * Narrow what `getItems` returned. Defaults to {@link filterAutocompleteItems}. A source that
   * already filtered server-side — a fuzzy match this one would undo — passes `(items) => items`.
   */
  filter?: (items: AutocompleteItem[], query: string) => AutocompleteItem[];
  /**
   * Appended after the inserted value. Defaults to a single space, which both closes the menu and
   * puts the caret where the command's argument goes.
   */
  insertSuffix?: string;
}

/** A trigger character found before the caret, with the token being typed after it. */
export interface TriggerMatch {
  source: AutocompleteSource;
  /** Index of the trigger character itself. */
  index: number;
  /** The text between the trigger and the caret. Never contains whitespace. */
  query: string;
}

export interface CompletionEdit {
  text: string;
  caret: number;
}

const WHITESPACE = /\s/;

/**
 * The trigger token the caret currently sits in, or `null`. Scans backwards from the caret and
 * stops at the first whitespace, so a token is always one unbroken word: typing a space is what
 * ends a command and hands the rest of the line back to the user as prose.
 */
export function findActiveTrigger(
  text: string,
  caret: number,
  sources: readonly AutocompleteSource[],
): TriggerMatch | null {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let index = end - 1; index >= 0; index--) {
    const char = text[index];
    if (char === undefined || WHITESPACE.test(char)) {
      return null;
    }
    const source = sources.find((candidate) => candidate.trigger === char);
    // A trigger that fails its own position rule is just a character in the token — `@ad/x` is one
    // mention query, not a command — so the scan continues past it rather than giving up.
    if (source && isAllowedAt(text, index, source.position)) {
      return { source, index, query: text.slice(index + 1, end) };
    }
  }
  return null;
}

function isAllowedAt(text: string, index: number, position: TriggerPosition): boolean {
  if (index === 0) {
    return true;
  }
  if (position === 'start') {
    return false;
  }
  const previous = text[index - 1];
  return previous !== undefined && WHITESPACE.test(previous);
}

/** Case-insensitive substring over label and description. The default when a source names none. */
export function filterAutocompleteItems(
  items: readonly AutocompleteItem[],
  query: string,
): AutocompleteItem[] {
  // An empty needle is a substring of everything, so it needs no branch of its own.
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) ||
      (item.description?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * The text and caret after accepting `item`. The trigger character stays — `/deploy ` is what the
 * user meant to type — and everything after the caret is left untouched, so completing a token in
 * the middle of a sentence does not eat the rest of it.
 */
export function applyCompletion(
  text: string,
  caret: number,
  match: TriggerMatch,
  item: AutocompleteItem,
): CompletionEdit {
  const end = Math.max(match.index, Math.min(caret, text.length));
  const inserted = `${match.source.trigger}${item.value ?? item.label}${match.source.insertSuffix ?? ' '}`;
  return {
    text: text.slice(0, match.index) + inserted + text.slice(end),
    caret: match.index + inserted.length,
  };
}
