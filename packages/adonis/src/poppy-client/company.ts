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
import type { OperationApprover } from './operations.js';
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

/**
 * The protocol version `CompanyState` is written for. A state from 0.3 keeps its refresh token and
 * keys (they are plain OAuth and unchanged in 1.0); its Session restarts with the new headers.
 */
const STATE_PROTOCOL = '1.0';
const COMPATIBLE_STATES = ['0.3', STATE_PROTOCOL];

export interface PoppyAgentOptions extends SecurityOptions {
  store: StateStore;
  identity: AgentIdentity;
  /** Local user ("profile") the agent acts for. Defaults to `default`. */
  profile?: string | undefined;
  fetch?: FetchLike | undefined;
  log?: ((line: string) => void) | undefined;
  maxRetryAfterSeconds?: number | undefined;
  /**
   * Extensions this agent uses, by name, with the major version of each (3.3). With a Company that
   * lists the same version, each request declares it in `Poppy-Extensions` (3.4). None by default.
   */
  extensions?: Record<string, string> | undefined;
  /** Use Companies on ports other than 443, for testing (3.1). `insecureDev` implies it. */
  allowPorts?: boolean | undefined;
  /**
   * Which of the operator's agents acts (5.1), such as `travel` or `shopping`: each name gets its own
   * Agent ID at each Company, opaque and random, sent as `agent_id` in its Sessions. Leave it out for
   * an agent that is the only one: then no `agent_id` is sent.
   */
  agent?: string | undefined;
  /**
   * The Operations extension (declare `operations: '3'` in `extensions`): `approve` decides each
   * operation a Company returns, asking the User or approving on an instruction they gave
   * (Operations section 5). Without it, nothing is approved and the action isn't performed.
   */
  operations?:
    | {
        approve?: OperationApprover | undefined;
        /** Times a request carrying an approval is sent again after a failure. Default 3. */
        maxRetries?: number | undefined;
        /** Longest wait for a `503` with `Retry-After` while an operation is performed. Default 30 s. */
        maxRetryAfterSeconds?: number | undefined;
      }
    | undefined;
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

  /** Discovery (section 3) with this agent's fetch, cache and options. */
  discover(domain: string, opts: { fresh?: boolean | undefined } = {}): Promise<Discovered> {
    return discover(domain, {
      fetch: this.http.fetch,
      insecureDev: this.opts.insecureDev,
      allowPorts: this.opts.allowPorts,
      cache: this.cache,
      fresh: opts.fresh,
    });
  }

  /** Discovers a Company and loads (or creates) this user's state there, by its identifier. */
  async company(domain: string): Promise<CompanyClient> {
    const discovered = await this.discover(domain);
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
    if (!COMPATIBLE_STATES.includes(state.protocol ?? '')) {
      state.tokens = {};
      state.accountToken = undefined;
      state.sessionId = undefined;
    }
    state.protocol = STATE_PROTOCOL;
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
  forceRenew?: boolean | undefined;
}

function tokenKey(opts: TokenOptions): string {
  if (!opts.scope && !opts.resource) return DEFAULT_TOKEN_KEY;
  return `${opts.resource ?? ''}|${opts.scope ?? ''}`;
}

/** `Poppy-Extensions`: an RFC 9651 List of Strings, each with its version in `v` (3.4). */
export function formatExtensionsHeader(declared: Record<string, string>): string {
  const str = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return Object.entries(declared)
    .map(([name, version]) => `${str(name)};v=${str(version)}`)
    .join(', ');
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
    /** Only the Session header, even with a refresh token. */
    signedOut?: boolean | undefined;
  };

/** The JSON `error` of a 400/409 Session or version refusal, if it is one. */
async function jsonError(res: Response): Promise<string | undefined> {
  if (res.status !== 400) return undefined;
  const body = await readJson<{ error?: unknown }>(res.clone());
  return typeof body?.error === 'string' ? body.error : undefined;
}

/** One User at one Company: the Session, the refresh token, and requests to its endpoints. */
export class CompanyClient {
  readonly dpop: DpopKey;
  #discovered: Discovered;
  #tokens: TokenClient | undefined;
  /** Resources the Company answered `invalid_target` for: used signed out (4.5). */
  readonly #noTarget = new Set<string>();
  /** Each service's `resource`, or `null` when the default token works there (4.5). */
  readonly #resources = new Map<string, string | null>();
  #refreshing: Promise<unknown> = Promise.resolve();

  /** An anonymous browsing session (5.1): signed out only, and nothing saved. */
  readonly anonymous: boolean;

  constructor(
    readonly agent: PoppyAgent,
    discovered: Discovered,
    readonly state: CompanyState,
    options: { anonymous?: boolean | undefined } = {},
  ) {
    this.#discovered = discovered;
    this.dpop = new DpopKey(state.dpopKey);
    this.anonymous = options.anonymous === true;
  }

  /** The discovery this client works with: the chosen version's document (3.4). */
  get discovered(): Discovered {
    return this.#discovered;
  }

  /** `Poppy-Version`: the version this agent implements, compatible with the chosen document (3.4). */
  get protocolVersion(): string {
    return this.#discovered.version;
  }

  /**
   * The extensions each request declares (3.4): those this agent uses, in a version the chosen
   * document lists. Never one only a later version defines (3.4, minor versions).
   */
  get declaredExtensions(): Record<string, string> {
    const out: Record<string, string> = {};
    const listed = this.document.extensions ?? {};
    for (const [name, version] of Object.entries(this.agent.opts.extensions ?? {})) {
      const entries = listed[name];
      if (Array.isArray(entries) && entries.some((e) => e?.version === version))
        out[name] = version;
    }
    return out;
  }

  /** The version headers of every request with the Session header (3.4). */
  versionHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'poppy-version': this.protocolVersion };
    const declared = this.declaredExtensions;
    if (Object.keys(declared).length > 0) {
      headers['poppy-extensions'] = formatExtensionsHeader(declared);
    }
    return headers;
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
  /**
   * The current Session's `sid`, chosen here at random (5.2). A Session keeps its `Poppy-Version` and
   * `Poppy-Extensions`, so new values start a new Session (3.4).
   */
  get sessionId(): string {
    const versions = JSON.stringify(this.versionHeaders());
    const name = this.agentName;
    if (name !== undefined) {
      // 5.2: a Session keeps one `agent_id`, so each named agent has Sessions of its own.
      this.state.agentSessions ??= {};
      const slot = this.state.agentSessions[name] ?? {};
      this.state.agentSessions[name] = slot;
      if (slot.versions !== versions) {
        slot.sessionId = undefined;
        slot.versions = versions;
      }
      slot.sessionId ??= randomId('', 16);
      return slot.sessionId;
    }
    if (this.state.sessionVersions !== versions) {
      this.state.sessionId = undefined;
      this.state.sessionVersions = versions;
    }
    this.state.sessionId ??= randomId('', 16);
    return this.state.sessionId;
  }

  /**
   * The local name of the agent this client's Sessions are for (5.1). Never in an anonymous
   * browsing Session: an Agent ID there would tie it to the User's regular one.
   */
  get agentName(): string | undefined {
    return this.anonymous ? undefined : this.agent.opts.agent;
  }

  /**
   * This User's Agent ID for the named agent at this Company (5.1): stable, opaque, random, one per
   * Company. `undefined` without a named agent.
   */
  get agentId(): string | undefined {
    const name = this.agentName;
    if (name === undefined) return undefined;
    this.state.agentIds ??= {};
    this.state.agentIds[name] ??= randomId('agt_', 16);
    return this.state.agentIds[name];
  }

  async save() {
    if (this.anonymous) return;
    await this.agent.store.save();
  }

  /** Stops using the current `sid`; the next request starts a new Session (5.5). */
  async newSession() {
    const name = this.agentName;
    if (name !== undefined && this.state.agentSessions?.[name]) {
      this.state.agentSessions[name].sessionId = undefined;
    } else {
      this.state.sessionId = undefined;
    }
    await this.save();
  }

  /**
   * An anonymous browsing session at this Company (5.1), like a private browser window: a new User
   * ID, its own delegated key and DPoP key, no Agent ID, never an access token. Nothing of it is
   * saved; `discard()` it when the browsing session ends.
   */
  async anonymousSession(): Promise<CompanyClient> {
    const state: CompanyState = {
      issuer: this.state.issuer,
      hasIssuer: this.state.hasIssuer,
      protocol: this.state.protocol,
      domains: [...this.state.domains],
      userId: randomId('usr_'),
      dpopKey: await generateEs256Key(),
      tokens: {},
      conversations: {},
    };
    return new CompanyClient(this.agent, this.#discovered, state, { anonymous: true });
  }

  /** Ends an anonymous browsing session: its User ID, keys and Session are forgotten. */
  discard(): void {
    if (!this.anonymous)
      throw new PoppyError('not_anonymous', 'only an anonymous session is discarded');
    this.state.userId = '';
    this.state.delegation = undefined;
    this.state.sessionId = undefined;
    this.state.conversations = {};
    this.state.operations = undefined;
    this.state.browserSessions = undefined;
  }

  /** Sends a proof with token requests when the issuer's metadata lists ES256 (4.5). */
  tokenDpop(): DpopKey | undefined {
    const algs = this.metadata.dpop_signing_alg_values_supported;
    return Array.isArray(algs) && algs.includes('ES256') ? this.dpop : undefined;
  }

  /**
   * The proof key of a refresh (4.4): the key the refresh token was got with, for every refresh of it
   * and of the tokens that replace it, whatever the metadata says now. The key changes only with a
   * new sign-in.
   */
  refreshDpop(): DpopKey | undefined {
    const bound = this.accountToken?.dpop;
    if (bound === undefined) return this.tokenDpop();
    return bound ? this.dpop : undefined;
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
    if (this.anonymous && accessToken) {
      throw new PoppyError(
        'anonymous_session',
        'an anonymous session never carries an access token',
      );
    }
    if (this.anonymous && !this.state.userId) {
      throw new PoppyError('discarded', 'this anonymous session was discarded');
    }
    const name = this.agentName;
    const minted = name !== undefined && this.state.agentIds?.[name] === undefined;
    const agentId = this.agentId;
    if (minted) await this.save();
    const { key, jwt } = await this.#delegation();
    return signSessionJwt({
      key,
      delegation: jwt,
      clientId: this.agent.identity.clientId,
      audience: this.issuer,
      sid: this.sessionId,
      userId: this.userId,
      agentId,
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
    if (!this.accountToken || this.anonymous) return null;
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
    if (opts.resource && this.#noTarget.has(opts.resource)) return null;
    let resp: TokenResponse;
    try {
      resp = await this.tokens.refresh({
        refreshToken: acct.refreshToken,
        grantedScope: acct.scope,
        dpop: this.refreshDpop(),
        scope: opts.scope,
        resource: opts.resource,
      });
    } catch (e) {
      // 4.5: a service the Company doesn't offer this agent is used signed out.
      if (e instanceof OAuthError && e.code === 'invalid_target' && opts.resource) {
        this.agent.log(`invalid_target for ${opts.resource}; using it signed out`);
        this.#noTarget.add(opts.resource);
        return null;
      }
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
    if (this.anonymous) {
      throw new PoppyError('anonymous_session', 'an anonymous session never signs in (5.4)');
    }
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
      // Every grant sends `tokenDpop()`: its refreshes MUST prove the same key (4.4).
      dpop: this.tokenDpop() !== undefined,
    };
    this.#noTarget.clear();
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
      // RFC 9728 3.3: metadata whose `resource` isn't the URL it was derived from is ignored (4.5).
      const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
      if (
        typeof doc?.resource === 'string' &&
        same(doc.resource, service) &&
        !same(doc.resource, domain)
      ) {
        resource = doc.resource;
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    this.#resources.set(service, resource);
    return resource ?? undefined;
  }

  /**
   * A request to one of the Company's APIs or endpoints: the Session header with `Poppy-Version` (and
   * `Poppy-Extensions`), and, when signed in, an access token (5.2, 3.4, 4.5). Retries once on:
   * `session_ended` in a new Session (5.5); `version_unsupported` after fetching `poppy.json` again,
   * when that chooses another version (3.4); `invalid_token` after a refresh, falling back to signed
   * out when the sign-in is gone (5.5). `invalid_session` isn't retried: a new Session doesn't fix it
   * (section 7).
   */
  async fetch(url: string, init: CompanyFetchInit = {}): Promise<Response> {
    const { scope, service, signedOut, ...rest } = init;
    const method = (rest.method ?? 'GET').toUpperCase();
    const wantsAccount = !signedOut && !this.anonymous && this.accountToken !== undefined;
    let resource = init.resource;
    if (wantsAccount && resource === undefined && service) {
      resource = await this.#resourceOf(service);
    }
    delete (rest as { resource?: unknown }).resource;
    let forceRenew = false;
    let sessionRetried = false;
    let versionRetried = false;
    let tokenRetried = false;
    for (;;) {
      const rec = wantsAccount ? await this.token({ scope, resource, forceRenew }) : null;
      forceRenew = false;
      const scheme = rec?.tokenType.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
      const res = await this.http.request(url, {
        ...rest,
        headers: { ...rest.headers, ...this.versionHeaders() },
        method,
        session: () => this.sessionJwt(method, url, rec?.accessToken),
        ...(rec ? { accessToken: rec.accessToken, scheme } : {}),
        ...(scheme === 'DPoP' && rec ? { dpop: this.dpop } : {}),
      });
      const error = await jsonError(res);
      if (error === 'session_ended' && !sessionRetried) {
        sessionRetried = true;
        this.agent.log('session_ended: starting a new Session');
        await res.body?.cancel().catch(() => {});
        await this.newSession();
        continue;
      }
      if (error === 'version_unsupported' && !versionRetried) {
        versionRetried = true;
        if (await this.#chooseVersionAgain()) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        return res;
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

  /**
   * After `version_unsupported` (3.4): fetches `poppy.json` again without the cache and chooses again.
   * True when that chose another version, and a new Session uses it.
   */
  async #chooseVersionAgain(): Promise<boolean> {
    const before = `${this.protocolVersion}|${this.document.protocol_version}`;
    let again: Discovered;
    try {
      again = await this.agent.discover(this.discovered.domain, { fresh: true });
    } catch (e) {
      this.agent.log(`version_unsupported: discovery failed: ${(e as Error).message}`);
      return false;
    }
    // Every version's document selects the same issuer (3.4); anything else is another Company.
    if (again.identifier !== this.issuer) return false;
    this.#discovered = again;
    this.#tokens = undefined;
    if (`${again.version}|${again.document.protocol_version}` === before) return false;
    this.agent.log(`version_unsupported: now using ${again.document.protocol_version}`);
    await this.newSession();
    return true;
  }

  /**
   * A page of the Company's website fetched with this agent's own HTTP client, not a browser (5.2):
   * the Session header, always signed out, only on HTTPS pages whose host is `organization.domain`.
   * A redirect gets a new Session JWT only while it stays on that host. After `invalid_session` the
   * page is fetched once more without the header.
   */
  async fetchPage(url: string, init: { headers?: Record<string, string> } = {}): Promise<Response> {
    const home = this.document.organization.domain.toLowerCase();
    const onHome = (u: URL) =>
      u.host.toLowerCase() === home &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && !!this.agent.opts.insecureDev));
    let current = new URL(url);
    let withSession = true;
    for (let hop = 0; hop <= 5; hop++) {
      const signed = withSession && onHome(current);
      const target = current.toString();
      const res = await this.http.request(target, {
        method: 'GET',
        headers: { ...init.headers, ...(signed ? this.versionHeaders() : {}) },
        redirect: 'manual',
        ...(signed ? { session: () => this.sessionJwt('GET', target) } : {}),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        current = new URL(location, current);
        continue;
      }
      if (signed && (await jsonError(res)) === 'invalid_session') {
        await res.body?.cancel().catch(() => {});
        withSession = false;
        continue;
      }
      return res;
    }
    throw new PoppyError('too_many_redirects', `${url}: too many redirects`);
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
  // A code this client doesn't know is handled by the HTTP status (8.13): callers branch on `status`.
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  throw new ConversationError(code, {
    status: res.status,
    description: typeof body?.error_description === 'string' ? body.error_description : undefined,
    conversationId: typeof body?.conversation_id === 'string' ? body.conversation_id : undefined,
    protocolVersion: typeof body?.protocol_version === 'string' ? body.protocol_version : undefined,
    extension: typeof body?.extension === 'string' ? body.extension : undefined,
  });
}
