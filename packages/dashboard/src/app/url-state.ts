import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { splitHash } from '../agora-kit/url-state/hash-url.js';
import type { TrendMetric } from '../client/trend-path.js';

/**
 * The console's view state in the URL (`#<page>[/<id>]?<query>`, through the kit's
 * `NuqsHashAdapter`). Every param drops out of the URL at its default, so a page opened from a
 * plain `#<page>` link looks exactly as before.
 */

/** The params the topbar owns (the day range), carried along when moving between pages. */
export const SHARED_KEYS = ['from', 'to'] as const;

/** The current hash's query, keeping only the {@link SHARED_KEYS} (`from=…&to=…`). */
export function sharedSearch(hash: string): string {
  const current = new URLSearchParams(splitHash(hash).search);
  const kept = new URLSearchParams();
  for (const key of SHARED_KEYS) {
    const value = current.get(key);
    if (value !== null) kept.set(key, value);
  }
  return kept.toString();
}

/** `#<path>` + `?<search>` (no dangling `?`). */
export function hashWith(path: string, search: string): string {
  return search === '' ? `#${path}` : `#${path}?${search}`;
}

/** The chart's metric (`?metric=totalTokens`); cost is the default. Picking one adds a history entry. */
export function useMetricParam() {
  return useQueryState(
    'metric',
    parseAsStringLiteral(['costUsd', 'totalTokens'] satisfies TrendMetric[])
      .withDefault('costUsd')
      .withOptions({ history: 'push' }),
  );
}
