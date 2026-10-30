import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { PoppyError } from './errors.js';
import type { FetchLike } from './util.js';

/**
 * `fetch` for URLs a Company gave (section 3): HTTPS only, and never to a loopback, private or
 * link-local address. The address is checked in the socket's own `lookup`, so what was checked is
 * what gets connected to, with no window for DNS rebinding, and each request opens its own
 * connection. Every redirect hop goes through the same check.
 */

export type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface SafeFetchOptions {
  /** Name resolution, for tests. Default: `dns.lookup`. */
  lookup?: LookupFn | undefined;
  /** Address policy, for tests. Default: {@link isBlockedAddress}. */
  isBlocked?: ((address: string) => boolean) | undefined;
  connectTimeoutMs?: number | undefined;
}

const MAX_REDIRECTS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Headers that don't follow a redirect (section 3). */
const SECRET_HEADERS = ['authorization', 'cookie', 'dpop', 'poppy-session'];

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** An IPv6 address as 8 groups of 16 bits. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0] ?? '';
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)?.[1];
  if (v4) {
    const n = ipv4ToInt(v4);
    addr = `${addr.slice(0, -v4.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(Math.max(fill, 0)).fill('0'), ...t].map((g) =>
    Number.parseInt(g || '0', 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** Whether this client must not connect to `ip`. Anything that isn't an IP counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
    });
  }
  if (family !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [a = 0, b = 0, c = 0] = g;
  const g5 = g[5] ?? 0;
  const g6 = g[6] ?? 0;
  const g7 = g[7] ?? 0;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  // IPv4-mapped and IPv4-compatible: the IPv4 address decides.
  if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) {
    return isBlockedAddress(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10, site-local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8, multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32, documentation
  if (a === 0x64 && b === 0xff9b) return true; // 64:ff9b::/96, NAT64
  if (a === 0x2002) return isBlockedAddress(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
  return false;
}

function refused(message: string): PoppyError {
  return new PoppyError('blocked_address', message);
}

/** One request, one connection, the address checked in the socket's `lookup`. */
function requestOnce(
  url: URL,
  init: {
    method: string;
    headers: Headers;
    body?: string | undefined;
    signal?: AbortSignal | null;
  },
  opts: SafeFetchOptions,
): Promise<IncomingMessage> {
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const resolve = opts.lookup ?? (dnsLookup as unknown as LookupFn);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') return Promise.reject(refused(`${url.protocol} is not HTTPS`));
  if (url.username || url.password) return Promise.reject(refused('credentials in the URL'));
  if (isIP(host) && isBlocked(host)) return Promise.reject(refused(`blocked address ${host}`));

  const lookup = (
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: (err: Error | null, address?: unknown, family?: number) => void,
  ) => {
    resolve(hostname, { all: true }, (err, list) => {
      if (err) return callback(err);
      const addresses = list ?? [];
      const first = addresses[0];
      if (!first) return callback(refused(`no address for ${hostname}`));
      // Any internal address refuses the name: the connection may try them all.
      const bad = addresses.find((a) => isBlocked(a.address));
      if (bad) return callback(refused(`${hostname} resolves to a blocked address`));
      if (options?.all) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  };

  return new Promise((done, reject) => {
    const headers: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const req = httpsRequest(
      url,
      {
        method: init.method,
        headers,
        agent: false,
        lookup: lookup as never,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      done,
    );
    const timer = setTimeout(
      () => req.destroy(new PoppyError('connect_timeout', `timed out connecting to ${url.host}`)),
      opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    timer.unref();
    req.once('socket', (socket) => {
      socket.once('secureConnect', () => clearTimeout(timer));
    });
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end(init.body);
  });
}

function toResponse(res: IncomingMessage, url: URL): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
  }
  const status = res.statusCode ?? 502;
  const empty = status === 204 || status === 205 || status === 304;
  if (empty) res.resume();
  const response = new Response(
    empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
    { status, headers },
  );
  Object.defineProperty(response, 'url', { value: url.toString() });
  return response;
}

/** A `fetch` that refuses internal addresses (section 3). */
export function createSafeFetch(opts: SafeFetchOptions = {}): FetchLike {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    let url = new URL(request ? request.url : input.toString());
    let method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);
    let body: string | undefined;
    const raw = init.body ?? undefined;
    if (typeof raw === 'string') body = raw;
    else if (raw !== undefined) body = await new Response(raw).text();
    else if (request?.body) body = await request.text();
    const signal = init.signal ?? request?.signal ?? null;
    const mode = init.redirect ?? request?.redirect ?? 'follow';

    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, { method, headers, body, signal }, opts);
      const location = res.headers.location;
      const isRedirect = (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && location;
      if (!isRedirect || mode === 'manual') return toResponse(res, url);
      res.resume();
      if (mode === 'error') throw new TypeError(`unexpected redirect from ${url}`);
      if (hop >= MAX_REDIRECTS) throw new TypeError(`too many redirects from ${url}`);
      url = new URL(location as string, url);
      for (const name of SECRET_HEADERS) headers.delete(name);
      const status = res.statusCode;
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('content-length');
      }
    }
  };
}

/** The default `fetch` of this client, unless `insecureDev` asked for the plain one. */
export const safeFetch: FetchLike = createSafeFetch();

const plainFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * The `fetch` for a Company's URLs. `insecureDev` is the explicit opt-in that reaches local servers.
 * A caller that injects its own `fetch` takes over this check.
 */
export function companyFetch(insecureDev: boolean | undefined): FetchLike {
  return insecureDev ? plainFetch : safeFetch;
}
