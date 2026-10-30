import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isBlockedAddress } from './safe_fetch.js';

/** A random URL-safe ID. 16 bytes = 128 random bits, what the guides suggest for a `jti`. */
export function randomId(prefix = '', bytes = 16): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function sha256b64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Hosts we treat as "local development" for messages and defaults. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * Whether a URL's host is visibly internal: `localhost` or an address literal section 3 forbids. A
 * name that resolves to one is refused where the connection is made (`safe_fetch.ts`).
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return isLoopbackHost(h) || (isIP(h) !== 0 && isBlockedAddress(h));
}

export interface SecurityOptions {
  /**
   * NON-SPEC. Lets `http:` URLs through every place the spec demands HTTPS (client_id,
   * discovery, issuer, endpoints, redirects). Only for testing against a local dev server.
   */
  insecureDev?: boolean | undefined;
}

/**
 * Parses `value` as an absolute URL and enforces the spec's HTTPS requirement. With
 * `insecureDev`, plain `http:` is tolerated too.
 */
export function requireSecureUrl(value: unknown, what: string, sec: SecurityOptions): URL {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${what} must be a URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${what} is not a valid URL: ${value}`);
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && sec.insecureDev)) {
    if (!sec.insecureDev && isInternalHost(url.hostname)) {
      throw new TypeError(`${what} points to an internal address (${url.hostname})`);
    }
    return url;
  }
  throw new TypeError(
    `${what} must be an https:// URL (got ${url.protocol}//${url.host})${
      url.protocol === 'http:' ? '. Pass --insecure-dev to allow http:// for local testing.' : ''
    }`,
  );
}

/** Domains are compared ignoring case, with no other normalization (3.1). */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase();
}

/** `Retry-After` as seconds: either delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

export interface WwwAuthChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Minimal `WWW-Authenticate` parser: enough for `DPoP error="...", scope="..."` and
 * `Bearer error="..."` (RFC 6750 / RFC 9449). Handles several challenges in one header.
 */
export function parseWwwAuthenticate(header: string | null): WwwAuthChallenge[] {
  if (!header) return [];
  const out: WwwAuthChallenge[] = [];
  let i = 0;
  let current: WwwAuthChallenge | undefined;
  while (i < header.length) {
    while (header[i] === ' ' || header[i] === ',') i++;
    if (i >= header.length) break;
    // Try param first (token "=" ...), then scheme.
    const paramRe = /([A-Za-z0-9_-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^,\s]+)/y;
    paramRe.lastIndex = i;
    const pm = paramRe.exec(header);
    if (pm && current) {
      current.params[(pm[1] ?? '').toLowerCase()] =
        pm[3] !== undefined ? pm[3].replace(/\\(.)/g, '$1') : (pm[2] ?? '');
      i = paramRe.lastIndex;
      continue;
    }
    const schemeRe = /([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)/y;
    schemeRe.lastIndex = i;
    const sm = schemeRe.exec(header);
    if (!sm) break;
    current = { scheme: sm[1] ?? '', params: {} };
    out.push(current);
    i = schemeRe.lastIndex;
  }
  return out;
}

/**
 * The first `error` found in any challenge of a `WWW-Authenticate` header, or, for a challenge
 * without an error code (section 7), the `scope` it names.
 */
export function wwwAuthError(header: string | null): {
  error?: string | undefined;
  scope?: string | undefined;
  description?: string | undefined;
  resourceMetadata?: string | undefined;
} {
  const challenges = parseWwwAuthenticate(header);
  for (const c of challenges) {
    if (c.params.error) {
      return {
        error: c.params.error,
        scope: c.params.scope,
        description: c.params.error_description,
        ...(c.params.resource_metadata ? { resourceMetadata: c.params.resource_metadata } : {}),
      };
    }
  }
  const first = challenges[0];
  return first
    ? { scope: first.params.scope, resourceMetadata: first.params.resource_metadata }
    : {};
}

/** A space-separated scope string as a set (OAuth scope syntax, RFC 6749 3.3). */
export function scopeSet(scope: string | undefined): Set<string> {
  return new Set((scope ?? '').split(' ').filter(Boolean));
}
