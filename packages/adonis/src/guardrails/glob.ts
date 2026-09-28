const cache = new Map<string, RegExp>();

/** Minimal glob: `*` matches any run of characters, `?` a single one. Case-sensitive. */
export function globToRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    re = new RegExp(`^${body}$`);
    cache.set(pattern, re);
  }
  return re;
}

export function matchesAny(value: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(value));
}
