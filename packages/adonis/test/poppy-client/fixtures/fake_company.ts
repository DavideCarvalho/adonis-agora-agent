/**
 * An in-process FAKE Poppy Company, written strictly from the spec (1.0). It doubles as a
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
import { tarGz, zip } from './archives.js';

const MEDIATED_GRANT = 'https://personalagentprotocol.org/grant/mediated-sign-in';
const id = (p: string) => p + randomBytes(9).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const sha256 = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** An independent RFC 9651 reader for the fake: Strings, Integers, Tokens, Booleans, parameters. */
function sfMembers(
  input: string,
): { key: string; value: unknown; params: Record<string, unknown> }[] {
  const out: { key: string; value: unknown; params: Record<string, unknown> }[] = [];
  const s = input.trim();
  let i = 0;
  const value = (): unknown => {
    if (s[i] === '"') {
      let v = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++;
        v += s[i++];
      }
      if (s[i] !== '"') throw new Error('unterminated string');
      i++;
      return v;
    }
    if (s[i] === '?') {
      i += 2;
      return s[i - 1] === '1';
    }
    const m =
      /^-?\d+/.exec(s.slice(i)) ?? /^[A-Za-z*][A-Za-z0-9:/!#$%&'*+.^_`|~-]*/.exec(s.slice(i));
    if (!m) throw new Error(`bad item at ${i}`);
    i += m[0].length;
    return /^-?\d+$/.test(m[0]) ? Number(m[0]) : { token: m[0] };
  };
  const params = () => {
    const p: Record<string, unknown> = {};
    while (s[i] === ';') {
      i++;
      const k = /^[a-z*][a-z0-9_.*-]*/.exec(s.slice(i))?.[0];
      if (!k) throw new Error('bad param');
      i += k.length;
      if (s[i] === '=') {
        i++;
        p[k] = value();
      } else p[k] = true;
    }
    return p;
  };
  while (i < s.length) {
    let key = '';
    if (s[i] === '"') {
      // A List member: a String item.
      const v = value();
      out.push({ key: '', value: v, params: params() });
    } else {
      key = /^[a-z*][a-z0-9_.*-]*/.exec(s.slice(i))?.[0] ?? '';
      if (!key) throw new Error('bad key');
      i += key.length;
      let v: unknown = true;
      if (s[i] === '=') {
        i++;
        v = value();
      }
      out.push({ key, value: v, params: params() });
    }
    while (s[i] === ' ') i++;
    if (i < s.length) {
      if (s[i] !== ',') throw new Error('expected comma');
      i++;
      while (s[i] === ' ') i++;
    }
  }
  return out;
}

/** One operation the fake Company returned (Operations extension v3). */
interface FakeOperation {
  id: string;
  via: 'api' | 'mcp' | 'conversation' | 'website';
  /** Who can approve it: `{client}|{user}` signed out, `{client}|acct:{account}` signed in. */
  owner: string;
  /** What the request asks, canonical. */
  key: string;
  revisions: Map<string, { terms: Record<string, unknown>; expiresAt: number }>;
  current: string;
  status: 'open' | 'performing' | 'performed';
  response?: { status: number; body: unknown } | undefined;
  conversationId?: string | undefined;
  /** Website: references, and an approval recorded at the endpoint, waiting for the browser. */
  refs: Set<string>;
  recorded?: { revision: string } | undefined;
}

interface Session {
  key: string;
  id: string;
  clientId: string;
  userId: string;
  account?: string | undefined;
  ended?: boolean | undefined;
  /** The first request's `Poppy-Extensions` and `agent_id`: the same on every request (3.4, 5.2). */
  extensions?: string | undefined;
  agentId?: string | undefined;
}
/** What a verified request is: the shape the Company's handlers use. */
interface Principal {
  sessionId: string;
  clientId: string;
  userId: string;
  scope: string;
  signedIn: boolean;
  /** `Poppy-Extensions`: name → version (3.4). */
  extensions: Map<string, string>;
  account?: string | undefined;
  agentId?: string | undefined;
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
  /** The DPoP key the sign-in proved: every refresh must prove it too (4.4). */
  jkt?: string | undefined;
}
interface Conversation {
  id: string;
  clientId: string;
  owner: string; // userId, or account once used
  userId: string;
  account?: string | undefined;
  events: Record<string, unknown>[];
  /** Requests accepted but not acted on, plus replies being written (8.7). */
  pending: number;
  handoff: 'none' | 'pending';
  responder: 'agent' | 'human';
  closed: boolean;
  parent?: string | undefined;
  openDirect?: string | undefined;
  /** Direct Conversations started by accepting a user_requested event: `{parent}|{event}` → id. */
  accepted?: Map<string, string> | undefined;
  /** Handoff requests the Company hasn't acted on; a cancel withdraws them. */
  handoffTimer?: ReturnType<typeof setTimeout> | undefined;
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
  /** Offer PAR (RFC 9126); `required` sets `require_pushed_authorization_requests`. */
  par?: 'offered' | 'required' | undefined;
  /** Serve only this protocol version at its endpoints (others get version_unsupported). */
  servedVersion?: string | undefined;
  /** `poppy.json` is a later minor version, linking a 1.0 document in `supported_versions`. */
  versions?: 'later-minor' | 'link-only' | undefined;
  /** `auth.disabled`: no sign-in for Personal Agents. */
  authDisabled?: boolean | undefined;
  /** The `/api` service isn't offered to Personal Agents: its resource gets invalid_target. */
  rejectApiResource?: boolean | undefined;
  /** Operations: decline every agent approval (Operations section 6). */
  declineAgentApprovals?: boolean | undefined;
  /**
   * Operations: every request without an approval gets a NEW operation (the Company decides which
   * requests are for the same action, section 3), so a client must send the approval with the
   * repeated request instead of repeating it bare first.
   */
  newOperationPerRequest?: boolean | undefined;
  /** Operations: the first approved API request answers 503 + Retry-After while it performs. */
  performing503Once?: boolean | undefined;
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
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      scope: string;
      used?: boolean;
      jkt?: string | undefined;
    }
  >();
  /** Pushed authorization requests (RFC 9126): request_uri → parameters. */
  readonly pushed = new Map<string, { params: URLSearchParams; jkt?: string | undefined }>();
  /** Every authorization request's parameters, as the browser brought them. */
  readonly authorizeRequests: URLSearchParams[] = [];
  /** `Poppy-Version` / `Poppy-Extensions` of every request with the Session header. */
  readonly versionHeaders: { version?: string | undefined; extensions?: string | undefined }[] = [];
  /** Request bodies of conversation POSTs, by request id: the first one wins (8.3). */
  readonly requestIds = new Map<
    string,
    { userId: string; path: string; body: string; response: unknown; status: number }
  >();
  /** End the next Session the Company sees (session_ended once). */
  endNextSession = false;
  /** Answer the tasks endpoint per Session (private), counting fetches. */
  tasksFetches: { sid: string; token: boolean }[] = [];
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
    {
      cookie: string;
      sessionId?: string;
      account?: string | undefined;
      used?: boolean;
      owner?: string;
      extensions?: Map<string, string>;
    }
  >();
  readonly feedback: unknown[] = [];
  /** Answer feedback with this alternative (HTTP 200) instead of 202. */
  feedbackAlternative: unknown;
  /** Operations (v3): by id, and the website references that name them. */
  readonly operations = new Map<string, FakeOperation>();
  readonly operationRefs = new Map<string, string>();
  /** Every exchange actually performed: an operation's id, once (Operations section 7). */
  readonly exchanges: string[] = [];
  /** The price difference the terms carry now: change it to change the terms. */
  price = 70;
  /** Change `price` once the first approval of an API request arrives, after failing it with 503. */
  failFirstApprovalThenReprice = false;
  /** Approval references seen: reference → `{operation_id} {revision}`. */
  private readonly approvalReferences = new Map<string, string>();
  private readonly declinedReferences = new Set<string>();
  /** Joined browsers by their cookie: the Session, account and extensions of the join (6). */
  private readonly browserCookies = new Map<
    string,
    { sessionId: string; owner: string; extensions: Map<string, string> }
  >();
  /** Skill artifacts served under /poppy/skills, by path. */
  readonly skillFiles = new Map<string, { body: Buffer; type: string }>();
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
  get version() {
    return this.opts.servedVersion ?? '1.0';
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
    const md = (body: string) => ({ body: Buffer.from(body), type: 'text/markdown' });
    this.skillFiles.set('manage-orders/SKILL.md', md('---\nname: manage-orders\n---\n# Orders'));
    this.skillFiles.set('tampered/SKILL.md', md('# Changed after the index was written'));
    this.skillFiles.set('bundle.tar.gz', {
      body: tarGz([
        { path: 'SKILL.md', data: '# Bundle' },
        { path: 'scripts/', type: '5' },
        { path: 'scripts/run.sh', data: 'echo never run' },
        { path: 'scripts/latest', type: '2', link: 'run.sh' },
      ]),
      type: 'application/gzip',
    });
    this.skillFiles.set('bundle.zip', {
      body: zip(
        [
          { path: 'SKILL.md', data: '# Zipped' },
          { path: 'references/GUIDE.md', data: 'guide' },
        ],
        true,
      ),
      type: 'application/zip',
    });
    this.skillFiles.set('evil.tar.gz', {
      body: tarGz([
        { path: 'SKILL.md', data: '# Evil' },
        { path: '../escape.md', data: 'outside' },
      ]),
      type: 'application/gzip',
    });
    this.skillFiles.set('escaping-link.zip', {
      body: zip([
        { path: 'SKILL.md', data: '# Link' },
        { path: 'secrets', type: '2', data: '../../etc/passwd' },
      ]),
      type: 'application/octet-stream',
    });
    return this;
  }

  async stop() {
    for (const set of this.subscribers.values()) set.clear();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  poppyJson(version = '1.0') {
    return {
      protocol_version: version,
      organization: { name: 'Fake Co', domain: this.domain },
      auth: {
        ...(this.opts.authDisabled ? { disabled: true } : {}),
        scopes: {
          'orders:read': 'See your orders',
          'orders:write': 'Change your orders',
          addresses: 'Manage saved shipping addresses',
          'poppy:browser-sign-in': 'Use the website signed in, with the other access you approve',
        },
        scope_hints: {
          'orders:read': { changes: 'none', personal_data: true },
          'orders:write': { changes: 'irreversible', personal_data: true },
        },
        future_field: 'ignored',
      },
      agent: {
        protocols: [
          {
            type: 'something-else',
            endpoint: 'https://ignored.example/x',
            description: 'Something else',
          },
          {
            type: 'poppy',
            endpoint: `${this.origin}/poppy/conversations`,
            description: 'Anything about your orders',
          },
        ],
      },
      web: { browser_session_endpoint: `${this.origin}/poppy/browser-session` },
      tasks: { endpoint: `${this.origin}/poppy/tasks` },
      apis: [
        { type: 'graphql', url: 'https://ignored.example/graphql', description: 'unknown type' },
        { type: 'openapi', url: `${this.origin}/openapi.json`, description: 'Orders' },
        { type: 'mcp', url: this.mcpUrl, description: 'Tools' },
      ],
      extensions: {
        operations: [{ version: '3', endpoint: `${this.origin}/poppy/operations` }],
        links: [{ version: '1' }],
        disclosures: [{ version: '1' }],
        'browser-control': [{ version: '1' }],
        'example.com/unknown': [{ version: '9' }],
        'example.com/gift-wrap': [{ version: '2' }, { version: '1' }],
        'mediated-sign-in': [
          {
            version: '1',
            fields: [
              { name: 'email', label: 'Email', secret: false },
              { name: 'password', label: 'Password', secret: true },
            ],
            scopes: ['orders:read'],
          },
          { version: '7', fields: 'from the future' },
        ],
      },
    };
  }

  /** `/.well-known/poppy.json`, with `supported_versions` per `opts.versions` (3.4). */
  private rootDocument() {
    if (this.opts.versions === 'later-minor') {
      return {
        ...this.poppyJson('1.3'),
        supported_versions: { '1.0': `${this.origin}/poppy/1.0.json` },
      };
    }
    if (this.opts.versions === 'link-only') {
      return {
        ...this.poppyJson('2.0'),
        supported_versions: {
          '1.0': `${this.origin}/poppy/1.0.json`,
          '0.3': `${this.origin}/poppy/0.3.json`,
        },
      };
    }
    return this.poppyJson();
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
          // 4.1: Companies MUST accept ES256 and PS384 (blind signing).
          algorithms: ['ES256', 'PS384'],
        },
      );
      if (typeof payload.aud !== 'string')
        this.violation('client assertion aud should be a single string');
      if (
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        payload.exp - payload.iat > 300
      )
        this.violation('client assertion exp must be at most 5 minutes after iat');
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
  private signIn(clientId: string, scope: string, via: string, jkt?: string | undefined) {
    const account = 'acct_1';
    const rt = id('pat_');
    // Bound to the DPoP key of the request that issued it (4.4, MAY).
    this.accountTokens.set(rt, { clientId, account, scope, via, jkt });
    return { rt, grant: { clientId, account, viaToken: rt } };
  }
  /* ------------------------------------------------------------------ router */

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.origin);
    const p = url.pathname;
    this.log.push(`${req.method} ${p}`);
    if (p === '/.well-known/poppy.json')
      return this.send(res, 200, this.rootDocument(), { 'cache-control': 'max-age=60' });
    if (p === '/poppy/1.0.json') return this.send(res, 200, this.poppyJson('1.0'));
    if (p === '/poppy/0.3.json') return this.send(res, 200, this.poppyJson('0.3'));
    if (p === '/.well-known/oauth-protected-resource') {
      return this.send(res, 200, {
        resource: this.origin,
        ...(this.opts.noIssuer ? {} : { authorization_servers: [this.origin] }),
        scopes_supported: ['poppy:browser-sign-in'],
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
        ...(this.opts.par
          ? { pushed_authorization_request_endpoint: `${this.origin}/oauth/par` }
          : {}),
        ...(this.opts.par === 'required' ? { require_pushed_authorization_requests: true } : {}),
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
    if (p === '/oauth/par' && req.method === 'POST') return this.par(req, res);
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
    if (p === '/poppy/tasks' && req.method === 'GET') {
      const t = await this.resourceAuth(req, res, url);
      if (!t) return;
      if (req.headers.authorization) this.violation('access token sent to tasks.endpoint');
      this.tasksFetches.push({ sid: t.sessionId, token: req.headers.authorization !== undefined });
      return this.send(
        res,
        200,
        {
          skill_index: {
            $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
            skills: [
              {
                name: 'manage-orders',
                description: 'Manage orders',
                type: 'skill-md',
                url: 'skills/manage-orders/SKILL.md',
                digest: sha256(this.skillFiles.get('manage-orders/SKILL.md')!.body),
              },
              {
                name: 'tampered',
                description: 'Changed after indexing',
                type: 'skill-md',
                url: 'skills/tampered/SKILL.md',
                digest: sha256('# The original'),
              },
              {
                name: 'bundle',
                description: 'An archive',
                type: 'archive',
                url: `${this.origin}/poppy/skills/bundle.tar.gz`,
                digest: sha256(this.skillFiles.get('bundle.tar.gz')!.body),
              },
              {
                name: 'bundle-zip',
                description: 'A zip archive',
                type: 'archive',
                url: '/poppy/skills/bundle.zip',
                digest: sha256(this.skillFiles.get('bundle.zip')!.body),
              },
              {
                name: 'evil',
                description: 'Path traversal',
                type: 'archive',
                url: 'skills/evil.tar.gz',
                digest: sha256(this.skillFiles.get('evil.tar.gz')!.body),
              },
              {
                name: 'escaping-link',
                description: 'A link outside the skill',
                type: 'archive',
                url: 'skills/escaping-link.zip',
                digest: sha256(this.skillFiles.get('escaping-link.zip')!.body),
              },
              {
                name: 'moved',
                description: 'Redirected',
                type: 'skill-md',
                url: 'skills/moved',
                digest: sha256(this.skillFiles.get('manage-orders/SKILL.md')!.body),
              },
              { name: 'future', description: 'x', type: 'future', url: '/x', digest: 'sha256:00' },
            ],
          },
          feedback: { endpoint: `${this.origin}/poppy/feedback` },
          excluded_tasks: [
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
        },
        { 'cache-control': 'private, max-age=600' },
      );
    }
    if (p.startsWith('/poppy/skills/')) {
      if (req.headers['poppy-session'] || req.headers.authorization)
        this.violation('credentials or Session header sent for a skill artifact');
      const rest = p.slice('/poppy/skills/'.length);
      if (rest === 'moved') {
        res.writeHead(302, { location: '/poppy/skills/manage-orders/SKILL.md' });
        return res.end();
      }
      const file = this.skillFiles.get(rest);
      if (!file) return this.send(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'content-type': file.type, 'content-length': String(file.body.length) });
      return res.end(file.body);
    }
    if (p === '/poppy/operations' && req.method === 'POST')
      return this.operationsEndpoint(req, res, url);
    if (p === '/shop/exchange' && req.method === 'POST') return this.shopExchange(req, res);
    if (p === '/check-in' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(CHECK_IN_PAGE);
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
    if (p === '/help' || p === '/moved') return this.page(req, res, url);
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
    if (
      (resource && resource !== this.mcpUrl && resource !== `${this.origin}/api`) ||
      (resource === `${this.origin}/api` && this.opts.rejectApiResource)
    ) {
      return this.oauthError(res, 400, 'invalid_target');
    }
    // The MCP server doesn't take DPoP: its tokens are Bearer (4.5, 7).
    const issueJkt = resource === this.mcpUrl ? undefined : jkt;
    const grant = form.get('grant_type');
    const scopeReq = form.get('scope');
    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      const at = this.accountTokens.get(rt);
      if (!at || at.revoked || at.clientId !== clientId)
        return this.oauthError(res, 400, 'invalid_grant');
      if (at.jkt && jkt !== at.jkt) {
        this.violation('refresh without a proof from the key the refresh token was issued with');
        return this.oauthError(res, 400, 'invalid_grant');
      }
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
        { jkt: issueJkt, scope, resource, refreshToken: rotated },
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
      // A code pushed with a DPoP proof is bound to its key (RFC 9449 section 10.1).
      if (c.jkt && c.jkt !== jkt) {
        this.violation('code exchanged with another DPoP key than the pushed request');
        return this.oauthError(res, 400, 'invalid_grant');
      }
      const { rt, grant: g } = this.signIn(clientId, c.scope, 'direct', jkt);
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
      const { rt, grant: g } = this.signIn(clientId, d.scope, 'device', jkt);
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
      const { rt, grant } = this.signIn(clientId, pending.scope, 'mediated', jkt);
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
  /** RFC 9126: the authorization request's parameters, with the client assertion. */
  private async par(req: IncomingMessage, res: ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const clientId = await this.clientAuth(form);
    if (!clientId) return this.oauthError(res, 401, 'invalid_client');
    let jkt: string | undefined;
    if (req.headers.dpop) {
      const d = await this.dpop(req, `${this.origin}/oauth/par`);
      if (d.error === 'use_dpop_nonce')
        return this.oauthError(res, 400, 'use_dpop_nonce', { 'dpop-nonce': this.nonce });
      if (d.error) return this.oauthError(res, 400, d.error);
      jkt = d.jkt;
    } else if (!this.opts.noDpop) {
      this.violation('PAR without a DPoP proof');
    }
    const params = new URLSearchParams(form);
    for (const k of ['client_assertion', 'client_assertion_type']) params.delete(k);
    const requestUri = `urn:ietf:params:oauth:request_uri:${id('')}`;
    this.pushed.set(requestUri, { params, jkt });
    this.send(res, 201, { request_uri: requestUri, expires_in: 60 });
  }

  private async authorize(url: URL, res: ServerResponse) {
    let q = url.searchParams;
    this.authorizeRequests.push(new URLSearchParams(q));
    let jkt: string | undefined;
    const requestUri = q.get('request_uri');
    if (requestUri) {
      const pushed = this.pushed.get(requestUri);
      this.pushed.delete(requestUri);
      if (!pushed || pushed.params.get('client_id') !== q.get('client_id')) {
        return this.send(res, 400, { error: 'invalid_request_uri' });
      }
      if ([...q.keys()].some((k) => k !== 'client_id' && k !== 'request_uri'))
        this.violation('PAR authorization URL carries more than client_id and request_uri');
      q = pushed.params;
      jkt = pushed.jkt;
    } else if (this.opts.par === 'required') {
      return this.send(res, 400, { error: 'invalid_request' });
    }
    if (q.get('prompt') !== 'consent') this.violation('Direct Sign-In without prompt=consent');
    if (q.has('resource')) this.violation('sign-in names a resource');
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
        jkt,
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
    if (form.has('resource')) this.violation('sign-in names a resource');
    const scope = form.get('scope') ?? '';
    const known = ['orders:read', 'orders:write', 'addresses', 'poppy:browser-sign-in'];
    if (!scope.split(' ').every((s) => known.includes(s)))
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
  ): Promise<
    | {
        clientId: string;
        sid: string;
        sub: string;
        agentId?: string | undefined;
        extensions: string;
      }
    | string
  > {
    const jwt = req.headers['poppy-session'];
    if (typeof jwt !== 'string') {
      this.violation(`no Session header on ${req.method} ${url.pathname}`);
      return 'no Session header';
    }
    const version = req.headers['poppy-version'];
    const extensions = req.headers['poppy-extensions'];
    this.versionHeaders.push({
      version: typeof version === 'string' ? version : undefined,
      extensions: typeof extensions === 'string' ? extensions : undefined,
    });
    // 3.4: without Poppy-Version, or with one this Company doesn't serve.
    if (typeof version !== 'string') {
      this.violation(`no Poppy-Version on ${req.method} ${url.pathname}`);
      return 'version_unsupported';
    }
    if (version.split('.')[0] !== this.version.split('.')[0]) return 'version_unsupported';
    const fail = (why: string) => {
      this.violation(`Session JWT: ${why}`);
      return why;
    };
    try {
      const h = decodeProtectedHeader(jwt);
      if (h.typ !== 'poppy-session+jwt') return fail('typ');
      if (h.alg !== 'ES256') return fail('alg');
      if (typeof h.poppy_dlg !== 'string') return fail('no poppy_dlg');
      const claims = decodeJwt(jwt);
      const clientId = String(claims.iss);
      const { jwks } = await this.client(clientId);
      const { payload: dlg, protectedHeader: dh } = await jwtVerify(
        h.poppy_dlg,
        createLocalJWKSet(jwks),
        { typ: 'poppy-delegation+jwt', issuer: clientId, algorithms: ['ES256', 'PS384'] },
      );
      if (dh.typ !== 'poppy-delegation+jwt') return fail('delegation typ');
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
      let agentId: string | undefined;
      if (payload.agent_id !== undefined) {
        agentId = String(payload.agent_id);
        // 5.1: opaque, like a User ID.
        if (!/^[A-Za-z0-9_-]{16,}$/.test(agentId) || agentId === sub)
          return fail(`Agent ID looks non-opaque: ${agentId}`);
      }
      return {
        clientId,
        sid: payload.sid,
        sub,
        agentId,
        extensions: typeof extensions === 'string' ? extensions : '',
      };
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
    if (v === 'version_unsupported') {
      this.send(res, 400, { error: 'version_unsupported' });
      return undefined;
    }
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
    // 5.3: Sessions are found by client_id, sid and User ID.
    const key = `${v.clientId}|${v.sid}|${v.sub}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key,
        id: v.sid,
        clientId: v.clientId,
        userId: v.sub,
        extensions: v.extensions,
        agentId: v.agentId,
      };
      this.sessions.set(key, s);
      if (this.endNextSession) {
        this.endNextSession = false;
        s.ended = true;
      }
    }
    if (s.ended) {
      this.send(res, 400, { error: 'session_ended' });
      return undefined;
    }
    if (s.extensions !== v.extensions) this.violation('Poppy-Extensions changed within a Session');
    if (s.agentId !== v.agentId) this.violation('agent_id changed within a Session');
    if (signedIn) {
      // 5.4: another account in the same Session.
      if (s.account && s.account !== signedIn.account) {
        this.send(res, 400, { error: 'session_ended' });
        return undefined;
      }
      s.account = signedIn.account;
    }
    const extensions = new Map<string, string>();
    try {
      for (const m of v.extensions ? sfMembers(v.extensions) : []) {
        if (typeof m.value === 'string' && typeof m.params.v === 'string')
          extensions.set(m.value, m.params.v);
      }
    } catch {
      // 3.4: a header that fails to parse declares no extensions.
    }
    return {
      sessionId: s.id,
      clientId: s.clientId,
      userId: s.userId,
      scope: signedIn?.scope ?? '',
      signedIn: signedIn !== undefined,
      extensions,
      account: signedIn?.account,
      agentId: v.agentId,
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
    if (url.pathname === '/api/exchanges' && req.method === 'POST') {
      const body = JSON.parse((await this.body(req)) || '{}');
      const header = req.headers['poppy-approval'];
      if (t.extensions.get('operations') !== '3') {
        if (header) this.violation('Poppy-Approval without declaring operations');
        return this.send(res, 403, { error: 'extension_required', extension: 'operations' });
      }
      const key = JSON.stringify({ item_id: body.item_id, replacement_sku: body.replacement_sku });
      const approval = typeof header === 'string' ? this.headerApproval(header) : undefined;
      const verdict = this.judge(t, 'api', key, approval, {}, true);
      return this.answer(res, verdict);
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

  /** Website pages fetched without a browser (5.2): the Session header, never a token. */
  readonly pages: { path: string; session: boolean; token: boolean }[] = [];
  /** Where `/moved` redirects. */
  movedTo = '/help';
  private async page(req: IncomingMessage, res: ServerResponse, url: URL) {
    this.pages.push({
      path: url.pathname,
      session: typeof req.headers['poppy-session'] === 'string',
      token: req.headers.authorization !== undefined,
    });
    if (req.headers.authorization) this.violation('access token sent with a website page');
    if (url.pathname === '/moved') {
      res.writeHead(302, { location: this.movedTo });
      return res.end();
    }
    if (req.headers['poppy-session']) {
      const v = await this.verifySession(req, url, undefined);
      if (typeof v === 'string') return this.send(res, 400, { error: 'invalid_session' });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Help</h1>');
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
    // A signed-in join needs poppy:browser-sign-in (section 6).
    if (t.signedIn && !t.scope.split(' ').includes('poppy:browser-sign-in')) {
      return this.send(res, 403, undefined, {
        'www-authenticate': 'Bearer error="insufficient_scope", scope="poppy:browser-sign-in"',
      });
    }
    const body = JSON.parse((await this.body(req)) || '{}');
    const entry = this.browserCodes.get(String(body.code));
    if (!entry || entry.sessionId) return this.send(res, 400, { error: 'invalid_request' });
    entry.sessionId = t.sessionId;
    entry.account = t.signedIn ? 'acct_1' : undefined;
    entry.owner = this.ownerOf(t);
    entry.extensions = t.extensions;
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
    this.browserCookies.set(entry.sessionId, {
      sessionId: entry.sessionId,
      owner: entry.owner ?? '',
      extensions: entry.extensions ?? new Map(),
    });
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
    if ('kind' in body) this.violation('feedback has no kind');
    if (String(body.task).length > 200 || String(body.description).length > 2000)
      return this.send(res, 400, { error: 'invalid_request' });
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
    // Operations (v3): approval in `_meta` under personalagentprotocol.org/approval.
    server.registerTool(
      'exchange_item',
      {
        description: 'Exchange an item (needs approval)',
        inputSchema: { item_id: z.string(), replacement_sku: z.string() },
      },
      async ({ item_id, replacement_sku }, extra) => {
        const raw = (extra._meta as Record<string, unknown> | undefined)?.[
          'personalagentprotocol.org/approval'
        ];
        if (t.extensions.get('operations') !== '3') {
          if (raw !== undefined) this.violation('MCP approval without declaring operations');
          // 2: a tool that needs the extension returns an ordinary tool error.
          return { isError: true, content: [{ type: 'text', text: 'This needs approval.' }] };
        }
        const key = JSON.stringify({ item_id, replacement_sku });
        const verdict = this.judge(
          t,
          'mcp',
          key,
          raw === undefined ? undefined : this.checkApproval(raw),
          {},
        );
        if (verdict.kind === 'required') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Not done yet. This needs approval: ${verdict.operation.summary}`,
              },
            ],
            structuredContent: { operation: verdict.operation },
          };
        }
        if (verdict.kind === 'declined') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Not done: the approval was declined.' }],
            structuredContent: verdict.body,
          };
        }
        if (verdict.kind === 'performed') {
          return { content: [{ type: 'text', text: JSON.stringify(verdict.body) }] };
        }
        return { isError: true, content: [{ type: 'text', text: 'Still being performed.' }] };
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

  /* ------------------------------------------------------------------ operations (v3) */

  /** Who can approve an operation: the account when signed in, else the User ID (Operations 3). */
  private ownerOf(t: Principal) {
    return t.signedIn ? `${t.clientId}|acct:${t.account}` : `${t.clientId}|${t.userId}`;
  }

  private operationJson(op: FakeOperation) {
    const r = op.revisions.get(op.current)!;
    const price = (r.terms.price_difference as { amount: string }).amount;
    return {
      operation_id: op.id,
      revision: op.current,
      // Basic Markdown is allowed; links, images and HTML must be shown as text.
      summary: `Exchange item ${String(r.terms.item_id)} for **${String(r.terms.replacement_sku)}**, for $${price} more. [Details](https://evil.example/x) <img src=x>`,
      terms: r.terms,
      expires_at: new Date(r.expiresAt).toISOString(),
    };
  }

  private termsFor(key: string) {
    return {
      ...(JSON.parse(key) as Record<string, unknown>),
      price_difference: { amount: this.price.toFixed(2), currency: 'USD' },
    };
  }

  /** A new revision whenever the terms change; never the same revision for other terms. */
  private revise(op: FakeOperation) {
    const terms = this.termsFor(op.key);
    const cur = op.revisions.get(op.current);
    if (cur && JSON.stringify(cur.terms) === JSON.stringify(terms) && cur.expiresAt > Date.now())
      return;
    const rev = `${now()}-${id('')}`;
    op.revisions.set(rev, { terms, expiresAt: Date.now() + 600_000 });
    op.current = rev;
  }

  /** The open operation for this action, or a new one: a performed one is never reused. */
  private operationFor(
    via: FakeOperation['via'],
    owner: string,
    key: string,
    extra: { conversationId?: string | undefined },
  ): FakeOperation {
    let op = this.opts.newOperationPerRequest
      ? undefined
      : [...this.operations.values()].find(
          (o) =>
            o.via === via &&
            o.owner === owner &&
            o.key === key &&
            o.status !== 'performed' &&
            o.conversationId === extra.conversationId,
        );
    if (!op) {
      op = {
        id: id('exc_'),
        via,
        owner,
        key,
        revisions: new Map(),
        current: '',
        status: 'open',
        refs: new Set(),
        conversationId: extra.conversationId,
      };
      this.operations.set(op.id, op);
    }
    this.revise(op);
    return op;
  }

  private headerApproval(header: string): Record<string, unknown> | undefined {
    let members: ReturnType<typeof sfMembers>;
    try {
      members = sfMembers(header);
    } catch (e) {
      this.violation(`Poppy-Approval is not a valid Dictionary: ${(e as Error).message}`);
      return undefined;
    }
    const raw: Record<string, unknown> = {};
    for (const m of members) {
      if (typeof m.value === 'object') this.violation(`Poppy-Approval ${m.key} is not a String`);
      raw[m.key] = m.value;
    }
    if (raw.approved_at !== undefined && !Number.isInteger(raw.approved_at))
      this.violation('Poppy-Approval approved_at is not an Integer');
    return this.checkApproval(raw);
  }

  /** What every approval must be (Operations section 6). */
  private checkApproval(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'object' || raw === null) {
      this.violation('approval is not an object');
      return undefined;
    }
    const a = raw as Record<string, unknown>;
    if (typeof a.operation_id !== 'string' || typeof a.revision !== 'string')
      this.violation('approval without operation_id or revision');
    if (a.approver !== 'user' && a.approver !== 'agent')
      this.violation(`approval without a valid approver: ${String(a.approver)}`);
    if (a.approver === 'agent' && a.input_type !== undefined)
      this.violation('input_type sent with an agent approval');
    if (a.approved_at !== undefined && !Number.isInteger(a.approved_at))
      this.violation('approved_at is not Unix seconds');
    if (typeof a.reference === 'string') {
      const what = `${String(a.operation_id)} ${String(a.revision)}`;
      const seen = this.approvalReferences.get(a.reference);
      if (seen && seen !== what) this.violation('the same approval reference for another approval');
      this.approvalReferences.set(a.reference, what);
      if (this.declinedReferences.has(a.reference))
        this.violation('an approval sent again after approval_declined');
    }
    return a;
  }

  /**
   * Checks an approval as Operations section 6 says (Session can approve, not performed already,
   * the revision describes exactly this request), then declines or performs it, at most once.
   */
  private judge(
    t: Principal,
    via: FakeOperation['via'],
    key: string,
    approval: Record<string, unknown> | undefined,
    extra: { conversationId?: string | undefined },
    canBePerforming = false,
  ):
    | { kind: 'required'; operation: ReturnType<FakeCompany['operationJson']> }
    | { kind: 'declined'; body: Record<string, unknown> }
    | { kind: 'performed'; status: number; body: unknown }
    | { kind: 'performing' } {
    const owner = this.ownerOf(t);
    const op = approval ? this.operations.get(String(approval.operation_id)) : undefined;
    // 1: a Session that can't approve it is handled as a request without an approval.
    if (!op || !approval || op.owner !== owner || op.via !== via) {
      return {
        kind: 'required',
        operation: this.operationJson(this.operationFor(via, owner, key, extra)),
      };
    }
    // 2: performed already, or being performed.
    if (op.status === 'performed' && op.response)
      return { kind: 'performed', status: op.response.status, body: op.response.body };
    if (op.status === 'performing') return { kind: 'performing' };
    // 3: a revision returned for it, not expired, describing exactly this request.
    const rev = op.revisions.get(String(approval.revision));
    const fresh =
      rev !== undefined &&
      rev.expiresAt > Date.now() &&
      op.key === key &&
      JSON.stringify(rev.terms) === JSON.stringify(this.termsFor(key));
    if (!fresh) {
      const target = op.key === key ? op : this.operationFor(via, owner, key, extra);
      this.revise(target);
      if (target.current === approval.revision)
        this.violation('fake: answered with the same revision');
      return { kind: 'required', operation: this.operationJson(target) };
    }
    if (this.opts.declineAgentApprovals && approval.approver === 'agent') {
      if (typeof approval.reference === 'string') this.declinedReferences.add(approval.reference);
      return {
        kind: 'declined',
        body: {
          error: 'approval_declined',
          operation_id: op.id,
          revision: String(approval.revision),
          reason: 'Only the account holder can approve exchanges.',
          alternative: {
            instructions: 'Exchange it on our website.',
            references: [
              { type: 'web', url: 'https://example.com/exchanges' },
              { type: 'openapi', url: 'https://evil.example/openapi.json', operation_id: 'x' },
            ],
          },
        },
      };
    }
    const perform = () => {
      this.exchanges.push(op.id);
      op.status = 'performed';
      op.response = { status: 201, body: { exchange_id: id('xch_'), status: 'exchanged' } };
    };
    if (canBePerforming && this.failFirstApprovalThenReprice) {
      this.failFirstApprovalThenReprice = false;
      this.price += 5;
      return { kind: 'performing' };
    }
    if (canBePerforming && this.opts.performing503Once) {
      this.opts.performing503Once = false;
      op.status = 'performing';
      setTimeout(perform, 20);
      return { kind: 'performing' };
    }
    perform();
    return { kind: 'performed', status: op.response!.status, body: op.response!.body };
  }

  /** An API's answer to a verdict (Operations sections 4, 6, 7). */
  private answer(res: ServerResponse, verdict: ReturnType<FakeCompany['judge']>) {
    if (verdict.kind === 'required')
      return this.send(res, 403, { error: 'approval_required', operation: verdict.operation });
    if (verdict.kind === 'declined') return this.send(res, 403, verdict.body);
    if (verdict.kind === 'performing')
      return this.send(res, 503, undefined, { 'retry-after': '0' });
    return this.send(res, verdict.status, verdict.body);
  }

  /** The website's operations endpoint (Operations sections 4 and 6). */
  private async operationsEndpoint(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    if (t.extensions.get('operations') !== '3')
      return this.send(res, 403, { error: 'extension_required', extension: 'operations' });
    const body = JSON.parse((await this.body(req)) || '{}');
    const op = this.operations.get(this.operationRefs.get(String(body.ref)) ?? '');
    const owner = this.ownerOf(t);
    if (op?.owner.includes('|acct:') && !t.signedIn) {
      return this.send(res, 401, undefined, { 'www-authenticate': 'Bearer scope="orders:write"' });
    }
    if (!op || op.owner !== owner || op.via !== 'website')
      return this.send(res, 400, { error: 'invalid_request' });
    const header = req.headers['poppy-approval'];
    if (typeof header !== 'string') {
      if (op.recorded || op.status !== 'open') {
        const status = op.status === 'open' ? 'approved' : op.status;
        return this.send(res, 200, { operation_id: op.id, status });
      }
      if ((op.revisions.get(op.current)?.expiresAt ?? 0) <= Date.now())
        return this.send(res, 400, { error: 'invalid_request' });
      return this.send(res, 403, { error: 'approval_required', operation: this.operationJson(op) });
    }
    const approval = this.headerApproval(header);
    if (!approval || approval.operation_id !== op.id) {
      return this.send(res, 403, { error: 'approval_required', operation: this.operationJson(op) });
    }
    const rev = op.revisions.get(String(approval.revision));
    if (
      !rev ||
      rev.expiresAt <= Date.now() ||
      JSON.stringify(rev.terms) !== JSON.stringify(this.termsFor(op.key))
    ) {
      this.revise(op);
      return this.send(res, 403, { error: 'approval_required', operation: this.operationJson(op) });
    }
    if (this.opts.declineAgentApprovals && approval.approver === 'agent') {
      if (typeof approval.reference === 'string') this.declinedReferences.add(approval.reference);
      return this.send(res, 403, {
        error: 'approval_declined',
        operation_id: op.id,
        revision: approval.revision,
        reason: 'Only the account holder can approve exchanges.',
      });
    }
    op.recorded = { revision: String(approval.revision) };
    res.writeHead(204);
    res.end();
  }

  /** The website's exchange form, posted by the agent's joined browser (Operations section 4). */
  private async shopExchange(req: IncomingMessage, res: ServerResponse) {
    const cookie = /__Host-fake_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const join = cookie ? this.browserCookies.get(cookie) : undefined;
    if (!join) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<p>Sign in first.</p>');
    }
    if (join.extensions.get('operations') !== '3') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<p>Confirm the exchange on this page.</p>');
    }
    const form = new URLSearchParams(await this.body(req));
    const key = JSON.stringify({
      item_id: form.get('item_id'),
      replacement_sku: form.get('replacement_sku'),
    });
    const ready = [...this.operations.values()].find(
      (o) =>
        o.via === 'website' &&
        o.owner === join.owner &&
        o.key === key &&
        o.status === 'open' &&
        o.recorded !== undefined &&
        o.recorded.revision === o.current,
    );
    if (
      ready &&
      JSON.stringify(ready.revisions.get(ready.current)?.terms) ===
        JSON.stringify(this.termsFor(key))
    ) {
      ready.recorded = undefined; // used up
      this.exchanges.push(ready.id);
      ready.status = 'performed';
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<p>Exchanged.</p>');
    }
    const op = this.operationFor('website', join.owner, key, {});
    const ref = `${op.id}.${op.current}`;
    op.refs.add(ref);
    this.operationRefs.set(ref, op.id);
    const json = (req.headers.accept ?? '').includes('application/json');
    res.writeHead(403, {
      'content-type': json ? 'application/json' : 'text/html',
      'cache-control': 'no-store',
      'poppy-operation': `sid="${join.sessionId}", ref="${ref}"`,
    });
    res.end(
      json
        ? JSON.stringify({ error: 'approval_required' })
        : '<p>This exchange is waiting for your approval in your personal agent.</p><button>Continue</button>',
    );
  }

  /* ------------------------------------------------------------------ conversations */

  private push(c: Conversation, ev: Record<string, unknown>) {
    const full = { id: id('evt_'), created_at: new Date().toISOString(), ...ev };
    c.events.push(full);
    for (const fn of this.subscribers.get(c.id) ?? [])
      fn(`id: ${full.id}\ndata: ${JSON.stringify(full)}\n\n`);
    return full;
  }
  /** `working` isn't an event: a stream gets it as a `working` SSE event with no id (8.6). */
  private setWorking(c: Conversation, delta: number) {
    const before = c.pending > 0;
    c.pending += delta;
    const after = c.pending > 0;
    if (before === after) return;
    for (const fn of this.subscribers.get(c.id) ?? [])
      fn(`event: working\ndata: ${JSON.stringify({ working: after })}\n\n`);
  }
  /** Every change to handoff, responder or closed adds a state event with all three (8.7). */
  private setState(
    c: Conversation,
    patch: Partial<Pick<Conversation, 'handoff' | 'responder' | 'closed'>>,
  ) {
    const next = { handoff: c.handoff, responder: c.responder, closed: c.closed, ...patch };
    if (next.handoff === c.handoff && next.responder === c.responder && next.closed === c.closed)
      return;
    Object.assign(c, next);
    this.push(c, { type: 'state', ...next });
  }
  private state(c: Conversation) {
    return { working: c.pending > 0, handoff: c.handoff, responder: c.responder, closed: c.closed };
  }
  private delta(c: Conversation, messageId: string, text: string) {
    for (const fn of this.subscribers.get(c.id) ?? []) {
      fn(`event: text-delta\ndata: ${JSON.stringify({ message_id: messageId, text })}\n\n`);
      fn(`event: future-event\ndata: {"ignored":true}\n\n`);
    }
  }

  /** The fake Company Agent: acts on an accepted message later (8.3). */
  private respond(c: Conversation, t: Principal, msg: Record<string, unknown>, requestId: string) {
    this.setWorking(c, +1);
    setTimeout(() => {
      try {
        if (c.closed) return;
        const text = String(msg.text ?? '');
        const reply = (
          replyText: string,
          data?: Record<string, unknown>,
          extensions?: Record<string, unknown>,
        ) => {
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
              ...(c.responder === 'agent' ? { as_of_request: requestId } : {}),
              text: replyText,
              ...(data ? { data } : {}),
              ...(extensions ? { extensions } : {}),
            },
          });
        };
        const operations = t.extensions.get('operations') === '3';
        const approvalRaw = (msg.extensions as { operations?: { approval?: unknown } } | undefined)
          ?.operations?.approval;
        if (approvalRaw !== undefined) {
          const approval = this.checkApproval(approvalRaw);
          const op = approval ? this.operations.get(String(approval.operation_id)) : undefined;
          if (!op || op.conversationId !== c.id) {
            reply('That approval is not for anything in this conversation.');
            return;
          }
          const verdict = this.judge(t, 'conversation', op.key, approval, { conversationId: c.id });
          if (verdict.kind === 'performed') reply('Done: the exchange went through.');
          else if (verdict.kind === 'declined') {
            const { error: _e, ...declined } = verdict.body as Record<string, unknown>;
            reply('I could not do the exchange.', undefined, { operations: { declined } });
          } else if (verdict.kind === 'required') {
            reply('The terms changed; please approve these.', undefined, {
              operations: { operation: verdict.operation },
            });
          }
          return;
        }
        if (/exchange/i.test(text)) {
          if (!operations) {
            reply('Exchanges need your approval on our website.');
            return;
          }
          const key = JSON.stringify({
            item_id: 'itm_4Qa',
            replacement_sku: 'stormline-insulated-m',
          });
          const verdict = this.judge(t, 'conversation', key, undefined, { conversationId: c.id });
          if (verdict.kind === 'required') {
            reply(
              `I can exchange it for $${this.price} more. I will once you approve.`,
              undefined,
              {
                operations: { operation: verdict.operation },
              },
            );
          }
          return;
        }
        if (/ship|track/i.test(text)) {
          const links = t.extensions.get('links') === '1';
          const disclosures = t.extensions.get('disclosures') === '1';
          const notice = 'Lithium batteries ship by ground only.';
          const ext: Record<string, unknown> = {};
          if (links) {
            ext.links = {
              items: [
                {
                  url: `https://${this.domain.split(':')[0]}.example/orders/ord_1/tracking`,
                  title: 'Tracking',
                },
                { url: 'javascript:alert(1)', title: 'Not HTTPS' },
                { url: 'https://example.com/help/returns' },
              ],
            };
          }
          if (disclosures) ext.disclosures = { items: [{ text: notice }] };
          // 8.4: content only for a declared extension; otherwise the notice goes in text.
          reply(
            `Your jacket shipped this morning.${disclosures ? '' : ` ${notice}`}`,
            undefined,
            Object.keys(ext).length > 0 ? ext : undefined,
          );
          return;
        }
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
        } else if (/stronger/i.test(text)) {
          this.push(c, { type: 'authorization', error: 'step_up_required', scope: 'orders:read' });
          reply('I need a stronger sign-in.');
        } else if (/specialist|talk to the user/i.test(text)) {
          this.push(c, {
            type: 'user_requested',
            reason: 'A specialist needs to confirm with the customer.',
          });
          reply('I need to talk with the user directly.');
        } else if (/future/i.test(text)) {
          this.push(c, { type: 'future_event_type', anything: 1 });
          this.push(c, {
            type: 'message',
            message: {
              id: id('msg_'),
              role: 'system',
              author: { type: 'bot' },
              text: 'From the future',
            },
          });
        } else if (msg.text !== undefined || msg.data !== undefined) {
          reply(`You said: ${text}${msg.data ? ` + data ${JSON.stringify(msg.data)}` : ''}`);
        }
      } finally {
        this.setWorking(c, -1);
      }
    }, 20);
  }

  private owns(c: Conversation, t: Principal) {
    if (c.clientId !== t.clientId || c.userId !== t.userId) return false;
    if (c.account && !t.signedIn) return 'account_required';
    return true;
  }

  /**
   * Request IDs (8.3): the same ID, path and body returns the original response; another path or
   * body is request_id_conflict. Unique for the User across all its requests.
   */
  private replay(
    res: ServerResponse,
    t: Principal,
    path: string,
    body: Record<string, unknown>,
  ): boolean {
    const rid = body.id;
    if (typeof rid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(rid)) {
      this.violation(`conversation POST without a valid request id on ${path}`);
      this.send(res, 400, { error: 'invalid_request' });
      return true;
    }
    const prior = this.requestIds.get(`${t.userId}|${rid}`);
    if (!prior) return false;
    if (prior.path !== path || prior.body !== JSON.stringify(body)) {
      this.send(res, 409, { error: 'request_id_conflict' });
    } else {
      this.send(res, prior.status, prior.response);
    }
    return true;
  }
  private accept(
    res: ServerResponse,
    t: Principal,
    path: string,
    body: Record<string, unknown>,
    status: number,
    response: unknown,
  ) {
    this.requestIds.set(`${t.userId}|${String(body.id)}`, {
      userId: t.userId,
      path,
      body: JSON.stringify(body),
      response,
      status,
    });
    this.send(res, status, response);
  }

  private async conversationsRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const t = await this.resourceAuth(req, res, url);
    if (!t) return;
    const parts = url.pathname.split('/').filter(Boolean); // poppy, conversations, {id}, {action}, {sub}
    const convId = parts[2];
    const action = parts.slice(3).join('/');
    if (!convId && req.method === 'POST') {
      const body = JSON.parse(await this.body(req));
      if (this.replay(res, t, url.pathname, body)) return;
      const m = body.message;
      if (m !== undefined) this.checkOutgoing(m, t);
      let parent: Conversation | undefined;
      if (body.parent_conversation_id) {
        parent = this.conversations.get(body.parent_conversation_id);
        if (!parent || parent.userId !== t.userId)
          return this.send(res, 404, { error: 'conversation_not_found' });
        if (parent.parent) return this.send(res, 400, { error: 'invalid_request' });
        if (parent.closed) return this.send(res, 409, { error: 'conversation_closed' });
        if (parent.openDirect)
          return this.send(res, 409, {
            error: 'direct_conversation_open',
            conversation_id: parent.openDirect,
          });
      }
      if (body.user_requested_event_id !== undefined) {
        const ev = parent?.events.find((e) => e.id === body.user_requested_event_id);
        if (ev?.type !== 'user_requested') return this.send(res, 400, { error: 'invalid_request' });
      } else if (m === undefined) {
        this.violation('a conversation start without a message');
        return this.send(res, 400, { error: 'invalid_request' });
      }
      const c: Conversation = {
        id: id('cnv_'),
        clientId: t.clientId,
        userId: t.userId,
        owner: t.userId,
        events: [],
        pending: 0,
        handoff: 'none',
        responder: 'agent',
        closed: false,
        parent: parent?.id,
      };
      this.conversations.set(c.id, c);
      if (parent) {
        parent.openDirect = c.id;
        this.push(parent, { type: 'direct_opened', conversation_id: c.id });
      }
      if (m !== undefined) {
        this.push(c, { type: 'message', message: { ...m, id: body.id, role: 'user' } });
        this.respond(c, t, m, body.id);
      } else {
        this.respond(c, t, { text: 'Hello, how can I help?' }, body.id);
      }
      return this.accept(res, t, url.pathname, body, 201, { conversation_id: c.id });
    }
    const c = this.conversations.get(convId ?? '');
    const owns = c ? this.owns(c, t) : false;
    if (!c || owns === false) return this.send(res, 404, { error: 'conversation_not_found' });
    if (owns === 'account_required')
      return this.send(res, 401, undefined, {
        'www-authenticate': 'Bearer scope="orders:read"',
      });

    if (req.method === 'POST') {
      const body = JSON.parse((await this.body(req)) || '{}');
      if (this.replay(res, t, url.pathname, body)) return;
      const accepted = () =>
        this.accept(res, t, url.pathname, body, 202, { conversation_id: c.id });
      if (action === 'close') {
        // 8.12: doesn't wait its turn; a closed one returns 202 and changes nothing.
        if (c.handoffTimer) clearTimeout(c.handoffTimer);
        this.setState(c, { closed: true, handoff: 'none' });
        c.pending = 0;
        if (c.parent) {
          const parent = this.conversations.get(c.parent);
          if (parent && parent.openDirect === c.id) {
            parent.openDirect = undefined;
            this.push(parent, { type: 'direct_closed', conversation_id: c.id });
          }
        }
        return accepted();
      }
      if (!['messages', 'handoff', 'handoff/cancel'].includes(action))
        return this.send(res, 404, { error: 'not_found' });
      if (c.closed) return this.send(res, 409, { error: 'conversation_closed' });
      if (c.openDirect)
        return this.send(res, 409, {
          error: 'direct_conversation_open',
          conversation_id: c.openDirect,
        });
      if (action === 'messages') {
        const m = body.message;
        this.checkOutgoing(m, t);
        this.push(c, { type: 'message', message: { ...m, id: body.id, role: 'user' } });
        this.respond(c, t, m, body.id);
        return accepted();
      }
      if (action === 'handoff') {
        if (c.handoff === 'none' && c.responder === 'agent') {
          this.setState(c, { handoff: 'pending' });
          c.handoffTimer = setTimeout(
            () => this.setState(c, { handoff: 'none', responder: 'human' }),
            40,
          );
        }
        return accepted();
      }
      // handoff/cancel: the Company MAY stop looking (8.9).
      if (c.handoff === 'pending') {
        if (c.handoffTimer) clearTimeout(c.handoffTimer);
        this.setState(c, { handoff: 'none' });
      }
      return accepted();
    }
    if (action === 'events' && req.method === 'GET') return this.events(req, res, url, c);
    this.send(res, 404, { error: 'not_found' });
  }

  private checkOutgoing(m: Record<string, unknown>, t: Principal) {
    for (const name of Object.keys((m?.extensions as Record<string, unknown> | undefined) ?? {})) {
      if (name === 'links' || name === 'disclosures')
        this.violation(`the Personal Agent sent ${name} content: only Company messages carry it`);
      else if (!t.extensions.has(name))
        this.violation(`extension content for ${name}, which the request doesn't declare (8.4)`);
    }
    if (m && 'id' in m) this.violation('a message the Personal Agent sends has no id (8.3)');
    if (m && 'role' in m) this.violation('a message the Personal Agent sends has no role');
    const authorType = (m?.author as { type?: string } | undefined)?.type;
    if (authorType !== 'agent' && authorType !== 'human') this.violation('bad author');
    if (authorType === 'human' && m && 'as_of_cursor' in m)
      this.violation("as_of_cursor on the User's own words");
    if (
      m?.text === undefined &&
      m?.data === undefined &&
      m?.context === undefined &&
      m?.extensions === undefined
    )
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
      // `working` when the stream opens (8.6), before the backlog.
      res.write(`event: working\ndata: ${JSON.stringify({ working: c.pending > 0 })}\n\n`);
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
    const wasWorking = c.pending > 0;
    // Held until there is an event, or until working changes from true to false (8.5).
    while (events.length === 0 && Date.now() < deadline && !(wasWorking && c.pending === 0)) {
      await new Promise((r) => setTimeout(r, 25));
      events = this.after(c, cursor) ?? [];
    }
    const page = events.slice(0, 50);
    this.send(res, 200, {
      conversation_id: c.id,
      events: page,
      cursor: page.length ? page[page.length - 1]?.id : cursor,
      has_more: events.length > page.length,
      ...this.state(c),
    });
  }
}

/** A check-in page with marked steps (Browser Control extension, section 4). */
export const CHECK_IN_PAGE = `<!doctype html>
<form id="check-in" action="/check-in" method="post" data-poppy-user-step="submission">
  <label>Seat <select id="seat" name="seat"><option>12C</option><option>14D</option></select></label>
  <label>Passport <input id="passport" name="passport" data-poppy-user-step="interaction"></label>
  <input id="meal" name="meal">
  <button id="more" type="button">More seats</button>
  <button id="submit" type="submit"><span id="label">Check in</span></button>
</form>
<input id="outside" name="bags" form="check-in">
<form id="newsletter" data-poppy-user-step="interaction"><input id="email" name="email"><button id="join">Join</button></form>
<form id="search" data-poppy-user-step="something-new"><input id="q" name="q"></form>
<div data-poppy-user-step="submission"><button id="div-marked" type="button">Odd</button></div>
<form id="plain"><input id="free" name="free"><button id="go">Go</button></form>`;
