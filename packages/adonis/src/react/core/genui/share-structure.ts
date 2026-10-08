function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `next`, with every part structurally equal to the same part of `previous` replaced by that part
 * of `previous` — `previous` itself when the two are equal throughout. Plain objects and arrays are
 * compared member by member (arrays by position); anything else by `Object.is`.
 *
 * The chat reaches React as a fresh deep copy on every update (the AI SDK clones the streaming
 * message on each chunk), so a pushed component's props and a tree's nodes are new objects on every
 * token even when nothing in them changed. Run through this, an unchanged node keeps its identity
 * and a memoized renderer skips it; a changed one (more props, `incomplete` → final) is new, and so
 * is every ancestor of it, which is what re-renders.
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const shared = next.map((value, index) => {
      const kept = shareStructure(previous[index], value);
      if (kept !== previous[index]) same = false;
      return kept;
    });
    return (same ? previous : shared) as T;
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(previous)) return next;
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const shared: Record<string, unknown> = {};
    for (const key of keys) {
      const kept = shareStructure(previous[key], next[key]);
      if (kept !== previous[key] || !Object.hasOwn(previous, key)) same = false;
      shared[key] = kept;
    }
    return (same ? previous : shared) as T;
  }
  return next;
}
