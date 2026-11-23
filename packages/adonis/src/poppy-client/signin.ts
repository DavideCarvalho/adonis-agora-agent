import { randomBytes } from 'node:crypto';
import type { CompanyClient, SignInResult } from './company.js';
import { OAuthError, PoppyError } from './errors.js';
import { GRANT_DEVICE_CODE, GRANT_MEDIATED_SIGN_IN } from './token_client.js';
import type { DeviceAuthorizationResponse, MediatedExtension } from './types.js';
import { requireSecureUrl, scopeSet, sha256b64url, sleep } from './util.js';

export type SignInType = 'direct' | 'device' | 'mediated';

export const MEDIATED_EXTENSION = 'mediated-sign-in';

/**
 * Version 1 of the `mediated-sign-in` extension, when both `poppy.json` and the issuer offer it. It
 * defines its own grant type, so it isn't declared in `Poppy-Extensions` (3.3).
 */
export function mediatedExtension(company: CompanyClient): MediatedExtension | undefined {
  if (signInDisabled(company)) return undefined;
  const entries = company.document.extensions?.[MEDIATED_EXTENSION];
  const entry = (Array.isArray(entries) ? entries : []).find((e) => e?.version === '1') as
    | MediatedExtension
    | undefined;
  if (!entry || !company.discovered.metadata) return undefined;
  if (!company.metadata.grant_types_supported.includes(GRANT_MEDIATED_SIGN_IN)) return undefined;
  if (!Array.isArray(entry.fields) || !Array.isArray(entry.scopes)) return undefined;
  return entry;
}

/** `auth.disabled`: the Company offers Personal Agents no sign-in, even with an issuer (3.2). */
export function signInDisabled(company: CompanyClient): boolean {
  return company.document.auth?.disabled === true;
}

/**
 * The sign-in types the Company offers (4): the issuer's grants, plus the extension, in the order to
 * prefer them. Direct Sign-In is preferred whenever it's offered (4). None with `auth.disabled`.
 */
export function offeredSignInTypes(company: CompanyClient): SignInType[] {
  if (signInDisabled(company)) return [];
  const grants = company.discovered.metadata?.grant_types_supported ?? [];
  const out: SignInType[] = [];
  if (grants.includes('authorization_code')) out.push('direct');
  if (grants.includes(GRANT_DEVICE_CODE)) out.push('device');
  if (mediatedExtension(company)) out.push('mediated');
  return out;
}

/**
 * The sign-in types that can be used for `scope`. Direct and Device grant what the issuer's policies
 * allow; only Mediated keeps its own list. They come in the order to prefer them (extension, 6).
 */
export function eligibleSignInTypes(company: CompanyClient, scope: string): SignInType[] {
  const wanted = [...scopeSet(scope)];
  return offeredSignInTypes(company).filter(
    (t) =>
      t !== 'mediated' ||
      wanted.every((s) => (mediatedExtension(company)?.scopes ?? []).includes(s)),
  );
}

function assertScopeAllowed(company: CompanyClient, type: SignInType, scope: string) {
  if (!offeredSignInTypes(company).includes(type)) {
    throw new PoppyError('unsupported_sign_in', `${type} sign-in is not offered`);
  }
  if (scopeSet(scope).size === 0) {
    throw new PoppyError('invalid_scope', 'sign-in requests MUST include scope (4.7)');
  }
  if (type !== 'mediated') return;
  const offered = mediatedExtension(company)?.scopes ?? [];
  const extra = [...scopeSet(scope)].filter((s) => !offered.includes(s));
  if (extra.length > 0) {
    throw new PoppyError(
      'invalid_scope',
      `mediated sign-in can't grant ${extra.join(', ')} (offers: ${offered.join(' ')})`,
    );
  }
}

/* ------------------------------------------------------------------ Direct (4.2) */

export interface PendingDirectSignIn {
  /** The URL to open: with PAR, only `client_id` and `request_uri` (4.2). */
  url: string;
  /** With PAR: when the `request_uri` expires (epoch ms). Push again after that. */
  expiresAt?: number | undefined;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scope: string;
  issuer: string;
}

/**
 * Direct Sign-In (4.2): PKCE (S256), a random `state`, and `prompt=consent`, since the redirect may
 * reach this agent from another device than the one that opened the URL. When the issuer lists a
 * `pushed_authorization_request_endpoint`, the request is pushed (RFC 9126) with the client assertion
 * and a DPoP proof, and the URL carries only `client_id` and `request_uri`. A link the User opens
 * later should point at a page of this agent that calls this when it's opened.
 */
export async function startDirectSignIn(
  company: CompanyClient,
  scope: string,
  opts: { state?: string | undefined } = {},
): Promise<PendingDirectSignIn> {
  assertScopeAllowed(company, 'direct', scope);
  const meta = company.metadata;
  const endpoint = meta.authorization_endpoint;
  if (!endpoint) throw new PoppyError('unsupported_sign_in', 'no authorization_endpoint');
  const state = opts.state ?? randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const redirectUri = company.agent.identity.redirectUri;
  const clientId = company.agent.identity.clientId;
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: sha256b64url(codeVerifier),
    code_challenge_method: 'S256',
    // 4.2, 10.8: the Company shows its consent page even for scopes granted before.
    prompt: 'consent',
  };
  const url = new URL(endpoint);
  let expiresAt: number | undefined;
  const par = meta.pushed_authorization_request_endpoint;
  if (par) {
    requireSecureUrl(par, 'pushed_authorization_request_endpoint', company.security);
    const pushed = await company.tokens.pushAuthorization(params, company.tokenDpop());
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('request_uri', pushed.requestUri);
    expiresAt = Date.now() + pushed.expiresIn * 1000;
  } else if (meta.require_pushed_authorization_requests === true) {
    throw new PoppyError('unsupported_sign_in', 'PAR is required but no endpoint is listed');
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return {
    url: url.toString(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    state,
    codeVerifier,
    redirectUri,
    scope,
    issuer: meta.issuer,
  };
}

/**
 * The redirect back (4.2): checks `state` and the RFC 9207 `iss` (exact match with the issuer we
 * started with), then exchanges the code with PKCE.
 */
export async function completeDirectSignIn(
  company: CompanyClient,
  pending: PendingDirectSignIn,
  callback: URLSearchParams,
): Promise<SignInResult> {
  if (callback.get('state') !== pending.state) {
    throw new PoppyError('state_mismatch', 'Direct Sign-In callback state does not match');
  }
  const iss = callback.get('iss');
  if (iss !== pending.issuer) {
    throw new PoppyError(
      'issuer_mismatch',
      `Direct Sign-In callback iss "${iss ?? '(missing)'}" != "${pending.issuer}" (RFC 9207)`,
    );
  }
  const error = callback.get('error');
  if (error) {
    throw new OAuthError(error, { description: callback.get('error_description') ?? undefined });
  }
  const code = callback.get('code');
  if (!code) throw new PoppyError('invalid_callback', 'callback has neither code nor error');
  const resp = await company.tokens.authorizationCode({
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    scope: pending.scope,
    dpop: company.tokenDpop(),
  });
  return company.applySignIn(resp, 'direct', pending.scope);
}

/* ------------------------------------------------------------------ Device (4.3) */

export interface DeviceSignInOptions {
  /** Shows the link and code to the User. `device_code` is never passed here. */
  /** MUST show the Company's name and domain with the link (4.3). */
  display: (info: {
    organization: { name: string; domain: string };
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string | undefined;
    expiresIn: number;
  }) => void;
  signal?: AbortSignal | undefined;
  /** Hook for tests. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onPoll?:
    | ((status: 'authorization_pending' | 'slow_down', intervalSeconds: number) => void)
    | undefined;
}

/**
 * Before showing a device link (4.3): its host is the issuer's or `organization.domain`, or a
 * subdomain of either. Otherwise a Company could pass off another's sign-in page as its own.
 */
export function assertDeviceLinkHost(company: CompanyClient, link: string): void {
  requireSecureUrl(link, 'verification_uri', company.security);
  const host = new URL(link).hostname.toLowerCase();
  const allowed = [
    new URL(company.metadata.issuer).hostname.toLowerCase(),
    new URL(`https://${company.document.organization.domain}`).hostname.toLowerCase(),
  ];
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new PoppyError('foreign_verification_uri', `${host} isn't this Company's sign-in host`);
  }
}

/** RFC 8628 device flow: start, show the code, poll every `interval`, +5s on `slow_down`. */
export async function deviceSignIn(
  company: CompanyClient,
  scope: string,
  opts: DeviceSignInOptions,
): Promise<SignInResult> {
  assertScopeAllowed(company, 'device', scope);
  const d: DeviceAuthorizationResponse = await company.tokens.deviceAuthorization(scope);
  assertDeviceLinkHost(company, d.verification_uri);
  if (d.verification_uri_complete) assertDeviceLinkHost(company, d.verification_uri_complete);
  opts.display({
    organization: {
      name: company.document.organization.name,
      domain: company.document.organization.domain,
    },
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete: d.verification_uri_complete,
    expiresIn: d.expires_in,
  });
  const wait = opts.sleep ?? sleep;
  let interval = typeof d.interval === 'number' && d.interval > 0 ? d.interval : 5;
  const deadline = Date.now() + d.expires_in * 1000;
  for (;;) {
    await wait(interval * 1000, opts.signal);
    if (Date.now() > deadline) throw new OAuthError('expired_token');
    try {
      const resp = await company.tokens.deviceToken({
        deviceCode: d.device_code,
        scope,
        dpop: company.tokenDpop(),
      });
      return await company.applySignIn(resp, 'device', scope);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.code === 'authorization_pending') {
        opts.onPoll?.('authorization_pending', interval);
        continue;
      }
      if (e.code === 'slow_down') {
        interval += 5; // RFC 8628 section 3.5
        opts.onPoll?.('slow_down', interval);
        continue;
      }
      throw e; // access_denied, expired_token, anything else: stop asking.
    }
  }
}

/**
 * One device-code exchange (4.3), for a server that cannot hold a polling loop open (the user
 * comes back and says "approved"): `'pending'` while the User has not decided, the sign-in when
 * they approved. `access_denied` / `expired_token` throw.
 */
export async function pollDeviceSignInOnce(
  company: CompanyClient,
  deviceCode: string,
  scope: string,
): Promise<SignInResult | 'pending'> {
  try {
    const resp = await company.tokens.deviceToken({
      deviceCode,
      scope,
      dpop: company.tokenDpop(),
    });
    return await company.applySignIn(resp, 'device', scope);
  } catch (e) {
    if (e instanceof OAuthError && (e.code === 'authorization_pending' || e.code === 'slow_down')) {
      return 'pending';
    }
    throw e;
  }
}

/* ------------------------------------------------- Mediated Sign-In (extension) */

export type MediatedOutcome =
  | { status: 'complete'; result: SignInResult }
  | {
      status: 'code_required';
      signInId: string;
      sentTo?: string | undefined;
      /** Seconds until the sign-in expires. */
      expiresIn?: number | undefined;
    }
  /** `invalid_grant`, `expired_token`, `access_denied`. */
  | { status: 'failed' | 'expired' | 'denied' };

/** Maps the extension's OAuth errors (section 5). Anything else, like `invalid_scope`, throws. */
function mediatedFailure(e: unknown): MediatedOutcome {
  if (!(e instanceof OAuthError)) throw e;
  switch (e.code) {
    case 'code_required': {
      const signInId = e.details?.sign_in_id;
      if (typeof signInId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(signInId)) {
        throw new PoppyError('invalid_response', 'code_required without a valid sign_in_id');
      }
      return {
        status: 'code_required',
        signInId,
        ...(typeof e.details?.sent_to === 'string' ? { sentTo: e.details.sent_to } : {}),
        ...(typeof e.details?.expires_in === 'number' ? { expiresIn: e.details.expires_in } : {}),
      };
    }
    case 'invalid_grant':
      return { status: 'failed' };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      throw e;
  }
}

/**
 * Mediated Sign-In (extension). Credentials go ONLY to the issuer's token endpoint, with this
 * grant. Secret values are never logged or echoed by this module. Transitional: prefer Direct or
 * Device when they cover the task.
 */
export async function mediatedSignIn(
  company: CompanyClient,
  scope: string,
  credentials: Record<string, string>,
): Promise<MediatedOutcome> {
  assertScopeAllowed(company, 'mediated', scope);
  const mediated = mediatedExtension(company)!;
  const missing = mediated.fields.filter((f) => typeof credentials[f.name] !== 'string');
  if (missing.length > 0) {
    throw new PoppyError(
      'missing_credentials',
      `missing: ${missing.map((f) => f.name).join(', ')}`,
    );
  }
  const sent: Record<string, string> = {};
  for (const f of mediated.fields) sent[f.name] = credentials[f.name] ?? '';
  try {
    const resp = await company.tokens.mediated({
      scope,
      credentials: sent,
      dpop: company.tokenDpop(),
    });
    return { status: 'complete', result: await company.applySignIn(resp, 'mediated', scope) };
  } catch (e) {
    return mediatedFailure(e);
  }
}

/** Sends the one-time code; the sign-in keeps the scopes of the first request (section 4). */
export async function submitMediatedCode(
  company: CompanyClient,
  scope: string,
  signInId: string,
  code: string,
): Promise<MediatedOutcome> {
  try {
    const resp = await company.tokens.mediatedCode({
      signInId,
      code,
      scope,
      dpop: company.tokenDpop(),
    });
    return { status: 'complete', result: await company.applySignIn(resp, 'mediated', scope) };
  } catch (e) {
    return mediatedFailure(e);
  }
}

/**
 * The scopes to request when a task needs more than the refresh token allows (4.7): every scope still
 * needed, including the granted ones to keep, never only the missing ones. The Company grants only
 * the scopes a sign-in names, so asking for the missing ones alone would drop the others.
 */
export function scopesForSignIn(
  company: CompanyClient,
  needed: string | string[],
  opts: { keep?: boolean | undefined } = {},
): string {
  const out = new Set(opts.keep === false ? [] : scopeSet(company.accountToken?.scope));
  for (const s of Array.isArray(needed) ? needed : scopeSet(needed)) if (s) out.add(s);
  return [...out].join(' ');
}

/**
 * The scopes a Personal Agent can request (4.7): `scopes_supported` of the issuer's metadata and of
 * the domain's protected resource metadata, or else the ones `auth.scopes` describes.
 * `poppy:browser-sign-in` only from a Company that lists a `browser_session_endpoint` (section 6).
 */
export function offeredScopes(company: CompanyClient): string[] {
  const listed = [
    ...(company.discovered.metadata?.scopes_supported ?? []),
    ...(company.discovered.resourceScopes ?? []),
  ];
  const all = listed.length > 0 ? listed : Object.keys(company.document.auth?.scopes ?? {});
  const browser = typeof company.document.web?.browser_session_endpoint === 'string';
  return [...new Set(all)].filter((s) => browser || s !== 'poppy:browser-sign-in');
}
