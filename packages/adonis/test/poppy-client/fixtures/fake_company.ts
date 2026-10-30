/**
 * An in-process FAKE Poppy Company, written strictly from the spec (Draft 0.3). It doubles as a
 * conformance check of the client: every request the agent makes is verified the way a real
 * Company MUST verify it (private_key_jwt, the Session JWT and its delegation, DPoP proofs with
 * nonce/ath/jti replay, PKCE, iss, scopes, browser join rules), and violations are recorded in
 * `violations` so tests can assert there were none.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  EmbeddedJWK,
  importJWK,
  type JWK,
  jwtVerify,
} from 'jose';
import { z } from 'zod';

const MEDIATED_GRANT = 'https://personalagentprotocol.org/grant/mediated-sign-in';
const id = (p: string) => p + randomBytes(9).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

interface Session {
  key: string;
  id: string;
  clientId: string;
  userId: string;
  account?: string | undefined;
  ended?: boolean | undefined;
}
/** What a verified request is: the shape the Company's handlers use. */
interface Principal {
  sessionId: string;
  clientId: string;
  userId: string;
  scope: string;
  signedIn: boolean;
}
interface AccessToken {
  clientId: string;
  account: string;
  scope: string;
  jkt?: string | undefined;
  resource?: string | undefined;
  viaToken: string;
  exp: number;
}
interface AccountToken {
  clientId: string;
  account: string;
  scope: string;
  revoked?: boolean | undefined;
  via: string;
}
interface Conversation {
  id: string;
  clientId: string;
  owner: string; // userId, or account once used
  userId: string;
  account?: string | undefined;
  events: Record<string, unknown>[];
  status: 'working' | 'idle' | 'queued' | 'closed';
  responder: 'agent' | 'human';
  parent?: string | undefined;
  openDirect?: string | undefined;
  messageIds: Map<string, string>;
}

export interface FakeOptions {
  /** Require a DPoP nonce on token and resource requests (RFC 9449 8/9). */
  requireNonce?: boolean | undefined;
  /** Close the SSE stream right after the first `message` event (tests Last-Event-ID resume). */
  dropStreamAfterFirstMessage?: boolean | undefined;
  /** Device polls answered `authorization_pending`, then one `slow_down`, then approve. */
  devicePendingPolls?: number | undefined;
  /** Return 429 + Retry-After once on the first OpenAPI call. */
  rateLimitOnce?: boolean | undefined;
  /** Access token lifetime. */
  accessTtl?: number | undefined;
  /** Rotate the refresh token on refresh. */
  rotateAccountToken?: boolean | undefined;
  /** No `dpop_signing_alg_values_supported`: the Company issues Bearer tokens. */
  noDpop?: boolean | undefined;
  /** Valid protected resource metadata with no authorization servers: signed-out only. */
  noIssuer?: boolean | undefined;
  /** A service with its own tokens: `/api` publishes metadata whose `resource` isn't the domain. */
  apiResource?: boolean | undefined;
}

export class FakeCompany {
  server!: Server;
  origin = '';
  readonly violations: string[] = [];
  readonly log: string[] = [];
  /** The user revokes the agent at this Company: refresh tokens die, Sessions are signed out. */
  revokeAtCompany(): void {
    for (const at of this.accountTokens.values()) at.revoked = true;
  }

  /** Answer every MCP request 401 with a bare JSON body, no WWW-Authenticate (as some servers do). */
  bareMcpErrors = false;
  /** Trips `book_trip` committed, and its outstanding preview tokens. */
  readonly trips: string[] = [];
  readonly tripTokens = new Map<string, string>();
  readonly sessions = new Map<string, Session>();
  readonly tokens = new Map<string, AccessToken>();
  readonly accountTokens = new Map<string, AccountToken>();
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string; used?: boolean }
  >();
  readonly devices = new Map<
    string,
    { clientId: string; scope: string; polls: number; lastPoll?: number }
  >();
  readonly mediated = new Map<string, { clientId: string; scope: string; attempts: number }>();
  readonly conversations = new Map<string, Conversation>();
  readonly seenJti = new Set<string>();
  readonly lastEventIdHeaders: string[] = [];
  readonly browserJoins: { sessionId: string; account?: string | undefined }[] = [];
  readonly browserCodes = new Map<
    string,
    { cookie: string; sessionId?: string; account?: string | undefined; used?: boolean }
  >();
  readonly feedback: unknown[] = [];
  /** Answer feedback with this alternative (HTTP 200) instead of 202. */
  feedbackAlternative: unknown;
  /** Delegated key thumbprint → the one User ID it may sign for (5.2). */
  private readonly delegatedKeys = new Map<string, string>();
  private nonce = id('n_');
  private rateLimited = false;
  private subscribers = new Map<string, Set<(chunk: string) => void>>();
  private clientCache = new Map<
    string,
    { metadata: Record<string, unknown>; jwks: { keys: JWK[] } }
  >();
  mcpCalls = 0;

  constructor(readonly opts: FakeOptions = {}) {}

  get issuer() {
    return this.opts.noIssuer ? undefined : this.origin;
  }
  get identifier() {
    return this.origin;
  }
  get domain() {
    return new URL(this.origin).host;
  }
  get tokenEndpoint() {
    return `${this.origin}/oauth/token`;
  }
  get mcpUrl() {
    return `${this.origin}/mcp`;
  }

  async start(port = 0) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.violations.push(`server error: ${(e as Error).stack}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    for (const set of this.subscribers.values()) set.clear();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  poppyJson() {
    return {
      protocol_version: '0.3',
      organization: { name: 'Fake Co', domain: '127.0.0.1' },
      auth: {
        scopes: {
          'orders:read': 'See your orders',
          'orders:write': 'Change your orders',
          addresses: 'Manage saved shipping addresses',
        },
        scope_hints: {
          'orders:read': { changes: 'none', personal_data: true },
          'orders:write': { changes: 'irreversible', personal_data: true },
        },
        future_field: 'ignored',
      },
      agent: {
        protocols: [
          { type: 'something-else', endpoint: 'https://ignored.example/x' },
          { type: 'poppy', endpoint: `${this.origin}/poppy/conversations` },
        ],
      },
      web: { browser_session_endpoint: `${this.origin}/poppy/browser-session` },
      feedback: { endpoint: `${this.origin}/poppy/feedback` },
      excluded_tasks: { url: `${this.origin}/poppy/excluded-tasks.json` },
      apis: [
        { type: 'graphql', url: 'https://ignored.example/graphql', description: 'unknown type' },
        { type: 'openapi', url: `${this.origin}/openapi.json`, description: 'Orders' },
        { type: 'mcp', url: this.mcpUrl, description: 'Tools' },
      ],
      extensions: {
        'example.com/unknown': { version: '9' },
        'mediated-sign-in': {
          version: '1',
          fields: [
            { name: 'email', label: 'Email', secret: false },
            { name: 'password', label: 'Password', secret: true },
          ],
          scopes: ['orders:read'],
        },
      },
    };
  }

  /* ------------------------------------------------------------------ helpers */

  private send(
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  private oauthError(
    res: ServerResponse,
    status: number,
    error: string,
    extra: Record<string, string> = {},
  ) {
    this.log.push(`oauth error ${error}`);
    this.send(res, status, { error }, extra);
  }
  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  private violation(msg: string) {
    this.violations.push(msg);
  }

  /** Fetches and checks the agent's Client ID Metadata Document (4.1). */
  private async client(clientId: string) {
    const cached = this.clientCache.get(clientId);
    if (cached) return cached;
    const res = await fetch(clientId);
    if (!res.ok) throw new Error('client metadata unreachable');
    const metadata = (await res.json()) as Record<string, unknown>;
    if (metadata.client_id !== clientId) this.violation('client_id != metadata URL');
    if (metadata.token_endpoint_auth_method !== 'private_key_jwt') this.violation('auth method');
    const host = new URL(clientId).host;
    const jwksUri = String(metadata.jwks_uri);
    if (new URL(jwksUri).host !== host) this.violation('jwks_uri not on client_id domain');
    for (const r of metadata.redirect_uris as string[]) {
      if (new URL(r).host !== host) this.violation('redirect_uri not on client_id domain');
    }
    const jwks = (await (await fetch(jwksUri)).json()) as { keys: JWK[] };
    for (const k of jwks.keys) if ('d' in k) this.violation('private key material in JWKS');
    const entry = { metadata, jwks };
    this.clientCache.set(clientId, entry);
    return entry;
  }

  private checkJti(jti: unknown, what: string): boolean {
    if (typeof jti !== 'string' || Buffer.from(jti, 'base64url').length < 16) {
      this.violation(`${what}: jti must carry >= 128 random bits`);
      return false;
    }
    if (this.seenJti.has(jti)) {
      this.violation(`${what}: jti replayed`);
      return false;
    }
    this.seenJti.add(jti);
    return true;
  }

  /** private_key_jwt (4.1): `aud` is the issuer, as a single string. Returns the client_id. */
  private async clientAuth(form: URLSearchParams): Promise<string | undefined> {
    const clientId = form.get('client_id');
    if (!clientId) return undefined;
    if (
      form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    ) {
      this.violation('client_assertion_type');
      return undefined;
    }
    const { jwks } = await this.client(clientId);
    try {
      const { payload } = await jwtVerify(
        form.get('client_assertion') ?? '',
        createLocalJWKSet(jwks),
        {
          issuer: clientId,
          subject: clientId,
          audience: this.origin,
          algorithms: ['ES256'],
        },
      );
      if (typeof payload.aud !== 'string')
        this.violation('client assertion aud should be a single string');
      if (!this.checkJti(payload.jti, 'client assertion')) return undefined;
      return clientId;
    } catch (e) {
      this.violation(`client assertion: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Verifies a DPoP proof (RFC 9449 4.3). Returns jkt, or an error code. */
  private async dpop(
    req: IncomingMessage,
    url: string,
    accessToken?: string,
  ): Promise<{ jkt?: string; error?: string }> {
    const proof = req.headers.dpop;
    if (typeof proof !== 'string') return { error: 'invalid_dpop_proof' };
    try {
      const header = decodeProtectedHeader(proof);
      if (header.typ !== 'dpop+jwt') this.violation('DPoP typ');
      if (header.alg !== 'ES256') this.violation('DPoP alg');
      if (!header.jwk || 'd' in header.jwk) this.violation('DPoP jwk missing or private');
      const { payload } = await jwtVerify(proof, EmbeddedJWK, {
        typ: 'dpop+jwt',
        algorithms: ['ES256'],
      });
      if (payload.htm !== req.method) this.violation(`DPoP htm ${payload.htm} != ${req.method}`);
      const htu = new URL(url);
      htu.search = '';
      if (payload.htu !== htu.toString()) this.violation(`DPoP htu ${payload.htu} != ${htu}`);
      if (typeof payload.iat !== 'number' || Math.abs(now() - payload.iat) > 60)
        this.violation('DPoP iat');
      if (!this.checkJti(payload.jti, 'DPoP')) return { error: 'invalid_dpop_proof' };
      if (accessToken) {
        const ath = createHash('sha256').update(accessToken).digest('base64url');
        if (payload.ath !== ath) this.violation('DPoP ath mismatch');
      } else if (payload.ath !== undefined)
        this.violation('token endpoint proof must not have ath');
      if (this.opts.requireNonce && payload.nonce !== this.nonce)
        return { error: 'use_dpop_nonce' };
      return { jkt: await calculateJwkThumbprint(header.jwk as JWK) };
    } catch (e) {
      this.violation(`DPoP: ${(e as Error).message}`);
      return { error: 'invalid_dpop_proof' };
    }
  }

  private issue(
    res: ServerResponse,
    grant: { clientId: string; account: string; viaToken: string },
    opts: {
      jkt?: string | undefined;
      scope: string;
      resource?: string | undefined;
      refreshToken?: string | undefined;
    },
  ) {
    const access = id('at_');
    this.tokens.set(access, {
      ...grant,
      scope: opts.scope,
      jkt: opts.jkt,
      resource: opts.resource,
      exp: now() + (this.opts.accessTtl ?? 3600),
    });
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: opts.jkt ? 'DPoP' : 'Bearer',
      expires_in: this.opts.accessTtl ?? 3600,
      scope: opts.scope,
      unknown_future_field: true,
    };
    if (opts.refreshToken) body.refresh_token = opts.refreshToken;
    this.send(res, 200, body);
  }
  private narrow(requested: string | null, allowed: string): string | null {
    if (!requested) return allowed;
    const allow = new Set(allowed.split(' ').filter(Boolean));
    const req = requested.split(' ').filter(Boolean);
    return req.every((s) => allow.has(s)) ? req.join(' ') : null;
  }

  /** End of every sign-in type (4.7): a refresh token. The server doesn't know the Session. */
  private signIn(clientId: string, scope: string, via: string) {
    const account = 'acct_1';
    const rt = id('pat_');
    this.accountTokens.set(rt, { clientId, account, scope, via });
    return { rt, grant: { clientId, account, viaToken: rt } };
  }
  /* ------------------------------------------------------------------ router */

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.origin);
    const p = url.pathname;
    this.log.push(`${req.method} ${p}`);
    if (p === '/.well-known/poppy.json')
      return this.send(res, 200, this.poppyJson(), { 'cache-control': 'max-age=60' });
    if (p === '/.well-known/oauth-protected-resource') {
      return this.send(res, 200, {
        resource: this.origin,
        ...(this.opts.noIssuer ? {} : { authorization_servers: [this.origin] }),
      });
    }
    if (p === '/.well-known/oauth-protected-resource/mcp') {
      return this.send(res, 200, {
        resource: this.mcpUrl,
        ...(this.opts.noIssuer ? {} : { authorization_servers: [this.origin] }),
      });
    }
    if (p === '/.well-known/oauth-protected-resource/api' && this.opts.apiResource) {
      return this.send(res, 200, { resource: `${this.origin}/api` });
    }
    if (p === '/.well-known/oauth-authorization-server') {
      return this.send(res, 200, {
        issuer: this.origin,
        token_endpoint: this.tokenEndpoint,
        revocation_endpoint: `${this.origin}/oauth/revoke`,
        authorization_endpoint: `${this.origin}/oauth/authorize`,
        device_authorization_endpoint: `${this.origin}/oauth/device`,
        grant_types_supported: [
          'refresh_token',
          'authorization_code',
          'urn:ietf:params:oauth:grant-type:device_code',
          MEDIATED_GRANT,
        ],
        scopes_supported: ['orders:read', 'orders:write', 'addresses'],
        protected_resources: [this.origin, 'https://fake.example', this.mcpUrl],
        ...(this.opts.noDpop ? {} : { dpop_signing_alg_values_supported: ['ES256'] }),
        some_other_field: 'ignored',
      });
    }
    if (p === '/oauth/token' && req.method === 'POST') return this.token(req, res);
    if (p === '/oauth/revoke' && req.method === 'POST') return this.revoke(req, res);
    if (p === '/oauth/authorize') return this.authorize(url, res);
    if (p === '/oauth/device' && req.method === 'POST') return this.deviceAuthorize(req, res);
    if (p === '/device/approve') {
      // Simulates the User approving on another device.
      const d = [...this.devices.values()].find(() => true);
      if (d) d.polls = Number.POSITIVE_INFINITY;
      return this.send(res, 200, {});
    }
    if (p === '/poppy/browser-session' && req.method === 'GET') return this.browserPage(res);
    if (p === '/poppy/browser-session/authorize' && req.method === 'POST')
      return this.browserAuthorize(req, res, url);
    if (p === '/poppy/browser-session' && req.method === 'POST')
      return this.browserSession(req, res);
    if (p === '/poppy/feedback' && req.method === 'POST') return this.feedbackRoute(req, res, url);
    if (p === '/poppy/excluded-tasks.json') {
      return this.send(res, 200, {
        tasks: [
          {
            task: 'Send a wire transfer',
            alternative: {
              instructions: 'Only in the app',
              references: [
                { type: 'web', url: `${this.origin}/wire` },
                { type: 'openapi', url: 'https://evil.example/openapi.json', operation_id: 'x' },
                { type: 'future', url: 'x' },
              ],
            },
          },
          { task: 'Close an account' },
        ],
      });
    }
    if (p.startsWith('/poppy/conversations')) return this.conversationsRoute(req, res, url);
    if (p === '/openapi.json') {
      return this.send(res, 200, {
        openapi: '3.1.0',
        info: { title: 'Fake', version: '1' },
        servers: [{ url: '/api' }],
        paths: {
          '/public': { get: { summary: 'Public info' } },
          '/orders': { get: { summary: 'Your orders (orders:read)' } },
          '/addresses': { post: { summary: 'Add an address (addresses)' } },
        },
      });
    }
    if (p.startsWith('/api/')) return this.api(req, res, url);
    if (p === '/mcp') return this.mcp(req, res, url);
    this.send(res, 404, { error: 'not_found' });
  }

  /* ------------------------------------------------------------------ token endpoint */

  private async token(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    if (form.has('session_id')) this.violation('session_id sent to the token endpoint');
    if (req.headers['poppy-session']) this.violation('Session header sent to the token endpoint');
    let jkt: string | undefined;
    if (req.headers.dpop) {
      if (this.opts.noDpop) this.violation('DPoP proof for an issuer that lists no algorithms');
      const d = await this.dpop(req, this.tokenEndpoint);
      if (d.error === 'use_dpop_nonce')
        return this.oauthError(res, 400, 'use_dpop_nonce', { 'dpop-nonce': this.nonce });
      if (d.error) return this.oauthError(res, 400, d.error);
      jkt = d.jkt;
    }
    const resource = form.get('resource') ?? undefined;
    if (resource && resource !== this.mcpUrl && resource !== `${this.origin}/api`) {
      return this.oauthError(res, 400, 'invalid_target');
    }
    if (resource === this.mcpUrl) jkt = undefined; // Bearer is the MCP baseline (7).
    const grant = form.get('grant_type');
    const scopeReq = form.get('scope');
    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      const at = this.accountTokens.get(rt);
      if (!at || at.revoked || at.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      const scope = this.narrow(scopeReq, at.scope);
      if (scope === null) return this.oauthError(res, 400, 'invalid_scope');
      let rotated: string | undefined;
      if (this.opts.rotateAccountToken) {
        at.revoked = true;
        rotated = id('pat_');
        this.accountTokens.set(rotated, { ...at, revoked: false });
      }
      return this.issue(
        res,
        { clientId, account: at.account, viaToken: rotated ?? rt },
        { jkt, scope, resource, refreshToken: rotated },
      );
    }
    if (grant === 'authorization_code') {
      const c = this.codes.get(form.get('code') ?? '');
      if (!c || c.used || c.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      c.used = true;
      if (form.get('redirect_uri') !== c.redirectUri)
        return this.oauthError(res, 400, 'invalid_grant');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) {
        this.violation('PKCE verifier mismatch');
        return this.oauthError(res, 400, 'invalid_grant');
      }
      const { rt, grant: g } = this.signIn(clientId, c.scope, 'direct');
      return this.issue(res, g, { jkt, scope: c.scope, refreshToken: rt });
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const d = this.devices.get(form.get('device_code') ?? '');
      if (!d || d.clientId !== clientId) return this.oauthError(res, 400, 'invalid_grant');
      d.polls++;
      const pending = this.opts.devicePendingPolls ?? 1;
      if (d.polls <= pending) return this.oauthError(res, 400, 'authorization_pending');
      if (d.polls === pending + 1) return this.oauthError(res, 400, 'slow_down');
      this.devices.delete(form.get('device_code')!);
      const { rt, grant: g } = this.signIn(clientId, d.scope, 'device');
      return this.issue(res, g, { jkt, scope: d.scope, refreshToken: rt });
    }
    if (grant === MEDIATED_GRANT) return this.mediatedGrant(res, form, clientId, jkt);
    return this.oauthError(res, 400, 'unsupported_grant_type');
  }
  /* ------------------------------------------------------------------ mediated */
  private mediatedGrant(
    res: ServerResponse,
    form: URLSearchParams,
    clientId: string,
    jkt: string | undefined,
  ) {
    const signInId = form.get('sign_in_id');
    if (signInId) {
      if (form.has('email') || form.has('password') || form.has('scope'))
        this.violation('credentials or scope re-sent with the one-time code');
      const pending = this.mediated.get(signInId);
      if (!pending || pending.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      if (form.get('one_time_code') !== '123456') {
        pending.attempts++;
        if (pending.attempts >= 3) {
          this.mediated.delete(signInId);
          return this.oauthError(res, 400, 'invalid_grant');
        }
        return this.send(res, 400, {
          error: 'code_required',
          sign_in_id: signInId,
          sent_to: 'x',
          expires_in: 600,
        });
      }
      this.mediated.delete(signInId);
      const { rt, grant } = this.signIn(clientId, pending.scope, 'mediated');
      return this.issue(res, grant, { jkt, scope: pending.scope, refreshToken: rt });
    }
    if (form.get('scope') !== 'orders:read') return this.oauthError(res, 400, 'invalid_scope');
    if (form.get('email') !== 'dana@example.com' || form.get('password') !== 'hunter2') {
      return this.oauthError(res, 400, 'invalid_grant');
    }
    const id2 = id('sgn_');
    this.mediated.set(id2, { clientId, scope: 'orders:read', attempts: 0 });
    this.send(res, 400, {
      error: 'code_required',
      sign_in_id: id2,
      sent_to: 'Text to the phone number ending in 71',
      expires_in: 600,
    });
  }
  private async revoke(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    if (form.get('token_type_hint') !== 'refresh_token')
      this.violation('revocation without token_type_hint=refresh_token');
    const at = this.accountTokens.get(form.get('token') ?? '');
    if (at && at.clientId === clientId) at.revoked = true;
    this.send(res, 200);
  }
  private async authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const { metadata } = await this.client(clientId);
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!(metadata.redirect_uris as string[]).includes(redirectUri)) {
      this.violation('redirect_uri not registered');
      return this.send(res, 400, { error: 'invalid_request' });
    }
    if (q.get('response_type') !== 'code') this.violation('response_type');
    if (q.get('code_challenge_method') !== 'S256') this.violation('PKCE method must be S256');
    if (!q.get('state')) this.violation('missing state');
    const scope = q.get('scope') ?? '';
    if (!scope) this.violation('sign-in without scope');
    const back = new URL(redirectUri);
    back.searchParams.set('state', q.get('state') ?? '');
    back.searchParams.set('iss', this.origin);
    if (q.get('login_hint') === 'deny') {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = id('code_');
      this.codes.set(code, {
        clientId,
        redirectUri,
        challenge: q.get('code_challenge') ?? '',
        scope,
      });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  private async deviceAuthorize(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    const scope = form.get('scope') ?? '';
    if (!scope.split(' ').every((s) => ['orders:read', 'orders:write', 'addresses'].includes(s)))
      return this.oauthError(res, 400, 'invalid_scope');
    const deviceCode = id('dc_');
    this.devices.set(deviceCode, { clientId, scope, polls: 0 });
    this.send(res, 200, {
      device_code: deviceCode,
      user_code: 'WDJB-MJHT',
      verification_uri: `${this.origin}/device`,
      verification_uri_complete: `${this.origin}/device?user_code=WDJB-MJHT`,
      expires_in: 600,
      interval: 1,
    });
  }

  /* ------------------------------------------------------------------ resource auth */

  /** Verifies the `Poppy-Session` JWT and its delegation (5.2, 5.3). */
  private async verifySession(
    req: IncomingMessage,
    url: URL,
    token: string | undefined,
  ): Promise<{ clientId: string; sid: string; sub: string } | string> {
    const jwt = req.headers['poppy-session'];
    if (typeof jwt !== 'string') {
      this.violation(`no Session header on ${req.method} ${url.pathname}`);
      return 'no Session header';
    }
    const fail = (why: string) => {
      this.violation(`Session JWT: ${why}`);
      return why;
    };
    try {
      const h = decodeProtectedHeader(jwt);
      if (h.typ !== 'poppy-session+jwt') return fail('typ');
      if (h.alg !== 'ES256') return fail('alg');
      if (typeof h.pap_dlg !== 'string') return fail('no pap_dlg');
      const claims = decodeJwt(jwt);
      const clientId = String(claims.iss);
      const { jwks } = await this.client(clientId);
      const { payload: dlg, protectedHeader: dh } = await jwtVerify(
        h.pap_dlg,
        createLocalJWKSet(jwks),
        { typ: 'pap-delegation+jwt', issuer: clientId, algorithms: ['ES256'] },
      );
      if (dh.typ !== 'pap-delegation+jwt') return fail('delegation typ');
      if (!dlg.iat || !dlg.exp || dlg.exp - dlg.iat > 24 * 3600) return fail('delegation lifetime');
      if ('sub' in dlg || 'aud' in dlg) return fail('delegation names a User or Company');
      const jwk = (dlg.cnf as { jwk: JWK }).jwk;
      if ('d' in jwk) return fail('private key in delegation');
      const thumb = await calculateJwkThumbprint(jwk);
      if (h.kid !== thumb) return fail('kid is not the thumbprint');
      const { payload } = await jwtVerify(jwt, await importJWK(jwk, 'ES256'), {
        typ: 'poppy-session+jwt',
        algorithms: ['ES256'],
      });
      if (payload.aud !== this.identifier) return fail(`aud ${String(payload.aud)}`);
      if (payload.htm !== req.method) return fail(`htm ${String(payload.htm)}`);
      const htu = new URL(url);
      htu.search = '';
      if (payload.htu !== htu.toString()) return fail(`htu ${String(payload.htu)}`);
      if (typeof payload.iat !== 'number' || Math.abs(now() - payload.iat) > 60) return fail('iat');
      if (!this.checkJti(payload.jti, 'Session JWT')) return 'jti';
      if (typeof payload.sid !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(payload.sid))
        return fail('sid');
      const sub = String(payload.sub);
      if (!/^usr_[A-Za-z0-9_-]{16,}$/.test(sub)) return fail(`User ID looks non-opaque: ${sub}`);
      const owner = this.delegatedKeys.get(thumb);
      if (owner && owner !== sub) return fail('a delegated key signed for two User IDs');
      this.delegatedKeys.set(thumb, sub);
      const ath = token ? createHash('sha256').update(token).digest('base64url') : undefined;
      if (payload.ath !== ath) return fail('ath');
      return { clientId, sid: payload.sid, sub };
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  /** The Session header, then the access token if any (5.3, 4.5). */
  private async resourceAuth(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<Principal | undefined> {
    const auth = req.headers.authorization ?? '';
    if (url.search.includes('access_token')) this.violation('token in URL');
    const [scheme, token] = auth.split(' ');
    const v = await this.verifySession(req, url, token);
    if (typeof v === 'string') {
      this.send(res, 400, { error: 'invalid_session', error_description: v });
      return undefined;
    }
    let signedIn: AccessToken | undefined;
    if (token) {
      const t = this.tokens.get(token);
      const chall = { 'www-authenticate': `${t?.jkt ? 'DPoP' : 'Bearer'} error="invalid_token"` };
      if (!t || t.exp < now() || this.accountTokens.get(t.viaToken)?.revoked) {
        this.send(res, 401, undefined, chall);
        return undefined;
      }
      if (t.clientId !== v.clientId) {
        this.send(res, 400, { error: 'invalid_session' });
        return undefined;
      }
      if (scheme !== (t.jkt ? 'DPoP' : 'Bearer')) {
        this.violation(`token sent with scheme ${scheme}`);
        this.send(res, 401, undefined, chall);
        return undefined;
      }
      const wanted =
        url.pathname.startsWith('/api/') && this.opts.apiResource
          ? `${this.origin}/api`
          : undefined;
      if ((url.pathname === '/mcp' ? this.mcpUrl : wanted) !== t.resource) {
        this.send(res, 401, undefined, {
          'www-authenticate': `Bearer error="invalid_token", resource_metadata="${this.origin}/.well-known/oauth-protected-resource${url.pathname === '/mcp' ? '/mcp' : '/api'}"`,
        });
        return undefined;
      }
      if (t.jkt) {
        const d = await this.dpop(req, url.toString(), token);
        if (d.error === 'use_dpop_nonce') {
          this.send(res, 401, undefined, {
            'www-authenticate': 'DPoP error="use_dpop_nonce"',
            'dpop-nonce': this.nonce,
          });
          return undefined;
        }
        if (d.error || d.jkt !== t.jkt) {
          if (!d.error) this.violation('DPoP key does not match token binding');
          this.send(res, 401, undefined, { 'www-authenticate': 'DPoP error="invalid_dpop_proof"' });
          return undefined;
        }
      }
      signedIn = t;
    } else if (req.headers.dpop) {
      this.violation('DPoP proof without an access token');
    }
    const key = `${v.clientId}|${v.sid}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, id: v.sid, clientId: v.clientId, userId: v.sub };
      this.sessions.set(key, s);
    }
    if (s.ended || s.userId !== v.sub) {
      this.send(res, 400, { error: 'invalid_session' });
      return undefined;
    }
    if (signedIn) {
      if (s.account && s.account !== signedIn.account) {
        this.send(res, 400, { error: 'invalid_session' });
        return undefined;
      }
      s.account = signedIn.account;
    }
    return {
      sessionId: s.id,
      clientId: s.clientId,
      userId: s.userId,
      scope: signedIn?.scope ?? '',
      signedIn: signedIn !== undefined,
    };
  }
  private async api(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (this.opts.rateLimitOnce && !this.rateLimited) {
      this.rateLimited = true;
      return this.send(res, 429, undefined, { 'retry-after': '1' });
    }
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const scopes = new Set(t.scope.split(' '));
    if (url.pathname === '/api/public')
      return this.send(res, 200, { hello: 'world', signed_in: t.signedIn });
    if (url.pathname === '/api/orders') {
      if (!t.signedIn)
        return this.send(res, 401, undefined, { 'www-authenticate': 'Bearer scope="orders:read"' });
      if (!scopes.has('orders:read')) {
        return this.send(res, 403, undefined, {
          'www-authenticate': 'Bearer error="insufficient_scope", scope="orders:read"',
        });
      }
      return this.send(res, 200, { orders: [{ id: 'ord_1042', item: 'jacket' }] });
    }
    if (url.pathname === '/api/addresses') {
      if (!t.signedIn)
        return this.send(res, 401, undefined, { 'www-authenticate': 'Bearer scope="addresses"' });
      if (!scopes.has('addresses')) {
        return this.send(res, 403, undefined, {
          'www-authenticate': 'Bearer error="insufficient_scope", scope="addresses"',
        });
      }
      return this.send(res, 201, { ok: true });
    }
    this.send(res, 404, { error: 'not_found' });
  }

  /* ------------------------------------------------------------------ browser join (6) */
  private browserPage(res: ServerResponse) {
    const code = id('bc_');
    const cookie = id('jc_');
    this.browserCodes.set(code, { cookie });
    res.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
      'set-cookie': `__Host-poppy_join=${cookie}; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Strict`,
    });
    res.end(
      `<!doctype html><form method="post" action="/poppy/browser-session"><input type="hidden" name="code" value="${code}"><button>Continue</button></form>`,
    );
  }
  private async browserAuthorize(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const body = JSON.parse((await this.body(req)) || '{}');
    const entry = this.browserCodes.get(String(body.code));
    if (!entry || entry.sessionId) return this.send(res, 400, { error: 'invalid_request' });
    entry.sessionId = t.sessionId;
    entry.account = t.signedIn ? 'acct_1' : undefined;
    res.writeHead(204);
    res.end();
  }
  private async browserSession(req: IncomingMessage, res: ServerResponse) {
    if (new URL(req.url ?? '/', this.origin).search) this.violation('browser join with a query');
    const form = new URLSearchParams(await this.body(req));
    const entry = this.browserCodes.get(form.get('code') ?? '');
    const cookie = /__Host-poppy_join=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!entry || entry.used || !entry.sessionId || entry.cookie !== cookie) {
      if (entry) entry.used = true;
      res.writeHead(400).end('bad join');
      return;
    }
    entry.used = true;
    this.browserJoins.push({ sessionId: entry.sessionId, account: entry.account });
    res.writeHead(303, {
      location: '/',
      'set-cookie': `__Host-fake_session=${entry.sessionId}; Path=/; Secure; HttpOnly`,
    });
    res.end();
  }
  /* ------------------------------------------------------------------ feedback (9.3) */
  private async feedbackRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const body = JSON.parse((await this.body(req)) || '{}');
    if ('kind' in body) this.violation('feedback has no kind in 0.3');
    this.feedback.push(body);
    if (this.feedbackAlternative) return this.send(res, 200, this.feedbackAlternative);
    res.writeHead(202);
    res.end();
  }
  /* ------------------------------------------------------------------ MCP */

  private async mcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (this.bareMcpErrors) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'token invalid, expired or revoked' }));
    }
    if ((req.headers.authorization ?? '').startsWith('DPoP')) {
      this.violation('DPoP token sent to MCP');
    }
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    this.mcpCalls++;
    const raw = req.method === 'POST' ? await this.body(req) : undefined;
    const rpc = raw ? JSON.parse(raw) : undefined;
    // `place_order` needs orders:write: refused before it runs, with a challenge (7).
    if (rpc?.method === 'tools/call' && rpc.params?.name === 'place_order') {
      if (!t.signedIn) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer scope="orders:write", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      if (!` ${t.scope} `.includes(' orders:write ')) {
        res.writeHead(403, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer error="insufficient_scope", scope="orders:write"',
        });
        return res.end(JSON.stringify({ error: 'insufficient_scope' }));
      }
    }
    const server = new McpServer({ name: 'fake-co', version: '1.0.0' });
    server.registerTool(
      'whoami',
      { description: 'Who the session is', inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({
        content: [
          { type: 'text', text: JSON.stringify({ signed_in: t.signedIn, scope: t.scope }) },
        ],
      }),
    );
    server.registerTool(
      'search_products',
      {
        description: 'Search products',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => ({
        content: [{ type: 'text', text: `Found: insulated ${query}, size M, $70` }],
      }),
    );
    server.registerTool(
      'place_order',
      { description: 'Place an order', inputSchema: { sku: z.string() } },
      async ({ sku }) => ({
        content: [{ type: 'text', text: `ordered ${sku}` }],
      }),
    );
    // Confirms in two steps (the `confirm` / `confirmToken` convention): without `confirm` it only
    // previews; with it and the preview's token it books.
    server.registerTool(
      'book_trip',
      {
        description: 'Book a trip (two-step confirmation)',
        inputSchema: {
          city: z.string(),
          confirm: z.boolean().optional(),
          confirmToken: z.string().optional(),
        },
      },
      async ({ city, confirm, confirmToken }) => {
        if (!confirm) {
          const token = id('ct_');
          this.tripTokens.set(token, city);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'preview',
                  summary: `Preview: book a trip to ${city}.`,
                  confirmToken: token,
                }),
              },
            ],
          };
        }
        if (!confirmToken || this.tripTokens.get(confirmToken) !== city) {
          return { isError: true, content: [{ type: 'text', text: 'invalid confirmToken' }] };
        }
        this.tripTokens.delete(confirmToken);
        this.trips.push(city);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'booked', city }) }] };
      },
    );
    // Stateless (no session id); the SDK's option types disagree under exactOptionalPropertyTypes.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, rpc);
  }

  /* ------------------------------------------------------------------ conversations */

  private push(c: Conversation, ev: Record<string, unknown>) {
    const full = { id: id('evt_'), created_at: new Date().toISOString(), ...ev };
    c.events.push(full);
    for (const fn of this.subscribers.get(c.id) ?? [])
      fn(`id: ${full.id}\ndata: ${JSON.stringify(full)}\n\n`);
    return full;
  }
  private setState(c: Conversation, status: Conversation['status'], responder = c.responder) {
    if (c.status === status && c.responder === responder) return;
    c.status = status;
    c.responder = responder;
    this.push(c, { type: 'state', status, responder });
  }
  private delta(c: Conversation, messageId: string, text: string) {
    for (const fn of this.subscribers.get(c.id) ?? []) {
      fn(`event: text-delta\ndata: ${JSON.stringify({ message_id: messageId, text })}\n\n`);
    }
  }

  /** The fake Company Agent. */
  private respond(c: Conversation, t: Principal, msg: Record<string, unknown>) {
    this.setState(c, 'working');
    setTimeout(() => {
      if (c.status === 'closed') return;
      const text = String(msg.text ?? '');
      const reply = (replyText: string, data?: Record<string, unknown>) => {
        const mid = id('msg_');
        const half = Math.ceil(replyText.length / 2);
        this.delta(c, mid, replyText.slice(0, half));
        this.delta(c, mid, replyText.slice(half));
        this.push(c, {
          type: 'message',
          message: {
            id: mid,
            role: 'company',
            author: { type: c.responder },
            text: replyText,
            ...(data ? { data } : {}),
          },
        });
      };
      if (/order/i.test(text)) {
        if (!t.signedIn || !t.scope.split(' ').includes('orders:read')) {
          this.push(c, {
            type: 'authorization',
            error: 'insufficient_scope',
            scope: 'orders:read',
          });
          reply('Please sign in so I can look up your orders.');
        } else {
          c.owner = 'acct_1';
          c.account = c.owner;
          reply('Here are your orders.', { orders: [{ id: 'ord_1042', item: 'jacket' }] });
        }
      } else if (/specialist|talk to the user/i.test(text)) {
        this.push(c, {
          type: 'user_requested',
          reason: 'A specialist needs to confirm with the customer.',
        });
        reply('I need to talk with the user directly.');
      } else if (msg.text !== undefined || msg.data !== undefined) {
        reply(`You said: ${text}${msg.data ? ` + data ${JSON.stringify(msg.data)}` : ''}`);
      }
      this.setState(c, 'idle');
    }, 20);
  }

  private owns(c: Conversation, t: Principal) {
    if (c.clientId !== t.clientId || c.userId !== t.userId) return false;
    if (c.account && !t.signedIn) return 'account_required';
    return true;
  }

  private async conversationsRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const parts = url.pathname.split('/').filter(Boolean); // poppy, conversations, {id}, {action}
    const convId = parts[2];
    const action = parts[3];
    if (!convId && req.method === 'POST') {
      const body = JSON.parse(await this.body(req));
      const m = body.message;
      this.checkOutgoing(m);
      const prior = [...this.conversations.values()].find(
        (c) => c.userId === t.userId && c.messageIds.has(m.id),
      );
      if (prior) {
        if (prior.messageIds.get(m.id) !== JSON.stringify(m))
          return this.send(res, 409, { error: 'message_id_conflict' });
        return this.send(res, 201, {
          conversation_id: prior.id,
          status: prior.status,
          responder: prior.responder,
        });
      }
      let parent: Conversation | undefined;
      if (body.parent_conversation_id) {
        parent = this.conversations.get(body.parent_conversation_id);
        if (!parent || parent.userId !== t.userId || parent.parent)
          return this.send(res, 404, { error: 'conversation_not_found' });
        if (parent.status === 'closed')
          return this.send(res, 409, { error: 'conversation_closed' });
        if (parent.openDirect)
          return this.send(res, 409, {
            error: 'direct_conversation_open',
            conversation_id: parent.openDirect,
          });
      }
      const c: Conversation = {
        id: id('cnv_'),
        clientId: t.clientId,
        userId: t.userId,
        owner: t.userId,
        events: [],
        status: 'idle',
        responder: 'agent',
        parent: parent?.id,
        messageIds: new Map([[m.id, JSON.stringify(m)]]),
      };
      this.conversations.set(c.id, c);
      if (parent) {
        parent.openDirect = c.id;
        this.push(parent, { type: 'direct_opened', conversation_id: c.id });
      }
      this.push(c, { type: 'message', message: { ...m, role: 'user' } });
      this.respond(c, t, m);
      return this.send(res, 201, {
        conversation_id: c.id,
        status: c.status,
        responder: c.responder,
      });
    }
    const c = this.conversations.get(convId ?? '');
    const owns = c ? this.owns(c, t) : false;
    if (!c || owns === false) return this.send(res, 404, { error: 'conversation_not_found' });
    if (owns === 'account_required')
      return this.send(res, 403, undefined, {
        'www-authenticate': 'Bearer scope="orders:read"',
      });

    if (action === 'messages' && req.method === 'POST') {
      const m = JSON.parse(await this.body(req)).message;
      this.checkOutgoing(m);
      const seen = [...this.conversations.values()].find(
        (x) => x.userId === t.userId && x.messageIds.has(m.id),
      );
      if (seen) {
        if (seen.messageIds.get(m.id) !== JSON.stringify(m))
          return this.send(res, 409, { error: 'message_id_conflict' });
        return this.send(res, 202, { status: c.status, responder: c.responder });
      }
      if (c.status === 'closed') return this.send(res, 409, { error: 'conversation_closed' });
      if (c.openDirect)
        return this.send(res, 409, {
          error: 'direct_conversation_open',
          conversation_id: c.openDirect,
        });
      c.messageIds.set(m.id, JSON.stringify(m));
      this.push(c, { type: 'message', message: { ...m, role: 'user' } });
      this.respond(c, t, m);
      return this.send(res, 202, { status: c.status, responder: c.responder });
    }
    if (action === 'handoff' && req.method === 'POST') {
      if (c.status === 'closed') return this.send(res, 409, { error: 'conversation_closed' });
      this.setState(c, 'queued', 'agent');
      setTimeout(() => this.setState(c, 'idle', 'human'), 20);
      return this.send(res, 202, { status: c.status, responder: c.responder });
    }
    if (action === 'close' && req.method === 'POST') {
      this.setState(c, 'closed');
      if (c.parent) {
        const parent = this.conversations.get(c.parent);
        if (parent) {
          parent.openDirect = undefined;
          this.push(parent, { type: 'direct_closed', conversation_id: c.id });
        }
      }
      return this.send(res, 200, { status: c.status, responder: c.responder });
    }
    if (action === 'events' && req.method === 'GET') return this.events(req, res, url, c);
    this.send(res, 404, { error: 'not_found' });
  }

  private checkOutgoing(m: Record<string, unknown>) {
    if (typeof m?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(m.id))
      this.violation('bad message id');
    const authorType = (m?.author as { type?: string } | undefined)?.type;
    if (authorType !== 'agent' && authorType !== 'human') this.violation('bad author');
    if (m?.text === undefined && m?.data === undefined && m?.context === undefined)
      this.violation('empty message');
  }

  private after(c: Conversation, cursor: string | undefined) {
    if (!cursor) return c.events;
    const i = c.events.findIndex((e) => e.id === cursor);
    return i === -1 ? undefined : c.events.slice(i + 1);
  }

  private async events(req: IncomingMessage, res: ServerResponse, url: URL, c: Conversation) {
    if (req.headers.accept?.includes('text/event-stream')) {
      const lastId = req.headers['last-event-id'];
      if (typeof lastId === 'string') this.lastEventIdHeaders.push(lastId);
      if (url.searchParams.get('cursor')) this.violation('SSE reconnect should use Last-Event-ID');
      const backlog = this.after(c, typeof lastId === 'string' ? lastId : undefined);
      if (!backlog) return this.send(res, 400, { error: 'invalid_cursor' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': hello\n\n');
      let sentMessage = false;
      // Declared before `write`: the backlog below can already hold the first company message
      // (the stream connected after the reply), and dropping the stream then needs it.
      let unsubscribe = () => {};
      const write = (chunk: string) => {
        if (res.writableEnded) return; // dropped mid-backlog: the rest comes on the reconnect
        res.write(chunk);
        if (
          this.opts.dropStreamAfterFirstMessage &&
          !sentMessage &&
          chunk.includes('"type":"message"') &&
          chunk.includes('"role":"company"')
        ) {
          sentMessage = true;
          this.opts.dropStreamAfterFirstMessage = false;
          unsubscribe();
          res.end();
        }
      };
      for (const ev of backlog) write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (res.writableEnded) return;
      const set = this.subscribers.get(c.id) ?? new Set();
      this.subscribers.set(c.id, set);
      set.add(write);
      unsubscribe = () => set.delete(write);
      req.on('close', unsubscribe);
      return;
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 5);
    let events = this.after(c, cursor);
    if (!events) return this.send(res, 400, { error: 'invalid_cursor' });
    const deadline = Date.now() + wait * 1000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      events = this.after(c, cursor) ?? [];
    }
    const page = events.slice(0, 50);
    this.send(res, 200, {
      conversation_id: c.id,
      events: page,
      cursor: page.length ? page[page.length - 1]?.id : cursor,
      has_more: events.length > page.length,
      status: c.status,
      responder: c.responder,
    });
  }
}
