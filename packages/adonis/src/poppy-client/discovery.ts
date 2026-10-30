import { DiscoveryError } from './errors.js';
import { companyFetch } from './safe_fetch.js';
import type { AuthServerMetadata, PoppyDocument, ProtectedResourceMetadata } from './types.js';
import {
  type FetchLike,
  isLoopbackHost,
  normalizeDomain,
  requireSecureUrl,
  type SecurityOptions,
} from './util.js';

/** Before 1.0 each `major.minor` can break the last, so these are exact versions (3.1). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['0.3'];

export const WELL_KNOWN_POPPY_PATH = '/.well-known/poppy.json';

const MAX_REDIRECTS = 5;
const GRANT_AUTHORIZATION_CODE = 'authorization_code';
const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DiscoveryOptions extends SecurityOptions {
  fetch?: FetchLike | undefined;
  /** Shared cache honoring `Cache-Control: max-age` (3, 3.2: SHOULD cache). */
  cache?: HttpJsonCache | undefined;
}

export interface Discovered {
  /** The host that served the document, after any redirects (with a port only in dev). */
  domain: string;
  wellKnownUrl: string;
  document: PoppyDocument;
  /** The Company's identifier (3.2): its issuer, or `https://{domain}` without one. */
  identifier: string;
  /** Absent when the Company has no issuer: it offers only signed-out Sessions. */
  metadata?: AuthServerMetadata | undefined;
  /**
   * How discovery established there is no issuer. Only `metadata` says so explicitly, which is what
   * lets an agent that knew an issuer accept its removal (3.2).
   */
  noIssuer?: 'not_found' | 'metadata' | undefined;
}

/** In-memory cache of JSON documents by URL, by `Cache-Control: max-age`. */
export class HttpJsonCache {
  private readonly entries = new Map<string, { expires: number; value: FetchedJson }>();
  get(url: string): FetchedJson | undefined {
    const e = this.entries.get(url);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(url);
      return undefined;
    }
    return e.value;
  }
  set(url: string, value: FetchedJson, cacheControl: string | null) {
    if (!cacheControl || /no-store|no-cache/i.test(cacheControl)) return;
    const m = /max-age=(\d+)/i.exec(cacheControl);
    if (!m) return;
    this.entries.set(url, { expires: Date.now() + Number(m[1]) * 1000, value });
  }
}

/**
 * Turns user input into the well-known URL. `example.com` → `https://example.com/...`.
 * With `insecureDev`, an explicit `http://host:port` is kept, and a bare loopback host
 * (`localhost:3333`) defaults to `http:`.
 */
interface FetchedJson {
  json: unknown;
  finalUrl: URL;
}

export function wellKnownUrlFor(input: string, sec: SecurityOptions = {}): URL {
  let base: URL;
  if (/^[a-z]+:\/\//i.test(input)) {
    base = new URL(input);
  } else {
    const guess = new URL(`https://${input}`);
    base = sec.insecureDev && isLoopbackHost(guess.hostname) ? new URL(`http://${input}`) : guess;
  }
  requireSecureUrl(base.toString(), 'Company domain', sec);
  return new URL(WELL_KNOWN_POPPY_PATH, base.origin);
}

async function fetchJson(
  url: URL,
  what: string,
  opts: DiscoveryOptions & { notFoundIsNull?: boolean },
): Promise<FetchedJson> {
  const cached = opts.cache?.get(url.toString());
  if (cached !== undefined) return cached;
  const doFetch = opts.fetch ?? companyFetch(opts.insecureDev);
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await doFetch(current.toString(), {
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS)
        throw new DiscoveryError('too_many_redirects', `${what}: too many redirects`);
      const next = new URL(res.headers.get('location')!, current);
      try {
        // Every redirect MUST be to an HTTPS URL (3).
        requireSecureUrl(next.toString(), `${what} redirect`, opts);
      } catch (e) {
        throw new DiscoveryError('insecure_redirect', (e as Error).message);
      }
      current = next;
      continue;
    }
    if (res.status === 404 && opts.notFoundIsNull) return { json: null, finalUrl: current };
    if (!res.ok) {
      throw new DiscoveryError('fetch_failed', `${what}: HTTP ${res.status} from ${current}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new DiscoveryError('invalid_json', `${what}: response is not JSON`);
    }
    const fetched = { json, finalUrl: current };
    opts.cache?.set(url.toString(), fetched, res.headers.get('cache-control'));
    return fetched;
  }
}

function fail(code: string, message: string): never {
  throw new DiscoveryError(code, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkUrl(value: unknown, what: string, sec: SecurityOptions): string {
  try {
    return requireSecureUrl(value, what, sec).toString();
  } catch (e) {
    fail('invalid_document', (e as Error).message);
  }
}

/** Validates `poppy.json` against 3.1. Unknown fields are ignored, never rejected. */
export function validatePoppyDocument(
  json: unknown,
  servedHost: string,
  sec: SecurityOptions = {},
): PoppyDocument {
  if (!isObject(json)) fail('invalid_document', 'poppy.json is not a JSON object');
  const version = json.protocol_version;
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
    fail('invalid_document', 'protocol_version must be "major.minor"');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    fail(
      'unsupported_protocol_version',
      `poppy.json protocol_version ${version} is not supported; this agent supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
    );
  }

  const org = json.organization;
  if (!isObject(org) || typeof org.name !== 'string' || typeof org.domain !== 'string') {
    fail('invalid_document', 'organization.name and organization.domain are required');
  }
  // `organization.domain` is the host that served the document, compared ignoring case only (3.1).
  // Ports only appear in --insecure-dev setups.
  const served = normalizeDomain(servedHost);
  const servedNoPort = sec.insecureDev ? served.replace(/:\d+$/, '') : served;
  const claimed = normalizeDomain(org.domain);
  if (claimed !== served && claimed !== servedNoPort) {
    fail(
      'domain_mismatch',
      `organization.domain "${org.domain}" is not the host that served the document, "${servedHost}"`,
    );
  }

  const hasAgent = json.agent !== undefined;
  const hasApis = json.apis !== undefined;
  const hasWeb = json.web !== undefined;
  if (!hasAgent && !hasApis && !hasWeb) {
    fail('invalid_document', 'poppy.json must have at least one of agent, apis, web');
  }

  if (hasWeb) {
    if (!isObject(json.web)) fail('invalid_document', 'web must be an object');
    if (json.web.browser_session_endpoint !== undefined) {
      checkUrl(json.web.browser_session_endpoint, 'web.browser_session_endpoint', sec);
    }
  }
  if (json.auth !== undefined) {
    const auth = json.auth;
    if (!isObject(auth)) fail('invalid_document', 'auth must be an object');
    if (auth.issuer !== undefined) checkUrl(auth.issuer, 'auth.issuer', sec);
  }
  for (const [field, key] of [
    ['feedback', 'endpoint'],
    ['excluded_tasks', 'url'],
  ] as const) {
    const value = json[field];
    if (value === undefined) continue;
    if (!isObject(value)) fail('invalid_document', `${field} must be an object`);
    checkUrl(value[key], `${field}.${key}`, sec);
  }
  if (json.extensions !== undefined && !isObject(json.extensions)) {
    fail('invalid_document', 'extensions must be an object');
  }
  if (hasAgent) {
    if (!isObject(json.agent) || !Array.isArray(json.agent.protocols)) {
      fail('invalid_document', 'agent.protocols must be a list');
    }
  }
  if (hasApis && !Array.isArray(json.apis)) fail('invalid_document', 'apis must be a list');
  return json as unknown as PoppyDocument;
}

/** RFC 9728 section 3.1: the well-known suffix goes between the host and the resource's path. */
export function protectedResourceMetadataUrl(resource: string | URL): URL {
  const u = new URL(resource);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return new URL(`${u.origin}/.well-known/oauth-protected-resource${path}`);
}

/**
 * Validates the domain's protected resource metadata (3.2) and answers the issuer the Personal
 * Agent uses, or `undefined` when valid metadata names none.
 */
export function validateProtectedResourceMetadata(
  json: unknown,
  doc: PoppyDocument,
  domainUrl: string,
  sec: SecurityOptions = {},
): string | undefined {
  if (!isObject(json)) fail('invalid_metadata', 'protected resource metadata is not an object');
  if (json.resource !== domainUrl) {
    fail(
      'resource_mismatch',
      `protected resource metadata resource "${String(json.resource)}" != "${domainUrl}"`,
    );
  }
  const servers = json.authorization_servers;
  if (servers !== undefined && !Array.isArray(servers)) {
    fail('invalid_metadata', 'authorization_servers must be a list');
  }
  const list = (servers ?? []) as unknown[];
  for (const entry of list) checkUrl(entry, 'authorization_servers entry', sec);
  const named = doc.auth?.issuer;
  if (list.length === 0) {
    if (named !== undefined) {
      fail('issuer_mismatch', `auth.issuer "${named}" is not in authorization_servers`);
    }
    return undefined;
  }
  if (list.length > 1 && named === undefined) {
    fail('issuer_required', 'several authorization_servers need auth.issuer to name one');
  }
  if (named !== undefined && !list.includes(named)) {
    fail('issuer_mismatch', `auth.issuer "${named}" is not in authorization_servers`);
  }
  return named ?? (list[0] as string);
}

/** RFC 8414 section 3: the well-known suffix goes between the host and the issuer's path. */
export function authServerMetadataUrl(issuer: string): URL {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return new URL(`${u.origin}/.well-known/oauth-authorization-server${path}`);
}

/** Validates the issuer metadata against 3.2. */
export function validateMetadata(
  json: unknown,
  issuer: string,
  domainUrl: string,
  sec: SecurityOptions = {},
): AuthServerMetadata {
  if (!isObject(json)) fail('invalid_metadata', 'authorization server metadata is not an object');
  if (json.issuer !== issuer) {
    fail('issuer_mismatch', `metadata issuer "${String(json.issuer)}" != issuer "${issuer}"`);
  }
  const resources = json.protected_resources;
  const wanted = domainUrl.toLowerCase();
  if (
    !Array.isArray(resources) ||
    !resources.some((r) => typeof r === 'string' && r.toLowerCase() === wanted)
  ) {
    fail(
      'domain_not_listed',
      `protected_resources of ${issuer} does not include "${domainUrl}", so it does not vouch for this domain`,
    );
  }
  checkUrl(json.token_endpoint, 'token_endpoint', sec);
  checkUrl(json.revocation_endpoint, 'revocation_endpoint', sec);
  const grants = json.grant_types_supported;
  if (!Array.isArray(grants) || !grants.includes('refresh_token')) {
    fail('invalid_metadata', 'grant_types_supported is required and must include refresh_token');
  }
  if (grants.includes(GRANT_AUTHORIZATION_CODE)) {
    checkUrl(json.authorization_endpoint, 'authorization_endpoint', sec);
  }
  if (grants.includes(GRANT_DEVICE_CODE)) {
    checkUrl(json.device_authorization_endpoint, 'device_authorization_endpoint', sec);
  }
  return json as unknown as AuthServerMetadata;
}

/**
 * Discovery (section 3): fetches `/.well-known/poppy.json`, which must end at that exact path after
 * HTTPS-only redirects, then finds the issuer from the domain's protected resource metadata and
 * checks both directions of the link. A timeout, another error status or invalid metadata throws:
 * only a 404 or valid metadata without servers means there is no issuer (3.2).
 */
export async function discover(input: string, opts: DiscoveryOptions = {}): Promise<Discovered> {
  const wellKnown = wellKnownUrlFor(input, opts);
  const { json, finalUrl } = await fetchJson(wellKnown, 'poppy.json', opts);
  if (finalUrl.pathname !== WELL_KNOWN_POPPY_PATH || finalUrl.search !== '') {
    fail('invalid_redirect', `poppy.json redirected to ${finalUrl}, not to the well-known path`);
  }
  const document = validatePoppyDocument(json, finalUrl.host, opts);
  // `https://{organization.domain}`, lowercase, no trailing slash. The origin is that, in dev with
  // its port and scheme too.
  const domainUrl = finalUrl.origin;
  const domain = finalUrl.host;
  const base = {
    domain,
    wellKnownUrl: finalUrl.toString(),
    document,
  };
  const prm = await fetchJson(
    protectedResourceMetadataUrl(domainUrl),
    'protected resource metadata',
    {
      ...opts,
      notFoundIsNull: true,
    },
  );
  const issuer =
    prm.json === null
      ? undefined
      : validateProtectedResourceMetadata(prm.json, document, domainUrl, opts);
  if (issuer === undefined) {
    if (document.auth?.issuer !== undefined) {
      fail('issuer_mismatch', 'auth.issuer needs protected resource metadata that lists it');
    }
    return {
      ...base,
      identifier: domainUrl,
      noIssuer: prm.json === null ? 'not_found' : 'metadata',
    };
  }
  const { json: meta } = await fetchJson(
    authServerMetadataUrl(issuer),
    'authorization server metadata',
    opts,
  );
  return {
    ...base,
    identifier: issuer,
    metadata: validateMetadata(meta, issuer, domainUrl, opts),
  };
}
