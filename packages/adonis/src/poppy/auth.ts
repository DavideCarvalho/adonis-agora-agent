import type { Actor } from '../types.js';

/**
 * Who a Poppy request comes from: a Personal Agent (`clientId`) acting for one of its Users
 * (`userId`, the pairwise User ID — not an account) in one Session. `signedIn`, with the app
 * account (`accountId`) and `scopes`, once the User signed in here (§4.4); a signed-out token has
 * neither. The shape `@adonis-agora/authkit-server` answers.
 */
export interface PoppyPrincipal {
  /** The opaque, stable id the Personal Agent gave this User here. */
  userId: string;
  /** The app account, when the Session is signed in; `null` signed out. */
  accountId: string | null;
  /** The Personal Agent's `client_id` (its metadata document URL). */
  clientId: string;
  /** The token's account scopes (`poppy:read`, `poppy:write`, custom). Empty signed out. */
  scopes: string[];
  sessionId: string;
  signedIn: boolean;
  /** The `resource` the token was issued for (RFC 8707), or `null`. */
  resource?: string | null;
  tokenType?: 'DPoP' | 'Bearer';
  /** What the app's `personalAgents.poppy.toActor` answered, when it has one. */
  actor?: Actor;
}

/** The request a resolver verifies — the Session Token and its DPoP proof are in `headers`. */
export interface PoppyAuthRequest {
  method: string;
  /** The full PUBLIC request URL (the DPoP `htu` is checked against it; the query is ignored). */
  url: string;
  /** The request's headers as received (lower-cased names) — `authorization` and `dpop` included. */
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
  status: 400 | 401 | 403;
  error:
    | 'invalid_token'
    | 'sign_in_required'
    | 'insufficient_scope'
    | 'invalid_dpop_proof'
    | 'use_dpop_nonce'
    | (string & {});
  scope?: string;
  /** The challenge to answer with, verbatim. */
  wwwAuthenticate: string;
  /** For logs and the body's `error_description` — never the token. */
  description?: string;
  /** Extra headers to answer with (`DPoP-Nonce`). */
  headers?: Record<string, string>;
};

export type PoppyAuthResult = { ok: true; principal: PoppyPrincipal } | PoppyAuthFailure;

/**
 * Verifies a request's Session Token. `@adonis-agora/authkit-server` installs one in the global
 * slot {@link POPPY_AUTHENTICATE_SLOT}; an app can pass its own (`definePoppyConfig({ authenticate })`).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec),
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
