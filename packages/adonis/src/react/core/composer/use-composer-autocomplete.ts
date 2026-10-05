import type React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type AutocompleteItem,
  type AutocompleteSource,
  applyCompletion,
  filterAutocompleteItems,
  findActiveTrigger,
  type TriggerMatch,
} from './model.js';

export interface UseComposerAutocompleteOptions {
  /** The composer's draft. Accepting an item rewrites it through `onValueChange`. */
  value: string;
  onValueChange: (next: string) => void;
  /**
   * What can be completed, and after which character. The composer knows nothing about what a
   * source offers — a skills list and an agent mention are the same shape.
   */
  sources: readonly AutocompleteSource[];
  /** A source that threw. The menu reports it; typing is unaffected either way. */
  onError?: (error: unknown, source: AutocompleteSource) => void;
  /** Tab accepts the highlighted item, as Enter does. Default `true`. */
  acceptOnTab?: boolean;
  /** Base for the generated `id`s the ARIA wiring points at. */
  id?: string;
}

export interface AutocompleteInputProps {
  ref: (element: HTMLTextAreaElement | HTMLInputElement | null) => void;
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onClick: (event: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  role: 'combobox';
  'aria-expanded': boolean;
  'aria-autocomplete': 'list';
  'aria-haspopup': 'listbox';
  'aria-controls'?: string;
  'aria-activedescendant'?: string;
}

export interface AutocompleteListboxProps {
  id: string;
  role: 'listbox';
  'aria-label': string;
}

export interface AutocompleteOptionProps {
  id: string;
  role: 'option';
  'aria-selected': boolean;
}

export interface ComposerAutocomplete {
  isOpen: boolean;
  /** The source behind the open menu, so a renderer can group or label by it. */
  source: AutocompleteSource | null;
  trigger: string | null;
  /** The text between the trigger and the caret. */
  query: string;
  items: AutocompleteItem[];
  activeIndex: number;
  activeItem: AutocompleteItem | null;
  /** An async source has been asked and has not answered yet. */
  isLoading: boolean;
  /** The message from a source that threw. The menu stays open and empty. */
  error: string | null;
  highlight: (index: number) => void;
  /** Wraps at both ends, so ↓ from the last item lands on the first. */
  moveHighlight: (delta: number) => void;
  /** Insert an item — the highlighted one by default. A click handler calls this directly. */
  accept: (item?: AutocompleteItem) => void;
  /** Close for the token being typed, without touching the text. */
  dismiss: () => void;
  getInputProps: () => AutocompleteInputProps;
  getListboxProps: () => AutocompleteListboxProps;
  getOptionProps: (index: number) => AutocompleteOptionProps;
}

/**
 * The state machine behind a `/`-style autocomplete in a chat composer: which trigger the caret is
 * inside, what the query is, which items answer it, which one is highlighted, and what accepting
 * one does to the text and the caret. It renders nothing and knows nothing about skills, agents or
 * threads — a host supplies sources, and the same machine drives `@` as drives `/`.
 *
 * The keys the open menu owns (↑ ↓ Enter Tab Escape) are consumed with `preventDefault`, which is
 * how a composer that sends on Enter knows to stand down: call this handler first and return early
 * when the event comes back `defaultPrevented`.
 */
export function useComposerAutocomplete(
  options: UseComposerAutocompleteOptions,
): ComposerAutocomplete {
  const { value, sources, acceptOnTab = true } = options;

  const latest = useRef(options);
  latest.current = options;

  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [items, setItems] = useState<AutocompleteItem[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The trigger index Escape closed. Cleared the moment the caret leaves that token, so deleting
  // the trigger and typing it again offers the menu rather than staying silently dismissed.
  const [dismissedIndex, setDismissedIndex] = useState<number | null>(null);

  // Clamped: a host that resets the draft externally leaves the caret past the end of the text.
  const safeCaret = Math.min(caret, value.length);
  const match = useMemo(
    () => findActiveTrigger(value, safeCaret, sources),
    [value, safeCaret, sources],
  );
  const isActive = match !== null && dismissedIndex !== match.index;

  const matchRef = useRef<TriggerMatch | null>(match);
  matchRef.current = match;
  const caretRef = useRef(safeCaret);
  caretRef.current = safeCaret;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  // Identifies the question being asked, so a re-render that changes neither the source nor the
  // query does not re-ask — an async source would otherwise fetch on every unrelated render. The
  // NUL separator cannot appear in either half, so no pair of them collides.
  const requestKey = isActive && match ? `${match.source.id}\u0000${match.query}` : null;

  useEffect(() => {
    const current = matchRef.current;
    if (requestKey === null || current === null) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    const { source, query } = current;
    const controller = new AbortController();
    // The cleanup below runs before the next query's effect, so a slow answer to an abandoned
    // query finds `superseded` already true and is dropped instead of overwriting a newer list.
    let superseded = false;
    const settle = (next: AutocompleteItem[]) => {
      if (superseded) return;
      setItems((source.filter ?? filterAutocompleteItems)(next, query));
      setActiveIndex(0);
      setLoading(false);
      setError(null);
    };
    const failed = (cause: unknown) => {
      if (superseded) return;
      setItems([]);
      setLoading(false);
      setError(cause instanceof Error ? cause.message : 'Could not load suggestions');
      latest.current.onError?.(cause, source);
    };

    let result: AutocompleteItem[] | Promise<AutocompleteItem[]>;
    try {
      result = source.getItems(query, controller.signal);
    } catch (cause) {
      failed(cause);
      return;
    }
    // A static source answers in the same tick: settling synchronously spares the list a frame of
    // emptiness between the trigger being typed and its items appearing.
    if (!isPromise(result)) {
      settle(result);
      return;
    }
    setLoading(true);
    setError(null);
    result.then(settle, failed);
    return () => {
      superseded = true;
      controller.abort();
    };
  }, [requestKey]);

  // Open the moment the caret is inside a live trigger token, before any items are in: an empty
  // menu that says "no matches" is an answer, whereas a menu that never appears reads as broken.
  // The keys the menu owns are still only taken when there is something to take them for.
  const isOpen = isActive;
  const activeItem = isOpen ? (items[activeIndex] ?? null) : null;

  const reactId = useId();
  const listboxId = options.id ?? `agent-autocomplete-${reactId}`;
  const optionId = useCallback((index: number) => `${listboxId}-option-${index}`, [listboxId]);

  const highlight = useCallback((index: number) => {
    const total = itemsRef.current.length;
    if (total === 0) return;
    setActiveIndex(((index % total) + total) % total);
  }, []);

  const moveHighlight = useCallback(
    (delta: number) => highlight(activeIndexRef.current + delta),
    [highlight],
  );

  const dismiss = useCallback(() => {
    const current = matchRef.current;
    if (current) setDismissedIndex(current.index);
  }, []);

  // Set after an accept and consumed on the next commit: the textarea is controlled, so React
  // writes the new value only once this render lands and any caret set before that is overwritten.
  const pendingCaret = useRef<number | null>(null);

  const accept = useCallback((item?: AutocompleteItem) => {
    const current = matchRef.current;
    if (!current) return;
    const chosen = item ?? itemsRef.current[activeIndexRef.current];
    if (!chosen) return;
    const edit = applyCompletion(latest.current.value, caretRef.current, current, chosen);
    latest.current.onValueChange(edit.text);
    setCaret(edit.caret);
    setDismissedIndex(null);
    pendingCaret.current = edit.caret;
  }, []);

  useLayoutEffect(() => {
    const position = pendingCaret.current;
    if (position === null) return;
    pendingCaret.current = null;
    inputRef.current?.setSelectionRange(position, position);
  });

  const readCaret = useCallback((element: HTMLTextAreaElement | HTMLInputElement) => {
    setCaret(element.selectionStart ?? element.value.length);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!isOpen) return;
      const hasItems = itemsRef.current.length > 0;
      switch (event.key) {
        case 'ArrowDown':
          if (!hasItems) return;
          event.preventDefault();
          moveHighlight(1);
          return;
        case 'ArrowUp':
          if (!hasItems) return;
          event.preventDefault();
          moveHighlight(-1);
          return;
        case 'Enter':
          if (!hasItems) return;
          event.preventDefault();
          accept();
          return;
        case 'Tab':
          // Shift+Tab stays a backwards focus move: a completion menu is not a focus trap.
          if (!acceptOnTab || event.shiftKey || !hasItems) return;
          event.preventDefault();
          accept();
          return;
        case 'Escape':
          event.preventDefault();
          dismiss();
          return;
        default:
          return;
      }
    },
    [isOpen, acceptOnTab, accept, dismiss, moveHighlight],
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      readCaret(event.target);
      // A token the user has walked away from is no longer dismissed — it is gone.
      const next = findActiveTrigger(
        event.target.value,
        event.target.selectionStart ?? event.target.value.length,
        latest.current.sources,
      );
      setDismissedIndex((current) =>
        current !== null && next?.index === current ? current : null,
      );
    },
    [readCaret],
  );

  const onSelect = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      readCaret(event.currentTarget),
    [readCaret],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      readCaret(event.currentTarget),
    [readCaret],
  );

  const setInput = useCallback((element: HTMLTextAreaElement | HTMLInputElement | null) => {
    inputRef.current = element;
  }, []);

  const getInputProps = useCallback(
    (): AutocompleteInputProps => ({
      ref: setInput,
      onChange,
      onKeyDown,
      onSelect,
      onClick,
      role: 'combobox',
      'aria-expanded': isOpen,
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      ...(isOpen ? { 'aria-controls': listboxId } : {}),
      ...(activeItem ? { 'aria-activedescendant': optionId(activeIndex) } : {}),
    }),
    [
      setInput,
      onChange,
      onKeyDown,
      onSelect,
      onClick,
      isOpen,
      listboxId,
      activeItem,
      activeIndex,
      optionId,
    ],
  );

  const getListboxProps = useCallback(
    (): AutocompleteListboxProps => ({
      id: listboxId,
      role: 'listbox',
      'aria-label': match?.source.label ?? match?.source.id ?? 'Suggestions',
    }),
    [listboxId, match],
  );

  const getOptionProps = useCallback(
    (index: number): AutocompleteOptionProps => ({
      id: optionId(index),
      role: 'option',
      'aria-selected': index === activeIndex,
    }),
    [optionId, activeIndex],
  );

  return {
    isOpen,
    source: isOpen && match ? match.source : null,
    trigger: isOpen && match ? match.source.trigger : null,
    query: match?.query ?? '',
    items,
    activeIndex,
    activeItem,
    isLoading,
    error,
    highlight,
    moveHighlight,
    accept,
    dismiss,
    getInputProps,
    getListboxProps,
    getOptionProps,
  };
}

function isPromise<T>(value: T[] | Promise<T[]>): value is Promise<T[]> {
  return typeof (value as Promise<T[]>).then === 'function';
}
