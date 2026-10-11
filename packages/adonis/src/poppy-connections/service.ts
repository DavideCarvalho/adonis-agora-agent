import { createHmac, randomBytes } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';
import type {
  CompanyClient,
  McpConnection,
  PendingDirectSignIn,
  StoredKey,
} from '../poppy-client/index.js';
import {
  AgentIdentity,
  ConversationClient,
  ConversationError,
  completeDirectSignIn,
  connectMcp,
  mediatedSignIn,
  newMessageId,
  OAuthError,
  PoppyAgent,
  PoppyError,
  pollDeviceSignInOnce,
  ResourceAuthError,
  StateStore,
  startDirectSignIn,
  submitMediatedCode,
} from '../poppy-client/index.js';
import type { CompanyState, StateFile } from '../poppy-client/store.js';
import type { ConversationEvent } from '../poppy-client/types.js';
import type { Actor } from '../types.js';
import {
  DEFAULT_POPPY_CONNECTIONS_TEXTS,
  normalizeDomain,
  type PoppyCompanyPolicy,
  type PoppyConnectionsConfig,
  type PoppyConnectionsTexts,
} from './config.js';
import { Sealer } from './crypto.js';
import type { PoppyConnectionRecord, PoppyConnectionStore, PoppyPendingConnect } from './store.js';

/** A Company outside the allow-list. The model is told plainly, and nothing is fetched. */
export class PoppyCompanyNotAllowedError extends Error {
  constructor(readonly domain: string) {
    super(`${domain} is not a company this assistant may connect to`);
    this.name = 'PoppyCompanyNotAllowedError';
  }
}

/** One connection as the app and the model see it — never a token. */
export interface PoppyConnectionView {
  domain: string;
  organization: string;
  status: PoppyConnectionRecord['status'];
  scope: string;
  connectedSince: number | null;
}

/** What a connect page shows. */
export type PoppyConnectPageData =
  | { kind: 'expired' }
  | { kind: 'connected'; organization: string }
  | {
      kind: 'open';
      id: string;
      organization: string;
      direct: boolean;
      device: boolean;
      mediated: { name: string; label: string; secret: boolean }[] | null;
    };

type Flow =
  | { kind: 'direct'; signIn: PendingDirectSignIn }
  | { kind: 'mediated'; signInId: string; sentTo: string; scope: string }
  | {
      kind: 'device';
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      scope: string;
    };

/** What `ask`/`request` bring back from the Company's agent. */
export interface PoppyCompanyReply {
  conversationId: string;
  replies: { text: string; data?: Record<string, unknown> }[];
  /** The Company said the token lacks something (§7.11). */
  authorization?: { error: string; scope?: string };
  status: string;
}

export interface PoppyConnectionsOptions {
  config: PoppyConnectionsConfig;
  store: PoppyConnectionStore;
  secret: string;
  production: boolean;
  /** Called once a connect completes — the provider decides the parked `connect` call. */
  onConnected?: (pending: PoppyPendingConnect) => Promise<void>;
  log?: (line: string) => void;
}

const DEFAULT_READ_SCOPES = ['poppy:read'];

/**
 * This app's agent acting on other Poppy Companies for its users: the agent identity, the
 * connections (sealed at rest), the connect flows and the calls the tools make.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 — will change as the spec evolves.
 */
export class PoppyConnections {
  readonly texts: PoppyConnectionsTexts;
  readonly path: string;
  readonly baseUrl: string;
  readonly insecureDev: boolean;
  readonly #config: PoppyConnectionsConfig;
  readonly #store: PoppyConnectionStore;
  readonly #sealer: Sealer;
  readonly #secret: string;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #onConnected: PoppyConnectionsOptions['onConnected'];
  readonly #log: (line: string) => void;
  #identity: AgentIdentity | null = null;

  constructor(options: PoppyConnectionsOptions) {
    const { config } = options;
    if (config.insecureDev === true && options.production) {
      throw new Error(
        '[@adonis-agora/agent] poppy-connections: `insecureDev` is for development only and cannot be on in production.',
      );
    }
    this.#config = config;
    this.#store = options.store;
    this.#sealer = new Sealer(options.secret);
    this.#secret = options.secret;
    this.#onConnected = options.onConnected;
    this.#log = options.log ?? (() => {});
    this.insecureDev = config.insecureDev === true;
    this.texts = { ...DEFAULT_POPPY_CONNECTIONS_TEXTS, ...config.texts };
    this.path = (config.path ?? 'poppy-agent').replace(/^\/+|\/+$/g, '');
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  /** The app's agent identity (`client_id` = `{baseUrl}/{path}/agent.json`). */
  async identity(): Promise<AgentIdentity> {
    if (this.#identity === null) {
      this.#identity = new AgentIdentity(
        {
          baseUrl: `${this.baseUrl}/${this.path}`,
          clientName: this.#config.identity.name,
          ...(this.#config.identity.logoUri !== undefined
            ? { logoUri: this.#config.identity.logoUri }
            : {}),
          keys: await normalizeKeys(this.#config.identity.keys),
        },
        { insecureDev: this.insecureDev },
      );
    }
    return this.#identity;
  }

  ownerOf(actor: Actor): string {
    return this.#config.owner?.(actor) ?? actor.tenantRef ?? actor.id;
  }

  /** The policy for `domain`, or `null` when it is not allow-listed (default: nothing is). */
  policy(domain: string): PoppyCompanyPolicy | null {
    const d = normalizeDomain(domain);
    const companies = this.#config.companies;
    if (companies === undefined) return null;
    if (typeof companies === 'function') return companies(d) ? {} : null;
    if (Array.isArray(companies)) {
      return companies.map(normalizeDomain).includes(d) ? {} : null;
    }
    for (const [key, policy] of Object.entries(companies)) {
      if (normalizeDomain(key) === d) return policy;
    }
    return null;
  }

  /** The allow-listed Companies (when the allow-list is a list or a map). */
  allowedCompanies(): { domain: string; label?: string }[] {
    const companies = this.#config.companies;
    if (companies === undefined || typeof companies === 'function') return [];
    if (Array.isArray(companies)) return companies.map((d) => ({ domain: normalizeDomain(d) }));
    return Object.entries(companies).map(([d, p]) => ({
      domain: normalizeDomain(d),
      ...(p.label !== undefined ? { label: p.label } : {}),
    }));
  }

  // ── state ──────────────────────────────────────────────────────────────────

  /** Serialize everything one owner does: Account Tokens rotate, and a lost rotation is a lost login. */
  async #exclusive<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(owner) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.#locks.set(owner, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(owner) === tail) this.#locks.delete(owner);
    }
  }

  /** A `PoppyAgent` over this owner's connections; every save seals them back to the store. */
  async #agent(owner: string): Promise<{ agent: PoppyAgent; domains: Map<string, string> }> {
    const rows = await this.#store.listConnections(owner);
    const byIssuer = new Map(rows.map((row) => [row.issuer, row]));
    const domains = new Map(rows.map((row) => [row.issuer, row.domain]));
    const companies: Record<string, CompanyState> = {};
    for (const row of rows) companies[row.issuer] = this.#sealer.open<CompanyState>(row.state);
    const data: StateFile = { version: 1, profiles: { [owner]: { companies } } };
    const store = StateStore.memory(data, async (current) => {
      const now = Date.now();
      for (const [issuer, state] of Object.entries(current.profiles[owner]?.companies ?? {})) {
        const existing = byIssuer.get(issuer);
        const domain = domains.get(issuer) ?? existing?.domain ?? state.domains[0] ?? issuer;
        const status: PoppyConnectionRecord['status'] = state.accountToken
          ? 'active'
          : existing?.status === 'active' || existing?.status === 'revoked'
            ? 'revoked'
            : 'pending';
        const record: PoppyConnectionRecord = {
          owner,
          issuer,
          domain,
          organization: existing?.organization ?? domain,
          scope: state.accountToken?.scope ?? '',
          status,
          state: this.#sealer.seal(state),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await this.#store.saveConnection(record);
        byIssuer.set(issuer, record);
      }
    });
    const identity = await this.identity();
    const agent = new PoppyAgent({
      store,
      identity,
      profile: owner,
      insecureDev: this.insecureDev,
      ...(this.#config.fetch !== undefined ? { fetch: this.#config.fetch } : {}),
      log: (line) => this.#log(`poppy-connections: ${line}`),
    });
    return { agent, domains };
  }

  /** Discover `domain` (allow-listed) and load this owner's state there. */
  async #company(
    owner: string,
    domain: string,
  ): Promise<{ client: CompanyClient; policy: PoppyCompanyPolicy }> {
    const d = normalizeDomain(domain);
    const policy = this.policy(d);
    if (policy === null) throw new PoppyCompanyNotAllowedError(d);
    const { agent, domains } = await this.#agent(owner);
    // The requested domain (with its port) is what rediscovers the Company later.
    const discovered = await agent.company(d);
    domains.set(discovered.issuer, d);
    const row = await this.#store.getConnection(owner, discovered.issuer);
    const organization = discovered.document.organization.name;
    if (row !== null && (row.domain !== d || row.organization !== organization)) {
      await this.#store.saveConnection({ ...row, domain: d, organization });
    }
    return { client: discovered, policy };
  }

  /** Run `fn` with this owner's client at `domain`, serialized per owner. */
  withCompany<T>(
    owner: string,
    domain: string,
    fn: (client: CompanyClient, policy: PoppyCompanyPolicy) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(owner, async () => {
      const { client, policy } = await this.#company(owner, domain);
      return fn(client, policy);
    });
  }

  // ── connections ────────────────────────────────────────────────────────────

  async list(owner: string): Promise<PoppyConnectionView[]> {
    const rows = await this.#store.listConnections(owner);
    return rows.map((row) => ({
      domain: row.domain,
      organization: row.organization,
      status: row.status,
      scope: row.scope,
      connectedSince: row.status === 'active' ? row.updatedAt : null,
    }));
  }

  /** The connection at `domain`, without contacting it. */
  async connection(owner: string, domain: string): Promise<PoppyConnectionView | null> {
    const d = normalizeDomain(domain);
    return (await this.list(owner)).find((c) => c.domain === d) ?? null;
  }

  /** Sign out at the Company (revokes the Account Token, §4.9) and mark the connection revoked. */
  async disconnect(owner: string, domain: string): Promise<boolean> {
    return this.withCompany(owner, domain, async (client) => {
      let revoked = false;
      try {
        revoked = await client.signOut();
      } catch (error) {
        this.#log(
          `poppy-connections: revocation at ${client.issuer} failed: ${(error as Error).message}`,
        );
        client.state.accountToken = undefined;
        client.state.tokens = {};
        await client.save();
      }
      const row = await this.#store.getConnection(owner, client.issuer);
      if (row !== null) await this.#store.saveConnection({ ...row, status: 'revoked', scope: '' });
      return revoked || row !== null;
    });
  }

  // ── connect flows ──────────────────────────────────────────────────────────

  /**
   * Start a connect: the link the person opens (web or WhatsApp — it is a URL), bound to the parked
   * `connect` call so completing it resumes the conversation. `id` makes a replayed call land on the
   * same link.
   */
  async startConnect(input: {
    actor: Actor;
    domain: string;
    scope?: string;
    threadId?: string;
    runId?: string;
    toolCallId?: string;
    id?: string;
  }): Promise<{ id: string; url: string; organization: string; scope: string }> {
    const owner = this.ownerOf(input.actor);
    const id = input.id ?? randomBytes(16).toString('base64url');
    const existing = await this.#store.getPending(id);
    if (existing !== null) {
      return {
        id,
        url: this.connectUrl(id),
        organization: existing.organization,
        scope: existing.scope,
      };
    }
    return this.withCompany(owner, input.domain, async (client, policy) => {
      const scope = input.scope ?? policy.scopes?.join(' ') ?? offeredScopes(client).join(' ');
      const now = Date.now();
      await this.#store.createPending({
        id,
        owner,
        domain: normalizeDomain(input.domain),
        issuer: client.issuer,
        organization: client.document.organization.name,
        scope,
        actor: {
          id: input.actor.id,
          ...(input.actor.roles !== undefined ? { roles: input.actor.roles } : {}),
          ...(input.actor.tenantRef !== undefined ? { tenantRef: input.actor.tenantRef } : {}),
        },
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        toolCallId: input.toolCallId ?? null,
        flow: null,
        status: 'open',
        expiresAt: now + (this.#config.connectTtlSeconds ?? 900) * 1000,
        createdAt: now,
      });
      return {
        id,
        url: this.connectUrl(id),
        organization: client.document.organization.name,
        scope,
      };
    });
  }

  /**
   * The connect id of one tool call (`runId:toolCallId`): a replayed call reaches the same link.
   * Keyed with the app secret — the link is a bearer capability, so it must not be derivable.
   */
  connectIdFor(key: string): string {
    return createHmac('sha256', this.#secret)
      .update(`poppy-connect:${key}`)
      .digest('base64url')
      .slice(0, 32);
  }

  connectUrl(id: string): string {
    return `${this.baseUrl}/${this.path}/connect/${id}`;
  }

  async #openPending(id: string): Promise<PoppyPendingConnect | null> {
    const pending = await this.#store.getPending(id);
    if (pending === null || pending.expiresAt <= Date.now()) return null;
    return pending;
  }

  async page(id: string): Promise<PoppyConnectPageData> {
    const pending = await this.#openPending(id);
    if (pending === null) return { kind: 'expired' };
    if (pending.status === 'connected')
      return { kind: 'connected', organization: pending.organization };
    return this.withCompany(pending.owner, pending.domain, async (client) => {
      const auth = client.document.auth;
      return {
        kind: 'open',
        id,
        organization: pending.organization,
        direct: Boolean(auth?.direct && client.metadata.authorization_endpoint),
        device: Boolean(auth?.device && client.metadata.device_authorization_endpoint),
        mediated:
          auth?.mediated?.fields?.map((f) => ({
            name: f.name,
            label: f.label,
            secret: f.secret,
          })) ?? null,
      };
    });
  }

  /** Direct Sign-In (§4.5): the authorization URL to send the browser to. */
  async directUrl(id: string): Promise<string | null> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.status !== 'open') return null;
    return this.withCompany(pending.owner, pending.domain, async (client) => {
      const scope = withinType(client, 'direct', pending.scope);
      const signIn = await startDirectSignIn(client, scope);
      // `state` carries the connect id: the callback finds its sign-in without a session.
      const state = `${id}.${signIn.state}`;
      const url = new URL(signIn.url);
      url.searchParams.set('state', state);
      await this.#store.updatePending(id, {
        flow: this.#sealer.seal({
          kind: 'direct',
          signIn: { ...signIn, state, url: url.toString() },
        } satisfies Flow),
      });
      return url.toString();
    });
  }

  /** The Direct Sign-In redirect back to `redirect_uri`. */
  async directCallback(
    params: URLSearchParams,
  ): Promise<{ ok: boolean; organization: string | null }> {
    const id = (params.get('state') ?? '').split('.')[0] ?? '';
    const pending = await this.#openPending(id);
    if (pending === null || pending.flow === null) return { ok: false, organization: null };
    const flow = this.#sealer.open<Flow>(pending.flow);
    if (flow.kind !== 'direct') return { ok: false, organization: pending.organization };
    try {
      await this.withCompany(pending.owner, pending.domain, (client) =>
        completeDirectSignIn(client, flow.signIn, params),
      );
    } catch (error) {
      this.#log(`poppy-connections: Direct Sign-In failed: ${(error as Error).message}`);
      return { ok: false, organization: pending.organization };
    }
    await this.#connected(pending);
    return { ok: true, organization: pending.organization };
  }

  /**
   * Mediated Sign-In (§4.7) from this app's own page: the credentials go from the person's browser
   * to this server and straight to the Company — never stored, logged, or shown to the model.
   */
  async mediated(
    id: string,
    credentials: Record<string, string>,
  ): Promise<{ status: 'connected' | 'code_required' | 'failed' | 'expired'; sentTo?: string }> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.status !== 'open') return { status: 'expired' };
    const outcome = await this.withCompany(pending.owner, pending.domain, async (client) => {
      const scope = withinType(client, 'mediated', pending.scope);
      const result = await mediatedSignIn(client, scope, credentials);
      return { result, scope };
    });
    return this.#mediatedOutcome(pending, outcome.result, outcome.scope);
  }

  async mediatedCode(
    id: string,
    code: string,
  ): Promise<{ status: 'connected' | 'code_required' | 'failed' | 'expired'; sentTo?: string }> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.flow === null || pending.status !== 'open')
      return { status: 'expired' };
    const flow = this.#sealer.open<Flow>(pending.flow);
    if (flow.kind !== 'mediated') return { status: 'failed' };
    const result = await this.withCompany(pending.owner, pending.domain, (client) =>
      submitMediatedCode(client, flow.scope, flow.signInId, code),
    );
    return this.#mediatedOutcome(pending, result, flow.scope);
  }

  async #mediatedOutcome(
    pending: PoppyPendingConnect,
    result: Awaited<ReturnType<typeof mediatedSignIn>>,
    scope: string,
  ): Promise<{ status: 'connected' | 'code_required' | 'failed' | 'expired'; sentTo?: string }> {
    if (result.status === 'complete') {
      await this.#connected(pending);
      return { status: 'connected' };
    }
    if (result.status === 'code_required') {
      const sentTo = result.sentTo ?? '';
      await this.#store.updatePending(pending.id, {
        flow: this.#sealer.seal({
          kind: 'mediated',
          signInId: result.signInId,
          sentTo,
          scope,
        } satisfies Flow),
      });
      return { status: 'code_required', sentTo };
    }
    return { status: result.status };
  }

  /** Device Sign-In (§4.6): the code and the Company page where the person approves it. */
  async deviceStart(id: string): Promise<{ userCode: string; verificationUri: string } | null> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.status !== 'open') return null;
    return this.withCompany(pending.owner, pending.domain, async (client) => {
      const scope = withinType(client, 'device', pending.scope);
      const d = await client.tokens.deviceAuthorization(scope);
      const flow: Flow = {
        kind: 'device',
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        ...(d.verification_uri_complete !== undefined
          ? { verificationUriComplete: d.verification_uri_complete }
          : {}),
        scope,
      };
      await this.#store.updatePending(id, { flow: this.#sealer.seal(flow) });
      return {
        userCode: d.user_code,
        verificationUri: d.verification_uri_complete ?? d.verification_uri,
      };
    });
  }

  /** The device code already started for this connect, if any. */
  async deviceInfo(id: string): Promise<{ userCode: string; verificationUri: string } | null> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.flow === null) return null;
    const flow = this.#sealer.open<Flow>(pending.flow);
    if (flow.kind !== 'device') return null;
    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUriComplete ?? flow.verificationUri,
    };
  }

  /** One device-code exchange, when the person says they approved. */
  async deviceCheck(id: string): Promise<'connected' | 'pending' | 'failed' | 'expired'> {
    const pending = await this.#openPending(id);
    if (pending === null || pending.flow === null) return 'expired';
    if (pending.status === 'connected') return 'connected';
    const flow = this.#sealer.open<Flow>(pending.flow);
    if (flow.kind !== 'device') return 'failed';
    try {
      const result = await this.withCompany(pending.owner, pending.domain, (client) =>
        pollDeviceSignInOnce(client, flow.deviceCode, flow.scope),
      );
      if (result === 'pending') return 'pending';
    } catch (error) {
      this.#log(`poppy-connections: Device Sign-In failed: ${(error as Error).message}`);
      return 'failed';
    }
    await this.#connected(pending);
    return 'connected';
  }

  async #connected(pending: PoppyPendingConnect): Promise<void> {
    await this.#store.updatePending(pending.id, { status: 'connected', flow: null });
    const row = await this.#store.getConnection(pending.owner, pending.issuer);
    if (row !== null && row.organization !== pending.organization) {
      await this.#store.saveConnection({ ...row, organization: pending.organization });
    }
    try {
      await this.#onConnected?.({ ...pending, status: 'connected' });
    } catch (error) {
      this.#log(`poppy-connections: resuming the conversation failed: ${(error as Error).message}`);
    }
  }

  // ── the Company's APIs and agent ──────────────────────────────────────────

  /** The Company's MCP server, with a Bearer token for it (§6). Closed by the caller. */
  mcp(owner: string, domain: string): Promise<McpConnection> {
    return this.withCompany(owner, domain, (client) => connectMcp(client));
  }

  /**
   * One exchange with the Company's agent (§7): `act: false` narrows the token to the read scopes
   * (`policy.readScopes`, default `poppy:read`), so a question can never make the Company act;
   * `act: true` uses the whole grant — the tools gate that behind the person's confirmation.
   */
  ask(
    owner: string,
    domain: string,
    text: string,
    options: { act: boolean },
  ): Promise<PoppyCompanyReply> {
    return this.withCompany(owner, domain, async (client, policy) => {
      let scope: string | undefined;
      if (!options.act) {
        const granted = new Set((client.accountToken?.scope ?? '').split(' ').filter(Boolean));
        const read = (policy.readScopes ?? DEFAULT_READ_SCOPES).filter((s) => granted.has(s));
        if (client.accountToken && read.length === 0) {
          return {
            conversationId: '',
            replies: [],
            authorization: { error: 'no_read_scope' },
            status: 'idle',
          };
        }
        scope = read.length > 0 ? read.join(' ') : undefined;
      }
      const conv = new ConversationClient(client, undefined, { scope });
      const message = { id: newMessageId(), sender: 'agent' as const, text };
      const open = Object.entries(client.state.conversations)
        .filter(
          ([, c]) =>
            !c.closed && c.endpoint === conv.endpoint && c.parentConversationId === undefined,
        )
        .sort(([, a], [, b]) => b.createdAt - a.createdAt)[0]?.[0];
      let conversationId: string;
      try {
        if (open === undefined) throw new ConversationError('conversation_not_found');
        await conv.send(open, message);
        conversationId = open;
      } catch (error) {
        if (!(error instanceof ConversationError)) throw error;
        if (open !== undefined)
          client.state.conversations[open] = { ...client.state.conversations[open]!, closed: true };
        conversationId = (await conv.start(message)).conversation_id;
      }
      const deadline = Date.now() + (this.#config.replyTimeoutMs ?? 90_000);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.max(1000, deadline - Date.now()));
      const reply: PoppyCompanyReply = { conversationId, replies: [], status: 'working' };
      try {
        for await (const item of conv.follow(conversationId, {
          untilSettled: true,
          signal: ac.signal,
        })) {
          if (item.kind !== 'event') continue;
          const ev: ConversationEvent = item.event;
          if (ev.type === 'message' && ev.message?.role === 'company') {
            reply.replies.push({
              text: ev.message.text ?? '',
              ...(ev.message.data !== undefined ? { data: ev.message.data } : {}),
            });
          } else if (ev.type === 'authorization') {
            reply.authorization = {
              error: String(ev.error ?? 'insufficient_scope'),
              ...(typeof ev.scope === 'string' ? { scope: ev.scope } : {}),
            };
          } else if (ev.type === 'state' && typeof ev.status === 'string') {
            reply.status = ev.status;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      if (ac.signal.aborted && reply.status === 'working') reply.status = 'timeout';
      await client.save();
      return reply;
    });
  }
}

/** The scopes a Company offers for signing in, broadest list first. */
function offeredScopes(client: CompanyClient): string[] {
  const auth = client.document.auth;
  return auth?.direct?.scopes ?? auth?.device?.scopes ?? auth?.mediated?.scopes ?? [];
}

/** `scope` narrowed to what one sign-in type can grant (falls back to all it offers). */
function withinType(
  client: CompanyClient,
  type: 'direct' | 'device' | 'mediated',
  scope: string,
): string {
  const offered = client.document.auth?.[type]?.scopes ?? [];
  const wanted = scope.split(' ').filter((s) => offered.includes(s));
  return (wanted.length > 0 ? wanted : offered).join(' ');
}

/** Private EC JWKs (or poppy-client `StoredKey`s, or a JSON string of either) → `StoredKey[]`. */
export async function normalizeKeys(
  input: PoppyConnectionsConfig['identity']['keys'],
): Promise<StoredKey[]> {
  const list = (typeof input === 'string' ? JSON.parse(input) : input) as unknown[];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      '[@adonis-agora/agent] poppy-connections: `identity.keys` needs at least one private key',
    );
  }
  return Promise.all(
    list.map(async (raw) => {
      const value = raw as Record<string, unknown>;
      if (value.privateJwk && value.publicJwk && typeof value.kid === 'string')
        return value as unknown as StoredKey;
      const jwk = value as JWK;
      if (
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        typeof jwk.d !== 'string' ||
        typeof jwk.x !== 'string' ||
        typeof jwk.y !== 'string'
      ) {
        throw new Error(
          '[@adonis-agora/agent] poppy-connections: identity keys must be private EC P-256 JWKs',
        );
      }
      const publicJwk: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
      const kid = jwk.kid ?? (await calculateJwkThumbprint(publicJwk, 'sha256'));
      return {
        kid,
        privateJwk: { ...jwk, kid, alg: 'ES256', use: 'sig' },
        publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
      };
    }),
  );
}

export { OAuthError, PoppyError, ResourceAuthError };
