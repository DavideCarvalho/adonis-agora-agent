import type { SkillCatalogEntry } from '../../../index.js';
import { type AgentBackend, AgentBackendUnsupportedError } from '../backend.js';
import type { AutocompleteItem, AutocompleteSource } from './model.js';

/** What each item carries on `data`, so a renderer can show where a skill came from. */
export interface SkillSuggestionData {
  /** The scope token it resolved from — the provenance a user is entitled to see. */
  scope: string;
  /** Scope tokens of same-named skills this one outranks, widest last. */
  shadows?: string[];
}

export interface SkillsSourceOptions {
  /** Any backend with `listSkills` — `useAgentBackend()`, or `useAgentChat().backend`. */
  backend: Pick<AgentBackend, 'listSkills'>;
  /**
   * Read at query time, not captured once: a threadless chat learns its id only when the backend
   * creates one on the first send, and a skill may be scoped to a conversation.
   */
  getThreadId?: () => string | undefined;
  /** Default `/`. */
  trigger?: string;
  /** Default `Skills`. */
  label?: string;
}

/**
 * `GET /agent/skills` as an autocomplete source — the concrete one behind `/`, and an example of
 * the shape any other takes. `position: 'start'` because a skill is a command: `/deploy` is one and
 * `src/foo` is a path.
 */
export function createSkillsSource(options: SkillsSourceOptions): AutocompleteSource {
  // One read per thread. The endpoint answers with the whole scope-resolved list rather than a
  // search, so asking again per keystroke would fetch identical rows only to filter them locally.
  // A failed read is forgotten, so the next keystroke retries instead of caching the outage.
  //
  // The order it arrives in IS the precedence — most specific scope first, then alphabetical — and
  // is passed through untouched. The type-ahead filter narrows this list by what the user typed; it
  // never re-derives which skills apply, which is the server's answer and the model's too.
  const byThread = new Map<string, Promise<AutocompleteItem[]>>();

  return {
    id: 'skills',
    label: options.label ?? 'Skills',
    trigger: options.trigger ?? '/',
    position: 'start',
    getItems: () => {
      const threadId = options.getThreadId?.();
      const key = threadId ?? '';
      const cached = byThread.get(key);
      if (cached) {
        return cached;
      }
      const listSkills = options.backend.listSkills;
      if (listSkills === undefined) {
        return Promise.reject(new AgentBackendUnsupportedError('listSkills'));
      }
      const pending = listSkills
        .call(options.backend, threadId)
        .then((entries) => entries.map(toItem))
        .catch((error: unknown) => {
          byThread.delete(key);
          throw error;
        });
      byThread.set(key, pending);
      return pending;
    },
  };
}

function toItem(entry: SkillCatalogEntry): AutocompleteItem {
  const data: SkillSuggestionData = {
    scope: entry.scope,
    ...(entry.shadows !== undefined ? { shadows: entry.shadows } : {}),
  };
  return {
    id: entry.name,
    label: entry.name,
    description: entry.description,
    // `shadows` is present only on a conflict, so saying "overrides" is never noise: without it a
    // user cannot tell "there is no org default" from "there is one and mine wins".
    hint:
      entry.shadows === undefined
        ? entry.scope
        : `${entry.scope} · overrides ${entry.shadows.join(', ')}`,
    data,
  };
}
