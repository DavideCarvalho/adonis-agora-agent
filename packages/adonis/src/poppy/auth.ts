import type { Actor } from '../types.js';

/**
 * Who a Poppy request comes from: a Personal Agent (`clientId`) acting for one of its Users
 * (`userId`, the pairwise User ID — not an account) in one Session. `signedIn` with `scopes` once
 * the User signed in to an account here (§4.4); a signed-out token has no scopes.
 */
export interface PoppyPrincipal {
  userId: string;
  clientId: string;
  scopes: string[];
  sessionId: string;
  signedIn: boolean;
  /** The account's actor, when the resolver knows it (a signed-in Session). */
  actor?: Actor;
}

/** The request a resolver verifies — the Session Token and its DPoP proof are in `headers`. */
export interface PoppyAuthRequest {
  method: string;
  /** The absolute request URL (the DPoP `htu` is checked against it, without the query). */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
}

export type PoppyAuthFailure = {
  ok: false;
  status: 401 | 403;
  error: 'invalid_token' | 'sign_in_required' | 'insufficient_scope';
  scope?: string;
  /** The challenge to answer with, verbatim. */
  wwwAuthenticate: string;
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
export type PoppyAuthenticate = (request: PoppyAuthRequest) => Promise<PoppyAuthResult>;

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
