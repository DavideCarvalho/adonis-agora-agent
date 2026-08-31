/**
 * Pure path/asset helpers for serving the `@adonis-agora/agent-dashboard` governance SPA — extracted
 * so they can be unit-tested without booting an AdonisJS app. Both dashboard providers compose these;
 * each holds only the router wiring + I/O. Owned here (rather than in `@adonis-agora/agent-dashboard`)
 * so `packages/adonis`'s OWN embedded dashboard provider (`providers/dashboard_provider.ts`) can reuse
 * them without depending on the dashboard package at runtime — the dashboard package already depends
 * on THIS one (for `AgentConfig`/`ActorResolver`/...), and a package.json edge the other way would be
 * circular. See `providers/dashboard_provider.ts`'s module doc for the full story.
 */

/** Collapse duplicate slashes and strip leading/trailing ones: `/agent//` → `agent`. */
export function trimSlashes(path: string): string {
  return path.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/** The agent API base as an absolute path with a single leading slash: `agent` → `/agent`. */
export function apiBaseFor(agentPath: string): string {
  const trimmed = trimSlashes(agentPath);
  return trimmed === '' ? '/' : `/${trimmed}`;
}

/**
 * The canonical dashboard mount path (no trailing slash), default `<agentPath>/dashboard`. A caller
 * may override with an explicit `dashboardPath`; both are normalized to a single leading slash.
 */
export function mountPathFor(agentPath: string, dashboardPath?: string): string {
  if (dashboardPath !== undefined && trimSlashes(dashboardPath) !== '') {
    return `/${trimSlashes(dashboardPath)}`;
  }
  const trimmed = trimSlashes(agentPath);
  return trimmed === '' ? '/dashboard' : `/${trimmed}/dashboard`;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** MIME type for a filename by extension; `application/octet-stream` for anything unknown. */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Reject a wildcard asset request that tries to escape the SPA root via `..` or an absolute path.
 * Returns the safe, normalized relative segments (never starting with `..`), or `null` to deny.
 */
export function safeAssetSegments(wildcard: string | string[] | undefined): string[] | null {
  const parts = Array.isArray(wildcard) ? wildcard : (wildcard ?? '').split('/');
  const segments: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes('\0') || part.includes('\\')) return null;
    segments.push(part);
  }
  return segments;
}

/** `id` of the JSON data block {@link injectApiBase} emits; the SPA's `resolveApiBase()` reads it. */
export const CONFIG_ELEMENT_ID = 'agent-dashboard-config';

/**
 * Hand the resolved agent API base to the served `index.html`, so the client calls the exact base
 * the provider mounted (no build-time coupling). Inserted right before `</head>`.
 *
 * It goes in as a JSON DATA BLOCK (`<script type="application/json">{"apiBase":…}</script>`), not
 * as an inline script assigning `window.__AGENT_DASHBOARD_BASE__`. A data block is never executed,
 * so no Content-Security-Policy can refuse it; an inline script IS, and a host with
 * `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s `@nonce`, the recommended setup) silently
 * dropped ours — the SPA then derived a base from its own URL, which is right only for the default
 * mount, and on any other every request from a console that had rendered perfectly answered 404.
 * The global is still read by the SPA as a fallback, but this is no longer how the provider speaks.
 */
export function injectApiBase(html: string, apiBase: string): string {
  // `<` escaped as `\u003c` inside the JSON: a data block ends at the first `</script`, and a
  // config value must not be able to close it early. Valid JSON either way.
  const json = JSON.stringify({ apiBase }).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  return `${tag}${html}`;
}

/**
 * Inject a `<base href="${mount}/">` as the FIRST thing inside `<head>`, so the SPA's relative
 * `./assets/*` URLs (Vite `base: './'`) resolve against the mount directory no matter whether the
 * browser's URL carries a trailing slash. This replaces the old trailing-slash redirect, which the
 * AdonisJS router (it normalizes trailing slashes) turned into a duplicate-route crash. `mount` is a
 * leading-slash, no-trailing-slash path (e.g. `/agent/dashboard`).
 */
export function injectBaseHref(html: string, mount: string): string {
  const tag = `<base href="${mount}/">`;
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return `${tag}${html}`;
}
