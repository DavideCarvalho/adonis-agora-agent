import type { DpopKey } from './dpop.js';
import { OAuthError } from './errors.js';
import { type PoppyHttp, readJson } from './http.js';
import type { AgentIdentity } from './identity.js';
import type { AuthServerMetadata, DeviceAuthorizationResponse, TokenResponse } from './types.js';
import { parseRetryAfter } from './util.js';

export const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
export const GRANT_MEDIATED_SIGN_IN = 'https://personalagentprotocol.org/grant/mediated-sign-in';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface NarrowingParams {
  /** Ask for fewer scopes than the refresh token has (4.4). */
  scope?: string | undefined;
  /** RFC 8707 resource indicator (4.5). */
  resource?: string | undefined;
}

/** Client-side RFC 6749 defaults for what a token response may leave out. */
const DEFAULT_EXPIRES_IN = 3600;

/**
 * OAuth calls against the Company's authorization server (section 4): every request carries a
 * `private_key_jwt` client assertion addressed to the issuer (4.1). Token requests carry a DPoP
 * proof when one is given, and the response's `token_type` says what the Company did with it (4.5).
 */
export class TokenClient {
  constructor(
    private readonly identity: AgentIdentity,
    readonly metadata: AuthServerMetadata,
    private readonly http: PoppyHttp,
  ) {}

  private async clientAuth(): Promise<Record<string, string>> {
    return {
      client_id: this.identity.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await this.identity.clientAssertion(this.metadata.issuer),
    };
  }

  /** POSTs a form; the builder runs per attempt so retries get fresh assertions. */
  private async post(
    endpoint: string,
    build: () => Promise<Record<string, string | undefined>>,
    dpop?: DpopKey | undefined,
  ): Promise<{ status: number; body: Record<string, unknown> | undefined; headers: Headers }> {
    const res = await this.http.request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      dpop,
      redirect: 'manual',
      body: async () => {
        const params = { ...(await build()), ...(await this.clientAuth()) };
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
          if (v !== undefined && v !== '') form.set(k, v);
        return form.toString();
      },
    });
    return { status: res.status, body: await readJson(res), headers: res.headers };
  }

  private toError(r: {
    status: number;
    body?: Record<string, unknown> | undefined;
    headers: Headers;
  }) {
    const code = typeof r.body?.error === 'string' ? r.body.error : `http_${r.status}`;
    return new OAuthError(code, {
      status: r.status,
      description:
        typeof r.body?.error_description === 'string' ? r.body.error_description : undefined,
      retryAfter: parseRetryAfter(r.headers.get('retry-after')),
      details: r.body,
    });
  }

  /**
   * Any token-endpoint grant (4.7). `requested` is what `scope` means when the response leaves it
   * out: the Company granted exactly the scopes requested (RFC 6749 section 5.1).
   */
  async token(
    params: () => Promise<Record<string, string | undefined>>,
    requested: string | undefined,
    dpop?: DpopKey | undefined,
  ): Promise<TokenResponse> {
    const r = await this.post(this.metadata.token_endpoint, params, dpop);
    if (r.status !== 200 || !r.body) throw this.toError(r);
    const t = r.body as unknown as TokenResponse;
    if (typeof t.access_token !== 'string' || !t.access_token) {
      throw new OAuthError('invalid_response', {
        description: 'no access_token in token response',
      });
    }
    const type = String(t.token_type).toLowerCase();
    if (type !== 'bearer' && type !== 'dpop') {
      throw new OAuthError('invalid_response', {
        description: `unsupported token_type ${t.token_type}`,
      });
    }
    if (type === 'dpop' && !dpop) {
      throw new OAuthError('invalid_response', {
        description: 'a DPoP-bound token for a request without a proof',
      });
    }
    if (typeof t.expires_in !== 'number' || !(t.expires_in > 0)) t.expires_in = DEFAULT_EXPIRES_IN;
    t.scope = typeof t.scope === 'string' ? t.scope : (requested ?? '');
    return t;
  }

  /** Refresh (4.4). A token response may leave `refresh_token` out: keep using the one you have. */
  refresh(
    input: {
      refreshToken: string;
      /** The refresh token's scopes: what `scope` means when the response omits it. */
      grantedScope: string;
      dpop?: DpopKey | undefined;
    } & NarrowingParams,
  ): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        scope: input.scope,
        resource: input.resource,
      }),
      input.scope ?? input.grantedScope,
      input.dpop,
    );
  }

  /** Direct Sign-In code exchange (4.2). */
  authorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    scope: string;
    dpop?: DpopKey | undefined;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
      input.scope,
      input.dpop,
    );
  }

  /** Device Sign-In step 1 (4.3). */
  async deviceAuthorization(scope: string): Promise<DeviceAuthorizationResponse> {
    const endpoint = this.metadata.device_authorization_endpoint;
    if (!endpoint)
      throw new OAuthError('unsupported', { description: 'no device_authorization_endpoint' });
    const r = await this.post(endpoint, async () => ({ scope }));
    if (r.status !== 200 || !r.body) throw this.toError(r);
    const d = r.body as unknown as DeviceAuthorizationResponse;
    if (!d.device_code || !d.user_code || !d.verification_uri) {
      throw new OAuthError('invalid_response', {
        description: 'incomplete device authorization response',
      });
    }
    return d;
  }

  /** Device Sign-In polling (4.3). Throws `authorization_pending` / `slow_down` etc. */
  deviceToken(input: {
    deviceCode: string;
    scope: string;
    dpop?: DpopKey | undefined;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({ grant_type: GRANT_DEVICE_CODE, device_code: input.deviceCode }),
      input.scope,
      input.dpop,
    );
  }

  /** The Mediated Sign-In grant (extension, section 3): credentials as form parameters. */
  mediated(input: {
    scope: string;
    credentials: Record<string, string>;
    dpop?: DpopKey | undefined;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({
        ...input.credentials,
        grant_type: GRANT_MEDIATED_SIGN_IN,
        scope: input.scope,
      }),
      input.scope,
      input.dpop,
    );
  }

  /** The same grant again with the one-time code, without credentials or `scope` (section 4). */
  mediatedCode(input: {
    signInId: string;
    code: string;
    scope: string;
    dpop?: DpopKey | undefined;
  }): Promise<TokenResponse> {
    return this.token(
      async () => ({
        grant_type: GRANT_MEDIATED_SIGN_IN,
        sign_in_id: input.signInId,
        one_time_code: input.code,
      }),
      input.scope,
      input.dpop,
    );
  }

  /** RFC 7009 revocation of a refresh token (4.6). */
  async revoke(token: string, hint: 'refresh_token' | 'access_token' = 'refresh_token') {
    const r = await this.post(this.metadata.revocation_endpoint, async () => ({
      token,
      token_type_hint: hint,
    }));
    if (r.status !== 200) throw this.toError(r);
  }
}
