import { McpAuthError } from './auth.js';

/**
 * The remote JWT access-token check shared by the dev hub's `jwtAuth` and the product endpoints'
 * `oidcAuth`: signature against the issuer's JWKS (discovered from its metadata, keys cached), `iss`,
 * `aud`, `exp`/`nbf`. Needs nothing of the authorization server in this process.
 */

/** An absolute http(s) URL, or a config error naming the option. */
export function absoluteUrl(value: string, option: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // reported below
  }
  throw new Error(
    `[@adonis-agora/agent] ${option} must be an absolute http(s) URL, got ${JSON.stringify(value)}`,
  );
}

/** Same issuer up to a trailing slash. */
export const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The well-known metadata documents of an issuer, in the order they are tried. */
export function issuerMetadataUrls(issuer: string): string[] {
  const url = absoluteUrl(issuer, 'jwtAuth `issuer`');
  const base = issuer.replace(/\/+$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  const urls = [`${base}/.well-known/openid-configuration`];
  if (path !== '') urls.push(`${url.origin}/.well-known/oauth-authorization-server${path}`);
  urls.push(`${base}/.well-known/oauth-authorization-server`);
  return [...new Set(urls)];
}

/** Fetch the issuer's metadata (OIDC discovery, then RFC 8414) and return its `jwks_uri`. */
export async function discoverJwksUri(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const failures: string[] = [];
  for (const url of issuerMetadataUrls(issuer)) {
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        failures.push(`${url}: ${response.status}`);
        continue;
      }
      const meta = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (typeof meta.issuer === 'string' && !sameIssuer(meta.issuer, issuer)) {
        failures.push(`${url}: issuer is ${JSON.stringify(meta.issuer)}`);
        continue;
      }
      if (typeof meta.jwks_uri !== 'string') {
        failures.push(`${url}: no jwks_uri`);
        continue;
      }
      return meta.jwks_uri;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `[@adonis-agora/agent] could not discover the JWKS of ${issuer} (${failures.join('; ')}). Set \`jwksUri\`.`,
  );
}

const DEFAULT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
];

export interface JwtVerifierOptions {
  issuer: string;
  jwksUri?: string;
  algorithms?: string[];
  /** Seconds. Default `30`. */
  clockTolerance?: number;
}

/**
 * Verify a token for `audiences`: its claims; `null` when it is not a JWT or names another issuer
 * (not this verifier's token). Throws {@link McpAuthError} for a token it refuses (signature,
 * audience, expiry…), a plain `Error` when the JWKS cannot be fetched (an outage).
 */
export type JwtVerifier = (
  token: string,
  audiences: string[],
) => Promise<Record<string, unknown> | null>;

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  type Jose = typeof import('jose');
  let keys: Promise<ReturnType<Jose['createRemoteJWKSet']>> | undefined;
  const keySet = (jose: Jose) => {
    keys ??= (async () => {
      const uri = options.jwksUri ?? (await discoverJwksUri(options.issuer));
      return jose.createRemoteJWKSet(new URL(uri));
    })().catch((error: unknown) => {
      keys = undefined; // try discovery again on the next token
      throw error;
    });
    return keys;
  };

  return async (token, audiences) => {
    const jose = await import('jose');
    let unverified: Record<string, unknown>;
    try {
      unverified = jose.decodeJwt(token);
    } catch {
      return null; // not a JWT
    }
    if (typeof unverified.iss !== 'string' || !sameIssuer(unverified.iss, options.issuer)) {
      return null;
    }
    const jwks = await keySet(jose);
    try {
      const { payload } = await jose.jwtVerify(token, jwks, {
        issuer: unverified.iss, // same issuer up to a trailing slash (checked above)
        audience: audiences,
        algorithms: options.algorithms ?? DEFAULT_ALGORITHMS,
        clockTolerance: options.clockTolerance ?? 30,
        requiredClaims: ['exp', 'sub'],
      });
      return payload as Record<string, unknown>;
    } catch (error) {
      if (isTokenFailure(jose, error)) {
        throw new McpAuthError(`invalid_token: ${(error as Error).message}`, { cause: error });
      }
      throw error;
    }
  };
}

/** The algorithms {@link createJwtVerifier} accepts unless a caller narrows the list. */
export const DEFAULT_JWT_ALGORITHMS = DEFAULT_ALGORITHMS;

/**
 * Whether jose refused the token itself (claims, signature, format, no matching key) — as opposed to
 * a JWKS it could not fetch, which is an outage and surfaces as a `503`.
 */
export function isTokenFailure(jose: typeof import('jose'), error: unknown): boolean {
  const e = jose.errors;
  return (
    error instanceof e.JWTClaimValidationFailed ||
    error instanceof e.JWTExpired ||
    error instanceof e.JWSSignatureVerificationFailed ||
    error instanceof e.JWSInvalid ||
    error instanceof e.JWTInvalid ||
    error instanceof e.JOSEAlgNotAllowed ||
    error instanceof e.JOSENotSupported ||
    error instanceof e.JWKSNoMatchingKey ||
    error instanceof e.JWKSMultipleMatchingKeys
  );
}

/** Scopes granted to a token (`scope` string or `scp` array). */
export function scopesFrom(claims: Record<string, unknown>): string[] {
  const scope = claims.scope ?? claims.scp;
  if (typeof scope === 'string') return scope.split(/\s+/).filter((s) => s !== '');
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string');
  return [];
}

/** Roles from a claim, when it is a string array (or a space-separated string). */
export function rolesFrom(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((r): r is string => typeof r === 'string');
  if (typeof value === 'string' && value !== '') return value.split(/\s+/);
  return undefined;
}

/**
 * The real actor of an impersonation token: its RFC 8693 `act` claim (`{ sub, email? }`), or
 * `undefined` when the token acts for its own subject (no `act`, or `act.sub` = `sub`).
 */
export function actorFromClaims(
  claims: Record<string, unknown>,
): { sub: string; email?: string } | undefined {
  const act = claims.act;
  if (typeof act !== 'object' || act === null) return undefined;
  const { sub, email } = act as { sub?: unknown; email?: unknown };
  if (typeof sub !== 'string' || sub === '') return undefined;
  // A token acting for its own subject is not an impersonation.
  if (sub === claims.sub) return undefined;
  return { sub, ...(typeof email === 'string' && email !== '' ? { email } : {}) };
}
