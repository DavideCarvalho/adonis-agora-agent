/**
 * The CSRF header an AdonisJS app expects on a mutating request, read from the page at call time.
 *
 * `@adonisjs/shield` accepts the token two ways, and this reads whichever the app serves:
 *  - `enableXsrfCookie: true` (the Inertia/SPA setup) → the `XSRF-TOKEN` cookie, sent back as
 *    `X-XSRF-TOKEN`;
 *  - otherwise a `<meta name="csrf-token" content="{{ csrfToken }}">` tag, sent as `X-CSRF-TOKEN`.
 *
 * Read per request rather than once: shield rotates the cookie, and a token captured at mount goes
 * stale. Outside a browser (SSR, tests) there is nothing to read and no header is sent.
 */

interface DocumentLike {
  cookie?: string;
  querySelector?(selector: string): { getAttribute(name: string): string | null } | null;
}

function pageDocument(): DocumentLike | undefined {
  return (globalThis as { document?: DocumentLike }).document;
}

/** The decoded value of cookie `name`, or `undefined` when the page has no such cookie. */
export function readCookie(name: string): string | undefined {
  const cookie = pageDocument()?.cookie;
  if (typeof cookie !== 'string' || cookie.length === 0) {
    return undefined;
  }
  for (const pair of cookie.split(';')) {
    const at = pair.indexOf('=');
    if (at === -1 || pair.slice(0, at).trim() !== name) {
      continue;
    }
    const raw = pair.slice(at + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** `{ 'X-XSRF-TOKEN': … }` / `{ 'X-CSRF-TOKEN': … }` for this page, or `{}` when it carries no token. */
export function csrfHeaders(): Record<string, string> {
  const fromCookie = readCookie('XSRF-TOKEN');
  if (fromCookie !== undefined && fromCookie.length > 0) {
    return { 'X-XSRF-TOKEN': fromCookie };
  }
  const fromMeta = pageDocument()
    ?.querySelector?.('meta[name="csrf-token"]')
    ?.getAttribute('content');
  if (typeof fromMeta === 'string' && fromMeta.length > 0) {
    return { 'X-CSRF-TOKEN': fromMeta };
  }
  return {};
}
