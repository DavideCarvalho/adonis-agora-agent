import type { Actor } from '../types.js';

/**
 * Who a Poppy request comes from: a Personal Agent (`clientId`) acting for one of its Users
 * (`userId`, the pairwise User ID — not an account) in one Session. `signedIn`, with the app
 * account (`accountId`) and `scopes`, on a request that carries an access token (§5.4); a signed-out
 * request has neither. The shape `@adonis-agora/authkit-server` answers.
 */
export interface PoppyPrincipal {
  /** The opaque, stable id the Personal Agent gave this User here. */
  userId: string;
  /** Which of the User's agents this Session is for (§5.1), if the Personal Agent says. */
  agentId?: string | null;
  /** The app account, when the request carries an access token; `null` signed out. */
  accountId: string | null;
  /** The Personal Agent's `client_id` (its metadata document URL). */
  clientId: string;
  /** The access token's scopes. Empty signed out. */
  scopes: string[];
  sessionId: string;
  signedIn: boolean;
  /** The `resource` the token was issued for (RFC 8707), or `null`. */
  resource?: string | null;
  /** The access token's scheme; `null` signed out. */
  tokenType?: 'DPoP' | 'Bearer' | null;
  /** What the app's `personalAgents.poppy.toActor` answered, when it has one. */
  actor?: Actor;
}

/** The request a resolver verifies — the `Poppy-Session` JWT and any access token are in `headers`. */
export interface PoppyAuthRequest {
  method: string;
  /** The full PUBLIC request URL (the Session JWT's `htu` is checked against it; the query is ignored). */
  url: string;
  /** The request's headers as received (lower-cased names) — `poppy-session`, `authorization` and `dpop` included. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * What a resolver may be asked to require besides a valid token. The conversation endpoint asks for
 * none: which scopes a turn needs is decided per tool, and the `resource` a token must carry is
 * derived by the resolver from the URL (the `resource` of the `poppy` protocol entry, if any).
 */
export interface PoppyAuthOptions {
  scopes?: string[];
  signedIn?: boolean;
  resource?: string | null;
}

export type PoppyAuthFailure = {
  ok: false;
  status: 400 | 401 | 403 | 429;
  /** `null`: a challenge without a code (§8, the request needs the account) or a rate limit (§5.6). */
  error:
    | 'invalid_session'
    | 'invalid_token'
    | 'insufficient_scope'
    | 'invalid_dpop_proof'
    | 'use_dpop_nonce'
    | (string & {})
    | null;
  scope?: string;
  /** The challenge to answer with, verbatim; `null` for `invalid_session` and rate limits. */
  wwwAuthenticate: string | null;
  /** For logs and `invalid_session`'s `error_description` — never a token. */
  description?: string;
  /** Extra headers to answer with (`DPoP-Nonce`, `Retry-After`). */
  headers?: Record<string, string>;
};

export type PoppyAuthResult = { ok: true; principal: PoppyPrincipal } | PoppyAuthFailure;

/**
 * Verifies a request's Session header and any access token. `@adonis-agora/authkit-server` installs one in the global
 * slot {@link POPPY_AUTHENTICATE_SLOT}; an app can pass its own (`definePoppyConfig({ authenticate })`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.3 (https://personalagentprotocol.org/docs/spec),
 * a spec still in development: this API WILL change as the spec evolves — possibly in breaking
 * ways, outside semver majors while it is a draft.
 */
export type PoppyAuthenticate = (
  request: PoppyAuthRequest,
  options?: PoppyAuthOptions,
) => Promise<PoppyAuthResult>;

/**
 * The contract with the authorization server is this global symbol, not a module: neither package
 * imports the other (like `Symbol.for('@adonis-agora/oauth:resources')` for MCP).
 */
export const POPPY_AUTHENTICATE_SLOT = Symbol.for('@adonis-agora/poppy:authenticate');

/** The resolver installed in the global slot, if any — read per request, so install order is free. */
export function globalPoppyAuthenticate(): PoppyAuthenticate | undefined {
  const value = (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  return typeof value === 'function' ? (value as PoppyAuthenticate) : undefined;
}

/** The Poppy issuer authkit announces (`Symbol.for('@adonis-agora/poppy:issuer')`), if any. */
export function globalPoppyIssuer(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[Symbol.for('@adonis-agora/poppy:issuer')];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
