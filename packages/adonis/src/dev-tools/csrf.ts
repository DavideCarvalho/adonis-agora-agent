/** The `csrf` block of `config/shield.ts`, duck-typed. */
interface ShieldCsrfLike {
  enabled?: boolean;
  methods?: string[];
  exceptRoutes?: string[] | ((ctx: unknown) => boolean);
}

/**
 * Whether shield's CSRF check would reject a bare `POST` to `/<path>` (an MCP client sends no CSRF
 * token). `false` when CSRF is off, `POST` is not a checked method, or `exceptRoutes` exempts the
 * route: an array naming the pattern, or a function that answers `true` for a minimal context of
 * that request. `'unknown'` when an `exceptRoutes` function throws on that minimal context: it may
 * well block the path, so the caller warns.
 */
export function csrfBlocksPath(shield: unknown, path: string): boolean | 'unknown' {
  const csrf = (shield as { csrf?: ShieldCsrfLike } | undefined)?.csrf;
  if (csrf === undefined || csrf.enabled !== true) return false;
  // An explicit method list that leaves out POST (an empty list checks no method) never blocks it.
  if (
    Array.isArray(csrf.methods) &&
    !csrf.methods.some((method) => method.toUpperCase() === 'POST')
  ) {
    return false;
  }
  const pattern = `/${path}`;
  const except = csrf.exceptRoutes;
  if (typeof except === 'function') {
    try {
      const probe = {
        request: {
          url: () => pattern,
          method: () => 'POST',
          header: () => undefined,
        },
        route: { pattern },
      };
      return except(probe) !== true;
    } catch {
      return 'unknown';
    }
  }
  if (Array.isArray(except)) return !except.includes(pattern);
  return true;
}

/** The boot warning for {@link csrfBlocksPath}. */
export function csrfWarning(path: string, verdict: boolean | 'unknown' = true): string {
  return verdict === 'unknown'
    ? `[@adonis-agora/agent] dev tools at /${path} may be blocked by CSRF (shield csrf.exceptRoutes threw when probed): make sure it exempts /${path}`
    : `[@adonis-agora/agent] dev tools at /${path} are blocked by CSRF: add it to shield csrf.exceptRoutes`;
}
