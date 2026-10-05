import { useEffect, useMemo, useState } from 'react';
import {
  GENUI_TREE_COMPONENT,
  type GenerativeUIItem,
  type GenerativeUIOptions,
  type GenerativeUIState,
  type GenuiCatalogLike,
  type GenuiIssueLike,
  type GenuiRegistry,
  type GenuiRenderer,
  type ResolveComponent,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize whatever carries a pushed component: a transcript `ui` block, a `data-ui` message part
 * (`{ type: 'data-ui', id, data }`), a stored `{ id, component, props, version? }` entry. `null` for
 * anything else.
 */
export function toGenerativeUIItem(part: unknown): GenerativeUIItem | null {
  if (!isRecord(part)) return null;
  const source = part.type === 'data-ui' && isRecord(part.data) ? part.data : part;
  if (typeof source.component !== 'string') return null;
  const id =
    typeof source.id === 'string' ? source.id : typeof part.id === 'string' ? part.id : null;
  if (id === null) return null;
  return {
    id,
    component: source.component,
    ...(isRecord(source.componentVersions) &&
    Object.values(source.componentVersions).every(
      (version) => typeof version === 'number' && Number.isSafeInteger(version) && version > 0,
    )
      ? { componentVersions: { ...source.componentVersions } as Record<string, number> }
      : {}),
    ...(typeof source.fallbackText === 'string' ? { fallbackText: source.fallbackText } : {}),
    props: isRecord(source.props) ? source.props : {},
    version: typeof source.version === 'number' ? source.version : null,
    toolCallId: typeof source.toolCallId === 'string' ? source.toolCallId : null,
  };
}

type Resolution =
  | { status: 'ready'; Component: GenuiRenderer }
  | { status: 'loading' }
  | { status: 'unknown' }
  | { status: 'error'; error: unknown };

interface CacheEntry {
  resolution: Resolution;
  settled: Promise<void> | null;
}

const resolverCaches = new WeakMap<ResolveComponent, Map<string, CacheEntry>>();

function resolveCached(
  resolve: ResolveComponent,
  name: string,
  version: number | null,
): CacheEntry {
  let cache = resolverCaches.get(resolve);
  if (cache === undefined) {
    cache = new Map();
    resolverCaches.set(resolve, cache);
  }
  const key = `${name}@${version ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let entry: CacheEntry;
  try {
    const result = resolve(name, version);
    if (result instanceof Promise) {
      entry = { resolution: { status: 'loading' }, settled: null };
      entry.settled = result.then(
        (Component) => {
          entry.resolution = Component ? { status: 'ready', Component } : { status: 'unknown' };
        },
        (error: unknown) => {
          entry.resolution = { status: 'error', error };
        },
      );
    } else {
      entry = {
        resolution: result ? { status: 'ready', Component: result } : { status: 'unknown' },
        settled: null,
      };
    }
  } catch (error) {
    entry = { resolution: { status: 'error', error }, settled: null };
  }
  cache.set(key, entry);
  return entry;
}

/**
 * Which renderer draws `name`: the registry first, then `resolveComponent` (cached; async results
 * re-render the caller when they land). `fallbackTree` answers the tree component when the
 * registry does not override it.
 */
export function useResolvedComponent(
  name: string,
  version: number | null,
  registry: GenuiRegistry,
  resolve: ResolveComponent | undefined,
  fallbackTree?: GenuiRenderer,
): Resolution {
  const [, setTick] = useState(0);
  const own = registry[name];
  const entry =
    own !== undefined || resolve === undefined ? null : resolveCached(resolve, name, version);
  const pending = entry?.resolution.status === 'loading' ? entry.settled : null;
  useEffect(() => {
    if (pending === null) return;
    let live = true;
    void pending.then(() => {
      if (live) setTick((tick) => tick + 1);
    });
    return () => {
      live = false;
    };
  }, [pending]);
  if (own !== undefined) return { status: 'ready', Component: own };
  if (entry !== null && entry.resolution.status !== 'unknown') return entry.resolution;
  if (name === GENUI_TREE_COMPONENT && fallbackTree !== undefined) {
    return { status: 'ready', Component: fallbackTree };
  }
  return { status: 'unknown' };
}

type Validation =
  | { status: 'ok'; props: Record<string, unknown> }
  | { status: 'pending' }
  | { status: 'invalid'; issues: GenuiIssueLike[] };

/**
 * Props checked against the catalog: synchronously when the catalog can (`validateSync`), else
 * after the async check settles. A component the catalog does not know passes through unchecked.
 */
export function useValidatedProps(
  catalog: GenuiCatalogLike | undefined,
  name: string,
  props: Record<string, unknown>,
): Validation {
  const checked = catalog?.has(name) === true;
  const immediate = useMemo<Validation | null>(() => {
    if (!checked || catalog === undefined) return { status: 'ok', props };
    const result = catalog.validateSync?.(name, props);
    if (result === undefined) return null;
    return result.ok
      ? { status: 'ok', props: result.value }
      : { status: 'invalid', issues: result.issues };
  }, [checked, catalog, name, props]);
  const [late, setLate] = useState<{ props: Record<string, unknown>; result: Validation } | null>(
    null,
  );
  useEffect(() => {
    if (immediate !== null || catalog === undefined) return;
    let live = true;
    catalog.validate(name, props).then(
      (result) => {
        if (!live) return;
        setLate({
          props,
          result: result.ok
            ? { status: 'ok', props: result.value }
            : { status: 'invalid', issues: result.issues },
        });
      },
      (error: unknown) => {
        if (!live) return;
        setLate({
          props,
          result: {
            status: 'invalid',
            issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
          },
        });
      },
    );
    return () => {
      live = false;
    };
  }, [immediate, catalog, name, props]);
  if (immediate !== null) return immediate;
  return late !== null && late.props === props ? late.result : { status: 'pending' };
}

/** {@link import('./generative-ui.js').useGenerativeUI}, with the tree renderer handed in (avoids an import cycle). */
export function useGenerativeUIState(
  part: unknown,
  options: GenerativeUIOptions,
  fallbackTree: GenuiRenderer | undefined,
): GenerativeUIState | null {
  const item = useMemo(() => toGenerativeUIItem(part), [part]);
  const name = item?.component ?? '';
  const definition = options.catalog?.get?.(name);
  const incompatible =
    item?.fallbackText !== undefined &&
    item.version !== null &&
    definition !== undefined &&
    item.version !== (definition.version ?? 1);
  const resolution = useResolvedComponent(
    name,
    item?.version ?? null,
    incompatible ? {} : options.registry,
    item === null ? undefined : options.resolveComponent,
    fallbackTree,
  );
  const empty = useMemo<Record<string, unknown>>(() => ({}), []);
  // A tree is validated node by node as it renders, not as one component.
  const validation = useValidatedProps(
    item === null || name === GENUI_TREE_COMPONENT || incompatible ? undefined : options.catalog,
    name,
    item?.props ?? empty,
  );
  if (item === null) return null;
  if (
    name === GENUI_TREE_COMPONENT &&
    item.fallbackText !== undefined &&
    (!isRecord(item.props.root) || typeof item.props.root.type !== 'string')
  )
    return {
      status: 'problem',
      reason: 'invalid',
      item,
      issues: [{ path: ['root'], message: 'Invalid UI tree root' }],
    };
  if (resolution.status === 'loading') return { status: 'loading', item };
  if (resolution.status === 'unknown') return { status: 'problem', reason: 'unknown', item };
  if (resolution.status === 'error') {
    return { status: 'problem', reason: 'error', item, error: resolution.error };
  }
  if (validation.status === 'pending') return { status: 'loading', item };
  if (validation.status === 'invalid') {
    return { status: 'problem', reason: 'invalid', item, issues: validation.issues };
  }
  return { status: 'ready', item, Component: resolution.Component, props: validation.props };
}
