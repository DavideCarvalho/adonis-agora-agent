/**
 * Resolve the base URL of the agent routes the SPA calls. The provider hands the exact base it
 * mounted the agent under to the page as a JSON data block
 * (`<script type="application/json" id="agent-dashboard-config">{"apiBase":…}</script>`) when it
 * serves `index.html`; a `window.__AGENT_DASHBOARD_BASE__` global is honoured after it (tests,
 * hand-embedding); and when both are absent (e.g. the standalone `vite dev` preview) we derive it
 * from the page's own location by stripping the trailing `/dashboard` mount segment. Either way the
 * SPA never hard-codes `/agent`.
 *
 * The data block, and not an inline script setting the global, because a host
 * Content-Security-Policy of `script-src 'self' 'nonce-…'` (shield's `@nonce`) refuses an un-nonced
 * inline script without a word: the global was never set, the location-derived base took over, and
 * a console mounted anywhere but the default answered 404 to all of its own requests while rendering
 * perfectly. A data block is never executed, so no policy can refuse it.
 */

declare global {
  interface Window {
    __AGENT_DASHBOARD_BASE__?: string;
  }
}

/** `id` of the data block the provider injects (`@adonis-agora/agent`'s `CONFIG_ELEMENT_ID`). */
export const CONFIG_ELEMENT_ID = 'agent-dashboard-config';

/** The `apiBase` carried by the injected data block, or `undefined` when there is none. */
function readInjectedApiBase(
  doc: Pick<Document, 'getElementById'> | undefined,
): string | undefined {
  const element = doc?.getElementById(CONFIG_ELEMENT_ID) ?? null;
  if (element === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    const apiBase = (parsed as { apiBase?: unknown } | null)?.apiBase;
    return typeof apiBase === 'string' && apiBase !== '' ? apiBase : undefined;
  } catch {
    return undefined;
  }
}

/** Strip a trailing `/` (but never reduce `/` itself to `''`). */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Derive the agent API base from the dashboard's own `pathname`. The dashboard is mounted at
 * `<agentBase>/dashboard`, so we drop that last segment: `/agent/dashboard` → `/agent`,
 * `/api/agent/dashboard/` → `/api/agent`. A pathname that does not end in `/dashboard` is returned
 * cleaned (trailing slash removed) as a best-effort base.
 */
export function deriveApiBase(pathname: string): string {
  const clean = stripTrailingSlash(pathname);
  if (clean.endsWith('/dashboard')) {
    const base = clean.slice(0, -'/dashboard'.length);
    return base === '' ? '/' : base;
  }
  return clean === '' ? '/' : clean;
}

/** The resolved agent API base for this page: the data block, else the global, else location-derived. */
export function resolveApiBase(
  win: Pick<Window, 'location'> & { __AGENT_DASHBOARD_BASE__?: string } = window,
  doc: Pick<Document, 'getElementById'> | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): string {
  const fromBlock = readInjectedApiBase(doc);
  if (fromBlock !== undefined) return stripTrailingSlash(fromBlock);
  const injected = win.__AGENT_DASHBOARD_BASE__;
  if (typeof injected === 'string' && injected !== '') return stripTrailingSlash(injected);
  return deriveApiBase(win.location.pathname);
}
