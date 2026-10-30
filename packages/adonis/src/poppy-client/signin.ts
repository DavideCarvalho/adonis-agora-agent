import { randomBytes } from 'node:crypto';
import type { CompanyClient, SignInResult } from './company.js';
import { OAuthError, PoppyError } from './errors.js';
import { GRANT_DEVICE_CODE, GRANT_MEDIATED_SIGN_IN } from './token_client.js';
import type { DeviceAuthorizationResponse, MediatedExtension } from './types.js';
import { requireSecureUrl, scopeSet, sha256b64url, sleep } from './util.js';

export type SignInType = 'direct' | 'device' | 'mediated';

export const MEDIATED_EXTENSION = 'mediated-sign-in';

/** The `mediated-sign-in` extension, when both `poppy.json` and the issuer offer it. */
export function mediatedExtension(company: CompanyClient): MediatedExtension | undefined {
  const entry = company.document.extensions?.[MEDIATED_EXTENSION] as MediatedExtension | undefined;
  if (entry?.version !== '1' || !company.discovered.metadata) return undefined;
  if (!company.metadata.grant_types_supported.includes(GRANT_MEDIATED_SIGN_IN)) return undefined;
  if (!Array.isArray(entry.fields) || !Array.isArray(entry.scopes)) return undefined;
  return entry;
}

/** The sign-in types the Company offers (4): the issuer's grants, plus the extension. */
export function offeredSignInTypes(company: CompanyClient): SignInType[] {
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
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scope: string;
  issuer: string;
}

/** Direct Sign-In (4.2): PKCE (S256) + random `state`, and the authorization URL to open. */
export async function startDirectSignIn(
  company: CompanyClient,
  scope: string,
): Promise<PendingDirectSignIn> {
  assertScopeAllowed(company, 'direct', scope);
  const endpoint = company.metadata.authorization_endpoint;
  if (!endpoint) throw new PoppyError('unsupported_sign_in', 'no authorization_endpoint');
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const redirectUri = company.agent.identity.redirectUri;
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', company.agent.identity.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', sha256b64url(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    url: url.toString(),
    state,
    codeVerifier,
    redirectUri,
    scope,
    issuer: company.metadata.issuer,
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
 * Before showing a device link (4.3): its host is the issuer's or one in `protected_resources`, or
 * a subdomain of either. Otherwise a Company could pass off another's sign-in page as its own.
 */
export function assertDeviceLinkHost(company: CompanyClient, link: string): void {
  requireSecureUrl(link, 'verification_uri', company.security);
  const host = new URL(link).hostname.toLowerCase();
  const allowed = [company.metadata.issuer, ...company.metadata.protected_resources].flatMap(
    (u) => {
      try {
        return [new URL(u).hostname.toLowerCase()];
      } catch {
        return [];
      }
    },
  );
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
