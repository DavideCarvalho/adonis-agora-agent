import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type ConsoleSearchGroup,
  getJson,
  moveIndex,
  parseSearchGroups,
  readSwitcherConfig,
} from '../client/console-switcher.js';
import { ConsoleIcon } from './console-switcher-icons.js';

/**
 * Global search (Ctrl/Cmd-K) across this console and every other `@adonis-agora` console the viewer
 * may open: runs and threads here, workflow runs, payments, files, users… in the others.
 */
export function ConsoleSearch() {
  const endpoint = readSwitcherConfig().search?.endpoint;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [endpoint]);

  if (!endpoint) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn search-trigger"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
        Search
        <kbd className="mono">⌘K</kbd>
      </button>
      {open && <SearchDialog endpoint={endpoint} onClose={() => setOpen(false)} />}
    </>
  );
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'done'; groups: ConsoleSearchGroup[] };

function SearchDialog({ endpoint, onClose }: { endpoint: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A press outside the dialog closes it.
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => returnFocus?.focus?.();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setActive(0);
    if (debounced === '') {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    getJson(`${endpoint}?q=${encodeURIComponent(debounced)}`, controller.signal)
      .then((body) => setState({ status: 'done', groups: parseSearchGroups(body) }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [debounced, endpoint]);

  const groups = state.status === 'done' ? state.groups : [];
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      const hit = flat[active];
      if (hit) {
        event.preventDefault();
        window.location.assign(hit.href);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => moveIndex(current, event.key, flat.length));
    }
  };

  let index = -1;
  return (
    <div className="search-overlay">
      <div
        ref={dialogRef}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search consoles"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="Search runs, threads and every console you can open…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={flat.length > 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
        />
        <div id={listId} className="search-results" role="listbox" aria-label="Results">
          {state.status === 'idle' && <div className="search-empty">Type to search.</div>}
          {state.status === 'loading' && <div className="search-empty">Searching…</div>}
          {state.status === 'error' && (
            <div className="search-empty">Search failed. Try again.</div>
          )}
          {state.status === 'done' && groups.length === 0 && (
            <div className="search-empty">No results.</div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="search-group">
              <div className="search-group-title">
                <ConsoleIcon icon={group.icon} size={14} />
                {group.title}
              </div>
              {group.hits.map((hit) => {
                index += 1;
                const position = index;
                return (
                  <a
                    key={`${group.id}-${hit.href}`}
                    id={`${listId}-${position}`}
                    className={`search-hit${position === active ? ' active' : ''}`}
                    role="option"
                    aria-selected={position === active}
                    href={hit.href}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(position)}
                  >
                    <span className="search-hit-title">{hit.title}</span>
                    {hit.subtitle && <span className="search-hit-sub">{hit.subtitle}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
