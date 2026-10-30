import {
  type Discovered,
  discover,
  HttpJsonCache,
  protectedResourceMetadataUrl,
} from './discovery.js';
import { DpopKey } from './dpop.js';
import {
  ConversationError,
  DiscoveryError,
  OAuthError,
  PoppyError,
  ResourceAuthError,
} from './errors.js';
import { PoppyHttp, type PoppyRequestInit, readJson } from './http.js';
import type { AgentIdentity } from './identity.js';
import { generateEs256Key } from './keys.js';
import { companyFetch } from './safe_fetch.js';
import { signSessionJwt } from './session_jwt.js';
import type { AccountTokenRecord, CompanyState, StateStore, TokenRecord } from './store.js';
import { type NarrowingParams, TokenClient } from './token_client.js';
import type { AuthServerMetadata, PoppyDocument, TokenResponse } from './types.js';
import {
  type FetchLike,
  nowSeconds,
  randomId,
  requireSecureUrl,
  type SecurityOptions,
  scopeSet,
  wwwAuthError,
} from './util.js';

/** The protocol version `CompanyState` is written for. */
const STATE_PROTOCOL = '0.3';

export interface PoppyAgentOptions extends SecurityOptions {
  store: StateStore;
  identity: AgentIdentity;
  /** Local user ("profile") the agent acts for. Defaults to `default`. */
  profile?: string | undefined;
  fetch?: FetchLike | undefined;
  log?: ((line: string) => void) | undefined;
  maxRetryAfterSeconds?: number | undefined;
}

/** Entry point: one agent identity, one local state file, one local user. */
export class PoppyAgent {
  readonly http: PoppyHttp;
  readonly cache = new HttpJsonCache();
  readonly profile: string;

  constructor(readonly opts: PoppyAgentOptions) {
    this.profile = opts.profile ?? 'default';
    this.http = new PoppyHttp({
      fetch: opts.fetch ?? companyFetch(opts.insecureDev),
      log: opts.log,
      maxRetryAfterSeconds: opts.maxRetryAfterSeconds,
    });
  }

  get identity() {
    return this.opts.identity;
  }
  get store() {
    return this.opts.store;
  }
  log(line: string) {
    this.opts.log?.(line);
  }

  /** Discovers a Company and loads (or creates) this user's state there, by its identifier. */
  async company(domain: string): Promise<CompanyClient> {
    const discovered = await discover(domain, {
      fetch: this.http.fetch,
      insecureDev: this.opts.insecureDev,
      cache: this.cache,
    });
    const { identifier } = discovered;
    const companies = this.store.profile(this.profile).companies;
    const org = discovered.document.organization.domain.toLowerCase();
    if (discovered.noIssuer === 'not_found') {
      // 3.2: a 404 doesn't explicitly say that an issuer we know was removed.
      const known = Object.values(companies).find((c) => c.hasIssuer && c.domains.includes(org));
      if (known) {
        throw new DiscoveryError(
          'issuer_unavailable',
          `${org} no longer publishes the issuer ${known.issuer}; not falling back to its domain`,
        );
      }
    }
    let state = companies[identifier];
    if (!state) {
      state = {
        issuer: identifier,
        domains: [],
        // 5.1: opaque, random, per Company. Never derived from personal information.
        userId: randomId('usr_'),
        dpopKey: await generateEs256Key(),
        tokens: {},
        conversations: {},
      };
      companies[identifier] = state;
    }
    // A state from before Draft 0.3: its tokens and Session belong to a protocol that's gone.
    if (state.protocol !== STATE_PROTOCOL) {
      state.protocol = STATE_PROTOCOL;
      state.tokens = {};
      state.sessionId = undefined;
    }
    state.hasIssuer = discovered.metadata !== undefined;
    if (!state.domains.includes(org)) state.domains.push(org);
    await this.store.save();
    return new CompanyClient(this, discovered, state);
  }
}

const EXPIRY_SKEW_MS = 30_000;
/** Get a new delegation when this little of the last one is left. */
const DELEGATION_RENEW_SECONDS = 3600;
const DEFAULT_TOKEN_KEY = 'default';

interface TokenOptions extends NarrowingParams {
  /** No DPoP proof: MCP servers take Bearer tokens (section 7). */
  bearer?: boolean | undefined;
  forceRenew?: boolean | undefined;
}

function tokenKey(opts: TokenOptions): string {
  if (!opts.scope && !opts.resource && !opts.bearer) return DEFAULT_TOKEN_KEY;
  return `${opts.resource ?? ''}|${opts.scope ?? ''}|${opts.bearer ? 'bearer' : ''}`;
}

export interface SignInResult {
  grantedScope: string;
  /** Requested scopes the User didn't grant (4.7: "checks scope before continuing"). */
  missingScopes: string[];
}

export type CompanyFetchInit = Omit<
  PoppyRequestInit,
  'dpop' | 'accessToken' | 'scheme' | 'session'
> &
  NarrowingParams & {
    /** The service's URL, whose protected resource metadata says if it needs its own tokens (4.5). */
    service?: string | undefined;
    bearer?: boolean | undefined;
    /** Only the Session header, even with a refresh token. */
    signedOut?: boolean | undefined;
  };

/** One User at one Company: the Session, the refresh token, and requests to its endpoints. */
export class CompanyClient {
  readonly dpop: DpopKey;
  #tokens: TokenClient | undefined;
  /** Each service's `resource`, or `null` when the default token works there (4.5). */
  readonly #resources = new Map<string, string | null>();
  #refreshing: Promise<unknown> = Promise.resolve();

  constructor(
    readonly agent: PoppyAgent,
    readonly discovered: Discovered,
    readonly state: CompanyState,
  ) {
    this.dpop = new DpopKey(state.dpopKey);
  }

  /** The Company's OAuth calls. A Company without an issuer offers no sign-in (3.2). */
  get tokens(): TokenClient {
    if (!this.discovered.metadata) {
      throw new PoppyError(
        'no_issuer',
        `${this.discovered.domain} has no OAuth issuer: it offers only signed-out Sessions`,
      );
    }
    this.#tokens ??= new TokenClient(
      this.agent.identity,
      this.discovered.metadata,
      this.agent.http,
    );
    return this.#tokens;
  }

  get document(): PoppyDocument {
    return this.discovered.document;
  }
  get metadata(): AuthServerMetadata {
    return this.tokens.metadata;
  }
  /** The Company's identifier (3.2): its issuer, or its HTTPS domain without one. */
  get issuer(): string {
    return this.discovered.identifier;
  }
  get userId(): string {
    return this.state.userId;
  }
  get http(): PoppyHttp {
    return this.agent.http;
  }
  get security(): SecurityOptions {
    return { insecureDev: this.agent.opts.insecureDev };
  }
  get accountToken(): AccountTokenRecord | undefined {
    return this.state.accountToken;
  }
  /** The current Session's `sid`, chosen here at random (5.2). */
  get sessionId(): string {
    this.state.sessionId ??= randomId('', 16);
    return this.state.sessionId;
  }

  async save() {
    await this.agent.store.save();
  }

  /** Stops using the current `sid`; the next request starts a new Session (5.5). */
  async newSession() {
    this.state.sessionId = undefined;
    await this.save();
  }

  /** Sends a proof with token requests when the issuer's metadata lists ES256 (4.5). */
  tokenDpop(): DpopKey | undefined {
    const algs = this.metadata.dpop_signing_alg_values_supported;
    return Array.isArray(algs) && algs.includes('ES256') ? this.dpop : undefined;
  }

  /** The delegated key of this User ID, with a live delegation (5.2). */
  async #delegation() {
    const current = this.state.delegation;
    if (current && current.exp - nowSeconds() > DELEGATION_RENEW_SECONDS) return current;
    const key = await generateEs256Key();
    const { jwt, exp } = await this.agent.identity.delegate(key.publicJwk);
    this.state.delegation = { key, jwt, exp };
    await this.save();
    return this.state.delegation;
  }

  /** A `Poppy-Session` JWT good for this one request (5.2). */
  async sessionJwt(method: string, url: string, accessToken?: string | undefined): Promise<string> {
    const { key, jwt } = await this.#delegation();
    return signSessionJwt({
      key,
      delegation: jwt,
      clientId: this.agent.identity.clientId,
      audience: this.issuer,
      sid: this.sessionId,
      userId: this.userId,
      method,
      url,
      accessToken,
    });
  }

  /**
   * An access token, refreshed when close to expiry, or `null` when signed out. A refresh answered
   * with `invalid_grant` means the sign-in is gone: the Session continues signed out (5.5).
   */
  async token(opts: TokenOptions = {}): Promise<TokenRecord | null> {
    if (!this.accountToken) return null;
    const key = tokenKey(opts);
    const rec = this.state.tokens[key];
    if (rec && !opts.forceRenew && rec.expiresAt - EXPIRY_SKEW_MS > Date.now()) return rec;
    // One at a time: with rotation, a second refresh would present a token the first replaced.
    const run = this.#refreshing.then(() => this.#refresh(key, opts));
    this.#refreshing = run.catch(() => {});
    return run;
  }

  async #refresh(key: string, opts: TokenOptions): Promise<TokenRecord | null> {
    const acct = this.accountToken;
    if (!acct) return null;
    let resp: TokenResponse;
    try {
      resp = await this.tokens.refresh({
        refreshToken: acct.refreshToken,
        grantedScope: acct.scope,
        dpop: opts.bearer ? undefined : this.tokenDpop(),
        scope: opts.scope,
        resource: opts.resource,
      });
    } catch (e) {
      if (!(e instanceof OAuthError) || e.code !== 'invalid_grant') throw e;
      this.agent.log('refresh token rejected (invalid_grant); continuing signed out');
      this.state.accountToken = undefined;
      this.state.tokens = {};
      await this.save();
      return null;
    }
    // 4.4: a new refresh token MUST replace the old one; none means keep using it.
    if (resp.refresh_token) acct.refreshToken = resp.refresh_token;
    const fresh: TokenRecord = {
      accessToken: resp.access_token,
      tokenType: resp.token_type,
      expiresAt: Date.now() + (resp.expires_in ?? 0) * 1000,
      scope: resp.scope ?? '',
      resource: opts.resource,
    };
    this.state.tokens[key] = fresh;
    await this.save();
    return fresh;
  }

  /** Stores the result of any sign-in type (4.7): the refresh token and the access token. */
  async applySignIn(
    resp: TokenResponse,
    via: AccountTokenRecord['via'],
    requestedScope: string,
  ): Promise<SignInResult> {
    if (!resp.refresh_token) {
      throw new OAuthError('invalid_response', {
        description: 'sign-in returned no refresh token',
      });
    }
    const old = this.state.accountToken;
    const scope = resp.scope ?? requestedScope;
    this.state.accountToken = {
      refreshToken: resp.refresh_token,
      scope,
      obtainedAt: Date.now(),
      via,
    };
    this.state.tokens = {
      [DEFAULT_TOKEN_KEY]: {
        accessToken: resp.access_token,
        tokenType: resp.token_type,
        expiresAt: Date.now() + (resp.expires_in ?? 0) * 1000,
        scope,
      },
    };
    await this.save();
    if (old && old.refreshToken !== resp.refresh_token) {
      // 4.7: the new refresh token replaces the old one, which we SHOULD revoke. Not a sign-out.
      try {
        await this.tokens.revoke(old.refreshToken);
      } catch (e) {
        this.agent.log(`could not revoke the replaced refresh token: ${(e as Error).message}`);
      }
    }
    const granted = scopeSet(scope);
    return {
      grantedScope: scope,
      missingScopes: [...scopeSet(requestedScope)].filter((s) => !granted.has(s)),
    };
  }

  /** Sign out (5.5): revoke the refresh token. Sessions carry on signed out. */
  async signOut(): Promise<boolean> {
    const acct = this.state.accountToken;
    if (!acct) return false;
    await this.tokens.revoke(acct.refreshToken, 'refresh_token');
    this.state.accountToken = undefined;
    this.state.tokens = {};
    await this.save();
    return true;
  }

  /**
   * The `resource` a service asks tokens for (4.5): its protected resource metadata, when it names
   * something other than the domain. Otherwise the default token works there.
   */
  async #resourceOf(service: string, refresh = false): Promise<string | undefined> {
    const known = this.#resources.get(service);
    if (known !== undefined && !refresh) return known ?? undefined;
    let resource: string | null = null;
    const url = protectedResourceMetadataUrl(service);
    requireSecureUrl(url.toString(), 'protected resource metadata', this.security);
    const res = await this.http.request(url.toString(), {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    if (res.ok) {
      const doc = await readJson<{ resource?: unknown }>(res);
      const domain = new URL(this.discovered.wellKnownUrl).origin;
      if (typeof doc?.resource === 'string' && doc.resource !== domain) resource = doc.resource;
    } else {
      await res.body?.cancel().catch(() => {});
    }
    this.#resources.set(service, resource);
    return resource ?? undefined;
  }

  /**
   * A request to one of the Company's APIs or endpoints: the Session header and, when signed in, an
   * access token (5.2, 4.5). `invalid_session` starts a new Session once (section 7), and
   * `invalid_token` refreshes once, falling back to signed out when the sign-in is gone (5.5).
   */
  async fetch(url: string, init: CompanyFetchInit = {}): Promise<Response> {
    const { scope, service, bearer, signedOut, ...rest } = init;
    const method = (rest.method ?? 'GET').toUpperCase();
    const wantsAccount = !signedOut && this.accountToken !== undefined;
    let resource = init.resource;
    if (wantsAccount && resource === undefined && service) {
      resource = await this.#resourceOf(service);
    }
    delete (rest as { resource?: unknown }).resource;
    let forceRenew = false;
    let sessionRetried = false;
    let tokenRetried = false;
    for (;;) {
      const rec = wantsAccount ? await this.token({ scope, resource, bearer, forceRenew }) : null;
      forceRenew = false;
      const scheme = rec?.tokenType.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
      const res = await this.http.request(url, {
        ...rest,
        method,
        session: () => this.sessionJwt(method, url, rec?.accessToken),
        ...(rec ? { accessToken: rec.accessToken, scheme } : {}),
        ...(scheme === 'DPoP' && rec ? { dpop: this.dpop } : {}),
      });
      if (res.status === 400 && !sessionRetried) {
        const body = await readJson<{ error?: unknown }>(res.clone());
        if (body?.error === 'invalid_session') {
          sessionRetried = true;
          this.agent.log('invalid_session: starting a new Session');
          await res.body?.cancel().catch(() => {});
          await this.newSession();
          continue;
        }
      }
      if (res.status === 401 && rec && !tokenRetried) {
        const err = wwwAuthError(res.headers.get('www-authenticate'));
        if (err.error === 'invalid_token') {
          tokenRetried = true;
          await res.body?.cancel().catch(() => {});
          // Stale metadata: the service says which `resource` it wants (4.5).
          if (err.resourceMetadata && service && init.resource === undefined) {
            resource = await this.#resourceOf(service, true);
          }
          forceRenew = true;
          continue;
        }
      }
      return res;
    }
  }

  /** `fetch` + JSON, mapping failures to typed errors (section 7, 8.13). */
  async json<T>(url: string, init: CompanyFetchInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(url, init);
    if (!res.ok) await throwForResponse(res);
    return { status: res.status, body: (await readJson<T>(res)) as T };
  }
}

/**
 * Maps a failed resource response to a typed error. A challenge without an error code means the
 * request needs the account: it's handled as `insufficient_scope` (section 7).
 */
export async function throwForResponse(res: Response): Promise<never> {
  const header = res.headers.get('www-authenticate');
  const auth = wwwAuthError(header);
  if (auth.error || (res.status === 401 && header)) {
    throw new ResourceAuthError(auth.error ?? 'insufficient_scope', {
      status: res.status,
      scope: auth.scope,
      description: auth.description,
    });
  }
  const body = await readJson<Record<string, unknown>>(res);
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  throw new ConversationError(code, {
    status: res.status,
    description: typeof body?.error_description === 'string' ? body.error_description : undefined,
    conversationId: typeof body?.conversation_id === 'string' ? body.conversation_id : undefined,
  });
}
