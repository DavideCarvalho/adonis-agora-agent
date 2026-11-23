import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { personalAgentGate } from '../src/a2a/gate.js';
import { PERSONAL_AGENT_ROLE } from '../src/a2a/permission-tool.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  ToolRegistry,
} from '../src/index.js';
import {
  createPoppyHandler,
  InMemoryPoppyStore,
  nodeExchange,
  POPPY_AUTHENTICATE_SLOT,
  type PoppyAuthenticate,
  PoppyConversations,
  type PoppyConversationsOptions,
  type PoppyEvent,
  type PoppyStore,
  poppyActorId,
  publicOrigin,
} from '../src/poppy/index.js';
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '../src/spi/model-provider.js';
import { InMemoryAgentStore } from '../src/testing/index.js';

// ── fakes ──────────────────────────────────────────────────────────────────────

const CLIENT = 'https://pa.example';

/** What the resolver was last asked: the request and the options. */
const seen: { request: Parameters<PoppyAuthenticate>[0] | null; options: unknown } = {
  request: null,
  options: undefined,
};

/**
 * `DPoP <user>|<scopes,comma>|<in|out>|<account>[|<toActor id>]` — anything else is
 * `invalid_token`; user `forbidden` is an `insufficient_scope` refusal, `nonce` a `use_dpop_nonce`.
 */
const fakeResolver: PoppyAuthenticate = async (request, options) => {
  seen.request = request;
  seen.options = options;
  const header = request.headers.authorization;
  const match = /^DPoP (.+)$/.exec(typeof header === 'string' ? header : '');
  if (!match?.[1]) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      wwwAuthenticate: 'DPoP error="invalid_token"',
    };
  }
  const [user = '', scopes = '', state = 'out', account, toActor] = match[1].split('|');
  if (user === 'forbidden') {
    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      scope: 'poppy:read',
      wwwAuthenticate: 'DPoP error="insufficient_scope", scope="poppy:read"',
    };
  }
  if (user === 'bad-session') {
    return {
      ok: false,
      status: 400,
      error: 'invalid_session',
      description: 'expired',
      wwwAuthenticate: null,
    };
  }
  if (user === 'limited') {
    return {
      ok: false,
      status: 429,
      error: null,
      wwwAuthenticate: null,
      headers: { 'Retry-After': '30' },
    };
  }
  if (user === 'nonce') {
    return {
      ok: false,
      status: 401,
      error: 'use_dpop_nonce',
      description: 'Use the DPoP nonce',
      wwwAuthenticate: 'DPoP error="use_dpop_nonce"',
      headers: { 'DPoP-Nonce': 'n-123' },
    };
  }
  const signedIn = state === 'in';
  return {
    ok: true,
    principal: {
      userId: user,
      accountId: signedIn ? (account ?? null) : null,
      clientId: CLIENT,
      scopes: scopes === '' ? [] : scopes.split(','),
      sessionId: 's1',
      signedIn,
      resource: null,
      tokenType: 'DPoP',
      ...(toActor ? { actor: { id: toActor, roles: ['USER'] } } : {}),
    },
  };
};

type Turn = { chunks?: string[]; text?: string; toolCall?: { name: string; input: unknown } };
type Script = (args: ModelTurnArgs, turnIndex: number) => Turn | Promise<Turn>;

/** A model that streams its text in pieces, so a reader sees several deltas. */
class ChunkedModel implements ModelProvider {
  calls: ModelTurnArgs[] = [];
  #ids = 0;
  constructor(private readonly script: Script) {}
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.calls.push(args);
    const turnIndex = args.messages.filter((m) => m.role === 'assistant').length;
    const turn = await this.script(args, turnIndex);
    const chunks = turn.chunks ?? (turn.text !== undefined ? [turn.text] : []);
    for (const chunk of chunks) {
      await args.sink.write({ t: 'text', v: chunk });
      if (chunks.length > 1) await sleep(15);
    }
    return {
      text: chunks.join(''),
      toolCalls: turn.toolCall ? [{ id: `call-${++this.#ids}`, ...turn.toolCall }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildAgent(script: Script) {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  const model = new ChunkedModel(script);
  const factory = new AgentDepsFactory({
    model,
    store,
    sink: new InProcessTokenStreamSink(),
    rolesPolicy: personalAgentGate(new DefaultToolAuthorizer()),
    registry,
    agents: new AgentRegistry(),
  });
  const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
  return { service, registry, model, store };
}

interface Harness {
  url: string;
  conversations: PoppyConversations;
  store: PoppyStore;
  close(): Promise<void>;
}

async function serve(
  options: Omit<PoppyConversationsOptions, 'store'> & { store?: PoppyStore },
  handler: { authenticate?: PoppyAuthenticate } = {},
): Promise<Harness> {
  const store = options.store ?? new InMemoryPoppyStore();
  const conversations = new PoppyConversations({ pollMs: 50, ...options, store });
  const handle = createPoppyHandler({
    path: 'poppy/conversations',
    conversations,
    keepAliveMs: 60_000,
    ...handler,
  });
  let server: Server;
  const url = await new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const origin = `http://${req.headers.host}`;
      void handle(nodeExchange(req, res, { origin })).then((handled) => {
        if (!handled) {
          res.writeHead(418);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  return {
    url,
    conversations,
    store,
    close: async () => {
      conversations.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function setup(script: Script, extra: Partial<PoppyConversationsOptions> = {}) {
  const agent = buildAgent(script);
  return serve({
    service: agent.service,
    toolRoles: (name) => agent.registry.spec(name)?.roles,
    ...extra,
  }).then((h) => ({ ...h, agent }));
}

const auth = (token: string) => ({ authorization: `DPoP ${token}`, 'poppy-version': '1.0' });
const U1 = auth('u1||out');

async function post(h: Harness, path: string, body: unknown, headers = U1) {
  const res = await fetch(`${h.url}/poppy/conversations${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function get(h: Harness, path: string, headers = U1) {
  const res = await fetch(`${h.url}/poppy/conversations${path}`, { headers });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

let requestIds = 0;
const rid = (prefix = 'req') => `${prefix}_${++requestIds}`;
const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  id: rid('msg'),
  message: { author: { type: 'agent' }, text, ...extra },
});
/** A handoff, handoff-cancel or close body: only a request ID (§8.9, §8.12). */
const req = () => ({ id: rid() });

/** Read events until `until` holds over everything read so far (and the latest read's state). */
async function readUntil(
  h: Harness,
  id: string,
  until: (events: PoppyEvent[], last: Record<string, any>) => boolean,
  headers = U1,
  timeoutMs = 4000,
): Promise<{ events: PoppyEvent[]; last: Record<string, unknown> }> {
  const events: PoppyEvent[] = [];
  let cursor: string | null = null;
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await get(h, `/${id}/events?wait=1${cursor ? `&cursor=${cursor}` : ''}`, headers);
    expect(res.status).toBe(200);
    last = res.body;
    events.push(...res.body.events);
    cursor = res.body.cursor;
    if (until(events, last)) return { events, last };
  }
  throw new Error(`timed out; events: ${JSON.stringify(events)}`);
}

const companyMessages = (events: PoppyEvent[]) =>
  events.filter(
    (e) => e.type === 'message' && (e.message as { role: string }).role === 'company',
  ) as (PoppyEvent & {
    message: { id: string; text?: string; data?: any; as_of_request?: string };
  })[];

/** The Company is no longer replying (§8.7) and has said something. */
const settled = (events: PoppyEvent[], last: Record<string, any>) =>
  last.working === false && companyMessages(events).length > 0;

let harness: (Harness & { agent?: ReturnType<typeof buildAgent> }) | null = null;

beforeEach(() => {
  (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT] = fakeResolver;
});

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  await harness?.close();
  harness = null;
});

// ── routing and auth ──────────────────────────────────────────────────────────

describe('Poppy routing and auth', () => {
  it('leaves other paths alone; 404/405 inside the endpoint', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    expect((await fetch(`${harness.url}/elsewhere`)).status).toBe(418);
    expect((await get(harness, '/cnv_1/nope')).status).toBe(404);
    const wrong = await fetch(`${harness.url}/poppy/conversations/cnv_1/events`, {
      method: 'POST',
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });

  it('without a resolver the endpoint is disabled (501)', async () => {
    delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
    harness = await setup(() => ({ text: 'hi' }));
    const res = await post(harness, '', msg('hi'));
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('an explicit authenticate overrides the global slot', async () => {
    const agent = buildAgent(() => ({ text: 'hi' }));
    harness = await serve(
      { service: agent.service, toolRoles: () => undefined },
      {
        authenticate: async () => ({
          ok: false,
          status: 401,
          error: 'invalid_token',
          wwwAuthenticate: 'DPoP error="invalid_token", error_description="custom"',
        }),
      },
    );
    const res = await post(harness, '', msg('hi'));
    expect(res.headers.get('www-authenticate')).toContain('custom');
  });

  it('passes the resolver the full public URL, the raw headers, and no options', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    await fetch(`${harness.url}/poppy/conversations/cnv_x/events?cursor=evt_1&wait=0`, {
      headers: { ...U1, DPoP: 'proof.jwt' },
    });
    expect(seen.request).toMatchObject({
      method: 'GET',
      url: `${harness.url}/poppy/conversations/cnv_x/events?cursor=evt_1&wait=0`,
      headers: { authorization: 'DPoP u1||out', dpop: 'proof.jwt' },
    });
    expect(seen.options).toBeUndefined();
  });

  it('invalid_session is a JSON body with no challenge; a rate limit passes Retry-After', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    const bad = await post(harness, '', msg('hi'), auth('bad-session'));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_session', error_description: 'expired' });
    expect(bad.headers.get('www-authenticate')).toBeNull();
    const limited = await post(harness, '', msg('hi'), auth('limited'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(limited.headers.get('www-authenticate')).toBeNull();
  });

  it('forwards a refusal headers (DPoP-Nonce) and description, under its status', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    const res = await post(harness, '', msg('hi'), auth('nonce'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({});
    expect(res.headers.get('dpop-nonce')).toBe('n-123');
    expect(res.headers.get('www-authenticate')).toBe('DPoP error="use_dpop_nonce"');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers the resolver refusal with its status, error and challenge — before reading the body', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    const missing = await post(harness, '', '{not json', {} as never);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({});
    expect(missing.headers.get('www-authenticate')).toBe('DPoP error="invalid_token"');
    const forbidden = await post(harness, '', msg('hi'), auth('forbidden'));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({});
    expect(forbidden.headers.get('www-authenticate')).toContain('insufficient_scope');
  });
});

// ── versions ─────────────────────────────────────────────────────────────────

describe('Poppy versions (§3.4, §8.2)', () => {
  it('a missing or incompatible Poppy-Version is version_unsupported (400, JSON)', async () => {
    harness = await setup(() => ({ text: 'hi' }));
    for (const version of [undefined, '0.3', '2.0', 'one']) {
      const headers: Record<string, string> = { authorization: 'DPoP u1||out' };
      if (version !== undefined) headers['poppy-version'] = version;
      const res = await post(harness, '', msg('hi'), headers as never);
      expect(res.status, String(version)).toBe(400);
      expect(res.body).toEqual({ error: 'version_unsupported' });
    }
    // A later 1.x minor is compatible: handled as 1.0.
    const later = await post(harness, '', msg('hi'), { ...U1, 'poppy-version': '1.1' });
    expect(later.status).toBe(201);
  });

  it("the resolver's version is used when it gives one; its version_unsupported is a JSON body", async () => {
    const agent = buildAgent(() => ({ text: 'hi' }));
    let version: string | undefined = '1.0';
    harness = await serve(
      { service: agent.service, toolRoles: () => undefined },
      {
        authenticate: async (request) => {
          if (version === undefined) {
            return { ok: false, status: 400, error: 'version_unsupported', wwwAuthenticate: null };
          }
          const result = await fakeResolver(request);
          return result.ok
            ? {
                ok: true,
                principal: {
                  ...result.principal,
                  protocolVersion: version,
                  extensions: { links: '1' },
                },
              }
            : result;
        },
      },
    );
    // No header: the resolver's version stands.
    const res = await post(harness, '', msg('hi'), { authorization: 'DPoP u1||out' } as never);
    expect(res.status).toBe(201);
    const stored = await harness.store.getConversation(res.body.conversation_id);
    expect(stored).toMatchObject({ protocolVersion: '1.0', extensions: { links: '1' } });
    version = undefined;
    const refused = await post(harness, '', msg('hi'));
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'version_unsupported' });
  });

  it('records the versions a conversation started in; continueVersion refuses with version_mismatch', async () => {
    harness = await setup(() => ({ text: 'ok' }), {
      // Reads carry over; new requests only in the protocol version it started in.
      continueVersion: ({ started, request, kind }) =>
        kind === 'read' || started.protocolVersion === request.protocolVersion,
    });
    const v11 = {
      ...U1,
      'poppy-version': '1.1',
      'poppy-extensions': '"links";v="1", "x.example/y";v="2"',
    };
    const created = await post(harness, '', msg('hi'), v11);
    const id = created.body.conversation_id;
    expect(await harness.store.getConversation(id)).toMatchObject({
      protocolVersion: '1.1',
      extensions: { links: '1', 'x.example/y': '2' },
    });
    await readUntil(harness, id, settled);
    const mismatch = await post(harness, `/${id}/messages`, msg('more'));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toEqual({ error: 'version_mismatch', protocol_version: '1.1' });
    for (const path of ['handoff', 'handoff/cancel', 'close']) {
      const res = await post(harness, `/${id}/${path}`, req());
      expect(res.body.error, path).toBe('version_mismatch');
    }
    expect((await get(harness, `/${id}/events`)).status).toBe(200);
    expect((await post(harness, `/${id}/messages`, msg('more'), v11)).status).toBe(202);
  });

  it('by default a conversation continues in any compatible version', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const id = (await post(harness, '', msg('hi'), { ...U1, 'poppy-version': '1.1' })).body
      .conversation_id;
    expect((await post(harness, `/${id}/messages`, msg('more'))).status).toBe(202);
  });
});

// ── messages ─────────────────────────────────────────────────────────────────

describe('Poppy messages (§8.3, §8.4)', () => {
  it('starts a conversation, answers it, and continues it', async () => {
    harness = await setup((args) => ({ text: `reply to ${args.messages.length}` }));
    const first = msg('The jacket is not warm enough.', {
      context: { locale: 'en-US', time_zone: 'America/Los_Angeles', user_available: true },
    });
    const created = await post(harness, '', first);
    expect(created.status).toBe(201);
    // Accepted, not acted on: the response has only the conversation's ID (§8.3).
    expect(created.body).toEqual({
      conversation_id: expect.stringMatching(/^cnv_[A-Za-z0-9_-]+$/),
    });
    const id = created.body.conversation_id;
    const read = await readUntil(harness, id, settled);
    for (const event of read.events) {
      expect(event).toMatchObject({
        id: expect.stringMatching(/^evt_/),
        type: expect.any(String),
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    }
    // `working` is not an event, and nothing else changed: the messages only (§8.7).
    expect(read.events.map((e) => e.type)).toEqual(['message', 'message']);
    // The Personal Agent's message has its request's ID, and the role the Company set (§8.4).
    expect(read.events[0]?.message).toEqual({
      id: first.id,
      role: 'user',
      author: { type: 'agent' },
      text: 'The jacket is not warm enough.',
      context: { locale: 'en-US', time_zone: 'America/Los_Angeles', user_available: true },
    });
    expect(companyMessages(read.events)[0]?.message).toMatchObject({
      role: 'company',
      author: { type: 'agent' },
      as_of_request: first.id,
      text: expect.stringMatching(/^reply to/),
    });
    expect(read.last).toEqual({
      conversation_id: id,
      events: expect.any(Array),
      cursor: read.events.at(-1)?.id,
      has_more: false,
      working: false,
      handoff: 'none',
      responder: 'agent',
      closed: false,
    });

    const human = msg('Medium, please.', { author: { type: 'human' } });
    const second = await post(harness, `/${id}/messages`, human);
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ conversation_id: id });
    const all = await readUntil(harness, id, (events) => companyMessages(events).length === 2);
    expect(all.events.find((e) => (e.message as any)?.id === human.id)?.message).toMatchObject({
      author: { type: 'human' },
    });
    expect(companyMessages(all.events)[1]?.message.as_of_request).toBe(human.id);
  });

  it('a POST with wait answers as a read from cursor, keeping its status code', async () => {
    harness = await setup(() => ({ text: 'quick' }));
    const res = await fetch(`${harness.url}/poppy/conversations?wait=3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...U1 },
      body: JSON.stringify(msg('hi')),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      conversation_id: expect.any(String),
      cursor: expect.any(String),
      has_more: false,
      working: expect.any(Boolean),
      handoff: 'none',
      responder: 'agent',
      closed: false,
    });
    expect(body.events[0].type).toBe('message');

    // From the cursor of the user's message: held until the reply.
    const id = body.conversation_id;
    const cursor = body.events.at(-1).id;
    await readUntil(harness, id, settled);
    const now = (await get(harness, `/${id}/events`)).body.cursor;
    const next = await fetch(
      `${harness.url}/poppy/conversations/${id}/messages?wait=3&cursor=${now}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...U1 },
        body: JSON.stringify(msg('again')),
      },
    );
    expect(next.status).toBe(202);
    const nextBody = await next.json();
    expect(nextBody.events[0].message.text).toBe('again');
    expect(cursor).not.toBe(now);
  });

  it('a retried request (same id, path and body) is accepted once — first message included', async () => {
    harness = await setup(() => ({ text: 'once' }));
    const body = { id: 'msg_retry_1', message: { author: { type: 'agent' }, text: 'hi' } };
    const a = await post(harness, '', body);
    // Unknown fields, and `id`/`role` on the message, are ignored (§3.3, §8.4): the same request.
    const b = await post(harness, '', {
      ...body,
      future: 1,
      message: { ...body.message, id: 'x', role: 'company', author: { type: 'agent', name: 'n' } },
    });
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const id = a.body.conversation_id;
    await readUntil(harness, id, settled);

    const later = { id: 'msg_retry_2', message: { author: { type: 'agent' }, text: 'again' } };
    const c = await post(harness, `/${id}/messages`, later);
    const d = await post(harness, `/${id}/messages`, later);
    expect(d.status).toBe(202);
    expect(d.body).toEqual(c.body);
    await readUntil(harness, id, (e) => companyMessages(e).length === 2);
    await sleep(100);
    const after = await get(harness, `/${id}/events`);
    const userTexts = after.body.events
      .filter((e: PoppyEvent) => (e.message as any)?.role === 'user')
      .map((e: PoppyEvent) => (e.message as any).text);
    expect(userTexts).toEqual(['hi', 'again']);
    expect(harness.agent?.model.calls.length).toBe(2);
    // A retry is answered as before, even after the conversation closed.
    await post(harness, `/${id}/close`, req());
    expect((await post(harness, `/${id}/messages`, later)).status).toBe(202);
  });

  it('a reused id with another path or body is request_id_conflict (409)', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const a = await post(harness, '', {
      id: 'msg_c',
      message: { author: { type: 'agent' }, text: 'one' },
    });
    const id = a.body.conversation_id;
    const b = await post(harness, '', {
      id: 'msg_c',
      message: { author: { type: 'agent' }, text: 'two' },
    });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('request_id_conflict');
    // Unique per User across all requests, not per conversation or path.
    const c = await post(harness, `/${id}/messages`, {
      id: 'msg_c',
      message: { author: { type: 'agent' }, text: 'one' },
    });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('request_id_conflict');
    expect((await post(harness, `/${id}/handoff`, { id: 'msg_c' })).body.error).toBe(
      'request_id_conflict',
    );
    // Another User may use the same id.
    const d = await post(
      harness,
      '',
      { id: 'msg_c', message: { author: { type: 'agent' }, text: 'two' } },
      auth('u2||out'),
    );
    expect(d.status).toBe(201);
  });

  it('validates requests: an id, a message with content, URL-safe ids, JSON', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    for (const body of [
      { message: { author: { type: 'agent' }, text: 'x' } },
      { id: 'msg_v1', message: { author: { type: 'agent' } } },
      { id: 'bad id!', message: { author: { type: 'agent' }, text: 'x' } },
      { id: 'msg_v2', message: { sender: 'robot', text: 'x' } },
      { id: 'msg_v3', message: { author: { type: 'agent' }, data: [1] } },
      { id: 'msg_v4', message: { author: { type: 'agent' }, context: { user_available: 'yes' } } },
      { id: 'msg_v5' },
      {},
      '{',
    ]) {
      const res = await post(harness, '', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    for (const path of ['handoff', 'handoff/cancel', 'close']) {
      const res = await post(harness, `/${id}/${path}`, {});
      expect(res.status, path).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
  });

  it('an author type it does not know is an agent; extension content it does not support is ignored', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const body = {
      id: rid('msg'),
      message: {
        author: { type: 'robot' },
        text: 'hi',
        as_of_cursor: 'evt_x',
        extensions: { 'x.example/thing': { a: 1 } },
      },
    };
    const id = (await post(harness, '', body)).body.conversation_id;
    const { events } = await readUntil(harness, id, settled);
    expect(events[0]?.message).toEqual({
      id: body.id,
      role: 'user',
      author: { type: 'agent' },
      as_of_cursor: 'evt_x',
      text: 'hi',
    });
    // A person's message carries no as_of_cursor (§8.4).
    const human = {
      id: rid('msg'),
      message: { author: { type: 'human' }, text: 'x', as_of_cursor: 'evt_x' },
    };
    await post(harness, `/${id}/messages`, human);
    const after = (await get(harness, `/${id}/events`)).body.events as PoppyEvent[];
    expect(after.find((e) => (e.message as any)?.id === human.id)?.message).not.toHaveProperty(
      'as_of_cursor',
    );
  });

  it('a context-only message updates context without a turn; null clears a field; data reaches the model as JSON', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const created = await post(harness, '', {
      id: 'msg_ctx0',
      message: { author: { type: 'agent' }, context: { locale: 'en-US', time_zone: 'UTC' } },
    });
    const id = created.body.conversation_id;
    // Recorded, and acted on at once: nothing to reply to.
    const first = await get(harness, `/${id}/events`);
    expect(first.body.working).toBe(false);
    expect(first.body.events).toHaveLength(1);
    await post(harness, `/${id}/messages`, {
      id: 'msg_ctx1',
      message: { author: { type: 'agent' }, context: { user_available: false, locale: null } },
    });
    await sleep(100);
    expect(harness.agent?.model.calls.length).toBe(0);
    expect((await harness.store.getConversation(id))?.context).toEqual({
      time_zone: 'UTC',
      user_available: false,
    });
    await post(harness, `/${id}/messages`, {
      id: 'msg_ctx2',
      message: { author: { type: 'agent' }, text: 'Seats please', data: { seat: '14A' } },
    });
    await readUntil(harness, id, (e) => companyMessages(e).length === 1);
    const sent = JSON.stringify(harness.agent?.model.calls[0]?.messages);
    expect(sent).toContain('Seats please');
    expect(sent).toContain('14A');
  });

  it('a failed turn says so, and the conversation is no longer working', async () => {
    harness = await setup(() => {
      throw new Error('model down');
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    const { events } = await readUntil(harness, id, settled);
    expect(companyMessages(events)[0]?.message.text).toMatch(/something went wrong/);
  });
});

// ── events ───────────────────────────────────────────────────────────────────

describe('Poppy events (§8.5)', () => {
  it('pages with cursor and has_more; an empty read keeps the cursor', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const created = await post(harness, '', {
      id: 'msg_p0',
      message: { author: { type: 'agent' }, context: { locale: 'en' } },
    });
    const id = created.body.conversation_id;
    for (let i = 1; i <= 104; i++) {
      await post(harness, `/${id}/messages`, {
        id: `msg_p${i}`,
        message: { author: { type: 'agent' }, context: { n: i } },
      });
    }
    const page1 = await get(harness, `/${id}/events`);
    expect(page1.body.events).toHaveLength(100);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.cursor).toBe(page1.body.events[99].id);
    const page2 = await get(harness, `/${id}/events?cursor=${page1.body.cursor}`);
    expect(page2.body.events).toHaveLength(5);
    expect(page2.body.has_more).toBe(false);
    const empty = await get(harness, `/${id}/events?cursor=${page2.body.cursor}`);
    expect(empty.body).toEqual({
      conversation_id: id,
      events: [],
      cursor: page2.body.cursor,
      has_more: false,
      working: false,
      handoff: 'none',
      responder: 'agent',
      closed: false,
    });
  });

  it('invalid_cursor (400) and cursor_expired (410)', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const a = (await post(harness, '', msg('a'))).body.conversation_id;
    const b = (await post(harness, '', msg('b'))).body.conversation_id;
    const eventsOfB = await readUntil(harness, b, settled);
    const unknown = await get(harness, `/${a}/events?cursor=evt_zzz`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_cursor');
    // Another conversation's cursor is not this one's.
    const foreign = await get(harness, `/${a}/events?cursor=${eventsOfB.events[0]?.id}`);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_cursor');

    await harness.store.pruneEvents(b, Date.now() + 1000);
    const expired = await get(harness, `/${b}/events?cursor=${eventsOfB.events[0]?.id}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe('cursor_expired');
    // Read from the beginning: what is left.
    const fresh = await get(harness, `/${b}/events`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.events).toHaveLength(1);
  });

  it('wait returns as soon as an event arrives, and an empty list on timeout', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const id = (
      await post(harness, '', { id: 'msg_w0', message: { author: { type: 'agent' }, context: {} } })
    ).body.conversation_id;
    const start = await get(harness, `/${id}/events`);
    const startedAt = Date.now();
    const timedOut = await get(harness, `/${id}/events?cursor=${start.body.cursor}&wait=1`);
    expect(timedOut.body.events).toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    const fractional = await get(harness, `/${id}/events?wait=0.3`);
    expect(fractional.status).toBe(400);
    expect(fractional.body.error).toBe('invalid_request');
    const pending = get(harness, `/${id}/events?cursor=${start.body.cursor}&wait=5`);
    await sleep(100);
    await post(harness, `/${id}/messages`, {
      id: 'msg_w1',
      message: { author: { type: 'agent' }, context: { a: 1 } },
    });
    const woke = await pending;
    expect(woke.body.events[0].type).toBe('message');
  });

  it('wait also returns when working turns false, with no new event', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The turn ends without a reply: nothing is added, only `working` changes.
    harness = await setup(async () => {
      await gate;
      return { text: '' };
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    const start = await get(harness, `/${id}/events`);
    expect(start.body.working).toBe(true);
    const startedAt = Date.now();
    const pending = get(harness, `/${id}/events?cursor=${start.body.cursor}&wait=10`);
    await sleep(150);
    release();
    const woke = await pending;
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(woke.body.working).toBe(false);
  });
});

// ── streaming ────────────────────────────────────────────────────────────────

interface SseItem {
  id?: string;
  event?: string;
  data: any;
}

async function openSse(h: Harness, id: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(`${h.url}/poppy/conversations/${id}/events`, {
    headers: { ...U1, accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const items: SseItem[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const item: Partial<SseItem> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) item.id = line.slice(4);
            else if (line.startsWith('event: ')) item.event = line.slice(7);
            else if (line.startsWith('data: ')) item.data = JSON.parse(line.slice(6));
          }
          if (item.data !== undefined) items.push(item as SseItem);
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    } finally {
      done = true;
    }
  })();
  return {
    res,
    items,
    get done() {
      return done;
    },
    async until(predicate: (items: SseItem[]) => boolean, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(items)) {
        if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(items)}`);
        await sleep(10);
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

const workingIs = (value: boolean) => (items: SseItem[]) =>
  items.some((i) => i.event === 'working' && i.data.working === value);

describe('Poppy streaming (§8.6)', () => {
  it('working on open and on change, text-delta pieces, then the complete message; resumes after Last-Event-ID', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness = await setup(async () => {
      await gate;
      return { chunks: ['I can ', 'do ', 'that.'] };
    });
    const id = (await post(harness, '', msg('Exchange it?'))).body.conversation_id;
    const sse = await openSse(harness, id);
    expect(sse.res.headers.get('content-type')).toBe('text/event-stream');
    await sse.until((items) => items.some((i) => i.data.type === 'message'));
    // The stream opens with `working`, with no SSE id (§8.6).
    expect(sse.items[0]).toEqual({ event: 'working', data: { working: true } });
    release();
    await sse.until((items) =>
      items.some((i) => i.data.type === 'message' && i.data.message.role === 'company'),
    );
    const deltas = sse.items.filter((i) => i.event === 'text-delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    for (const delta of deltas) expect(delta.id).toBeUndefined();
    const reply = sse.items.find(
      (i) => i.data.type === 'message' && i.data.message.role === 'company',
    )!;
    expect(reply.id).toBe(reply.data.id);
    expect(deltas.map((d) => d.data.text).join('')).toBe('I can do that.');
    expect(new Set(deltas.map((d) => d.data.message_id))).toEqual(new Set([reply.data.message.id]));
    expect(reply.data.message.text).toBe('I can do that.');
    // Deltas come before the message they make up.
    expect(sse.items.indexOf(deltas.at(-1)!)).toBeLessThan(sse.items.indexOf(reply));
    await sse.until(workingIs(false));
    const stop = sse.items.find((i) => i.event === 'working' && i.data.working === false)!;
    expect(stop.id).toBeUndefined();
    expect(sse.items.indexOf(stop)).toBeGreaterThan(sse.items.indexOf(reply));
    await sse.close();

    // Reconnect from the user's message: the reply again, no deltas.
    const firstId = sse.items.find((i) => i.data.type === 'message')!.id!;
    const resumed = await openSse(harness, id, { 'last-event-id': firstId });
    await resumed.until((items) => items.some((i) => i.data.type === 'message'));
    expect(resumed.items.map((i) => i.event ?? i.data.type)).toEqual(['working', 'message']);
    expect(resumed.items[0]?.data).toEqual({ working: false });
    await resumed.close();
  });

  it('a bad Last-Event-ID is a JSON error, and the stream ends once the conversation closes', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    const bad = await fetch(`${harness.url}/poppy/conversations/${id}/events`, {
      headers: { ...U1, accept: 'text/event-stream', 'last-event-id': 'evt_nope' },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_cursor');
    const sse = await openSse(harness, id);
    await sse.until(workingIs(false));
    await post(harness, `/${id}/close`, req());
    await sse.until((items) => items.some((i) => i.data.type === 'state' && i.data.closed));
    expect(sse.items.find((i) => i.data.type === 'state')?.data).toMatchObject({
      handoff: 'none',
      responder: 'agent',
      closed: true,
    });
    const deadline = Date.now() + 2000;
    while (!sse.done && Date.now() < deadline) await sleep(10);
    expect(sse.done).toBe(true);
  });
});

// ── scopes ───────────────────────────────────────────────────────────────────

describe('Poppy scopes (§8.11)', () => {
  function withTools(script: Script) {
    return setup(script).then((h) => {
      const ran: string[] = [];
      h.agent.registry.register(
        {
          name: 'list_orders',
          kind: 'read',
          description: 'List orders',
          inputSchema: z.object({}),
          roles: ['scope:poppy:read'],
        },
        {
          execute: async () => {
            ran.push('list_orders');
            return { orders: ['A-1'] };
          },
        },
      );
      h.agent.registry.register(
        {
          name: 'cancel_order',
          kind: 'action',
          description: 'Cancel an order',
          inputSchema: z.object({ id: z.string() }),
          roles: ['scope:poppy:write'],
        },
        {
          execute: async (input) => {
            ran.push(`cancel_order:${(input as { id: string }).id}`);
            return { ok: true };
          },
        },
      );
      h.agent.registry.register(
        {
          name: 'store_hours',
          kind: 'read',
          description: 'Store hours',
          inputSchema: z.object({}),
          roles: [PERSONAL_AGENT_ROLE],
        },
        {
          execute: async () => {
            ran.push('store_hours');
            return { hours: '9-5' };
          },
        },
      );
      return { ...h, ran };
    });
  }

  const callThen =
    (name: string, input: unknown = {}) =>
    (_args: ModelTurnArgs, turn: number) =>
      turn === 0 ? { text: '', toolCall: { name, input } } : { text: 'done' };

  it('signed out: general tools run; an account read is not run and asks to sign in', async () => {
    const h = await withTools(callThen('list_orders'));
    harness = h;
    const id = (await post(h, '', msg('my orders?'))).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => e.some((x) => x.type === 'authorization'));
    expect(h.ran).toEqual([]);
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'insufficient_scope',
      scope: 'poppy:read',
    });

    const h2 = await withTools(callThen('store_hours'));
    const id2 = (await post(h2, '', msg('hours?'))).body.conversation_id;
    await readUntil(h2, id2, settled);
    expect(h2.ran).toEqual(['store_hours']);
    await h2.close();
  });

  it('read scope only: a change is not executed, and the authorization event names poppy:write', async () => {
    const h = await withTools(callThen('cancel_order', { id: 'A-1' }));
    harness = h;
    const reader = auth('u1|poppy:read|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), reader)).body.conversation_id;
    const { events } = await readUntil(
      h,
      id,
      (e, last) => e.some((x) => x.type === 'authorization') && settled(e, last),
      reader,
    );
    expect(h.ran).toEqual([]);
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'insufficient_scope',
      scope: 'poppy:write',
    });
  });

  it('write scope: the action runs, approved by the token scope', async () => {
    const h = await withTools(callThen('cancel_order', { id: 'A-1' }));
    harness = h;
    const writer = auth('u1|poppy:read,poppy:write|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, settled, writer);
    expect(h.ran).toEqual(['cancel_order:A-1']);
    expect(events.some((e) => e.type === 'authorization')).toBe(false);
  });

  it('runs as the account when signed in, as toActor when given, and poppy:<hash> signed out', async () => {
    const actors: { id: string; roles?: string[] }[] = [];
    const h = await setup(callThen('whoami'));
    harness = h;
    h.agent.registry.register(
      {
        name: 'whoami',
        kind: 'read',
        description: 'x',
        inputSchema: z.object({}),
        roles: [PERSONAL_AGENT_ROLE],
      },
      {
        execute: async (_input, ctx) => {
          actors.push(ctx.actor);
          return {};
        },
      },
    );
    for (const token of [
      'u1|poppy:read|in|acct-1',
      'u2|poppy:read|in|acct-2|profile-9',
      'u3||out',
    ]) {
      const id = (await post(h, '', msg('who?'), auth(token))).body.conversation_id;
      await readUntil(h, id, settled, auth(token));
    }
    expect(actors.map((a) => a.id)).toEqual(['acct-1', 'profile-9', poppyActorId(CLIENT, 'u3')]);
    expect(actors[0]?.roles).toEqual([PERSONAL_AGENT_ROLE, 'scope:poppy:read']);
    expect(actors[2]?.roles).toEqual([PERSONAL_AGENT_ROLE]);
  });

  it('once used signed in, the conversation belongs to the account', async () => {
    const h = await withTools(() => ({ text: 'ok' }));
    harness = h;
    const acct = auth('u1|poppy:read|in|acct-1');
    const id = (await post(h, '', msg('hi'), acct)).body.conversation_id;
    await readUntil(h, id, settled, acct);
    const signedOut = await get(h, `/${id}/events`, auth('u1||out'));
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toEqual({});
    expect(signedOut.headers.get('www-authenticate')).toBe('Bearer');
    const otherAccount = await get(h, `/${id}/events`, auth('u1|poppy:read|in|acct-2'));
    expect(otherAccount.status).toBe(404);
    expect(otherAccount.body.error).toBe('conversation_not_found');
  });

  it('another User or Personal Agent sees conversation_not_found', async () => {
    const h = await withTools(() => ({ text: 'ok' }));
    harness = h;
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    for (const path of [`/${id}/events`, '/cnv_unknown/events', '/bad%20id/events']) {
      const res = await get(h, path, auth('u2||out'));
      expect(res.status, path).toBe(404);
      expect(res.body.error).toBe('conversation_not_found');
    }
    const send = await post(h, `/${id}/messages`, msg('x'), auth('u2||out'));
    expect(send.status).toBe(404);
  });
});

// ── proposals and components ─────────────────────────────────────────────────

describe('Poppy actions and components', () => {
  it('an independent proposal is approved by the write scope and returned as data', async () => {
    const decided: { decision: string; via: string }[] = [];
    let execution: { status: string; result?: unknown } | null = null;
    const service = {
      chat: async () => ({ runId: 'r1', threadId: 'thread-1' }),
      subscribe: async function* () {
        yield* [
          {
            t: 'event',
            event: {
              kind: 'tool-input-available',
              id: 'c1',
              name: 'cancel_order',
              input: { id: 'A-1' },
              toolKind: 'action',
            },
          },
          {
            t: 'approval',
            runId: 'r1',
            id: 'c1',
            toolName: 'cancel_order',
            input: { id: 'A-1' },
            target: { kind: 'proposal', proposalId: 'p1' },
          },
        ] as never[];
      },
      approve: async () => {},
      reject: async () => {},
      skip: async () => {},
      cancel: async () => {},
      decideActionProposal: async (
        _a: unknown,
        _t: string,
        _id: string,
        decision: string,
        _b: unknown,
        via: string,
      ) => {
        decided.push({ decision, via });
        execution = { status: 'succeeded', result: { cancelled: 'A-1' } };
        return { status: 'applied' };
      },
      listActionProposals: async () => [
        {
          id: 'p1',
          input: { id: 'A-1' },
          confirmation: { title: 'Cancel order A-1?', verb: 'Cancel' },
          decision: decided[0]?.decision ?? 'pending',
          execution,
          outcome: { text: 'Order A-1 cancelled.' },
        },
      ],
    };
    harness = await serve({
      service: service as never,
      toolRoles: (name) => (name === 'cancel_order' ? ['scope:poppy:write'] : undefined),
    });
    const writer = auth('u1|poppy:read,poppy:write|in|acct-1');
    const id = (await post(harness, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(harness, id, (e) => companyMessages(e).length > 0, writer);
    expect(decided).toEqual([{ decision: 'approved', via: 'poppy' }]);
    expect(companyMessages(events)[0]?.message).toMatchObject({
      text: 'Order A-1 cancelled.',
      data: {
        actions: [
          {
            tool: 'cancel_order',
            status: 'succeeded',
            summary: { title: 'Cancel order A-1?' },
            result: { cancelled: 'A-1' },
          },
        ],
      },
    });
  });

  /** A one-proposal service: the model says `said`, the proposal ends `execution` / `decision`. */
  const proposalService = (opts: {
    said?: string;
    execution: { status: string; result?: unknown; error?: string };
    outcomeText?: string;
  }) => {
    let decision = 'pending';
    return {
      chat: async () => ({ runId: 'r9', threadId: 'thread-9' }),
      subscribe: async function* () {
        yield* [
          ...(opts.said ? [{ t: 'text', v: opts.said }] : []),
          {
            t: 'event',
            event: {
              kind: 'tool-input-available',
              id: 'c1',
              name: 'cancel_order',
              input: {},
              toolKind: 'action',
            },
          },
          {
            t: 'approval',
            runId: 'r9',
            id: 'c1',
            toolName: 'cancel_order',
            input: {},
            target: { kind: 'proposal', proposalId: 'p1' },
          },
        ] as never[];
      },
      approve: async () => {},
      reject: async () => {},
      skip: async () => {},
      cancel: async () => {},
      decideActionProposal: async (_a: unknown, _t: string, _id: string, d: string) => {
        decision = d;
        return { status: 'applied' };
      },
      listActionProposals: async () => [
        {
          id: 'p1',
          input: {},
          confirmation: { title: 'Cancel order A-1?', detail: 'Order A-1, $70', verb: 'Cancel' },
          decision,
          execution: decision === 'approved' ? opts.execution : null,
          ...(opts.outcomeText ? { outcome: { text: opts.outcomeText } } : {}),
        },
      ],
    };
  };
  const writeRoles = (name: string) =>
    name === 'cancel_order' ? ['scope:poppy:write'] : undefined;

  it('an executed action with no words from the model or the app is told by its summary', async () => {
    harness = await serve({
      service: proposalService({ execution: { status: 'succeeded' } }) as never,
      toolRoles: writeRoles,
    });
    const writer = auth('u1|poppy:write|in|acct-1');
    const id = (await post(harness, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(harness, id, (e) => companyMessages(e).length > 0, writer);
    expect(companyMessages(events)[0]?.message.text).toBe('Done: Cancel order A-1\nOrder A-1, $70');
  });

  it('an action that did not run replaces what the model claimed, and is a failed action', async () => {
    harness = await serve({
      service: proposalService({
        said: 'Done, order A-1 is cancelled!',
        execution: { status: 'failed', error: 'already shipped' },
      }) as never,
      toolRoles: writeRoles,
    });
    const writer = auth('u1|poppy:write|in|acct-1');
    const id = (await post(harness, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(harness, id, (e) => companyMessages(e).length > 0, writer);
    const message = companyMessages(events)[0]?.message;
    expect(message?.text).toBe('This could not be done: Cancel order A-1\nOrder A-1, $70');
    expect(message?.data).toMatchObject({
      actions: [{ tool: 'cancel_order', status: 'failed', error: 'already shipped' }],
    });
  });

  it("actions: 'reject' tells the refused action; formatAction words it the app's way", async () => {
    harness = await serve({
      service: proposalService({ execution: { status: 'succeeded' } }) as never,
      toolRoles: writeRoles,
      actions: 'reject',
      formatAction: (action) => `[${action.status}] ${action.summary.title}`,
    });
    const writer = auth('u1|poppy:write|in|acct-1');
    const id = (await post(harness, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(harness, id, (e) => companyMessages(e).length > 0, writer);
    expect(companyMessages(events)[0]?.message.text).toBe('[rejected] Cancel order A-1?');
  });

  it('a component becomes data, with its fallback as the text', async () => {
    const service = {
      chat: async () => ({ runId: 'r2', threadId: 'thread-2' }),
      subscribe: async function* () {
        yield* [
          {
            t: 'component',
            id: 'c1:ui:0',
            name: 'order_card',
            data: { id: 'A-1' },
            fallbackText: 'Order A-1: shipped.',
          },
          { t: 'component', id: 'c1:ui:1', name: 'preview', data: {}, partial: true },
        ] as never[];
      },
      approve: async () => {},
      reject: async () => {},
      skip: async () => {},
      cancel: async () => {},
    };
    harness = await serve({ service: service as never, toolRoles: () => undefined });
    const id = (await post(harness, '', msg('status?'))).body.conversation_id;
    const { events } = await readUntil(harness, id, (e) => companyMessages(e).length > 0);
    expect(companyMessages(events)[0]?.message).toEqual({
      id: expect.stringMatching(/^msg_/),
      role: 'company',
      author: { type: 'agent' },
      as_of_request: expect.stringMatching(/^msg_/),
      text: 'Order A-1: shipped.',
      data: {
        components: [
          { name: 'order_card', props: { id: 'A-1' }, fallback_text: 'Order A-1: shipped.' },
        ],
      },
    });
  });
});

// ── handoff and close ────────────────────────────────────────────────────────

const states = (events: PoppyEvent[]) =>
  events
    .filter((e) => e.type === 'state')
    .map((e) => `${e.handoff}/${e.responder}${e.closed ? '/closed' : ''}`);

describe('Poppy handoff (§8.9) and close (§8.12)', () => {
  it('without handoff hooks, the Company Agent says no one is available', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await readUntil(harness, id, settled);
    const res = await post(harness, `/${id}/handoff`, req());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ conversation_id: id });
    const after = await get(harness, `/${id}/events`);
    expect(after.body).toMatchObject({ handoff: 'none', responder: 'agent' });
    expect(companyMessages(after.body.events).at(-1)?.message).toMatchObject({
      author: { type: 'agent' },
      text: 'No one is available to take this conversation right now.',
    });
  });

  it('pending → the agent keeps answering → a person joins with the backlog → they leave → close cancels', async () => {
    const forwarded: string[] = [];
    const cancelled: string[] = [];
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    harness = await setup(
      async () => {
        await gate;
        return { text: 'agent answer' };
      },
      {
        handoff: {
          request: () => 'queued',
          message: ({ message }) => {
            forwarded.push(message.text ?? '');
          },
          cancel: ({ conversationId }) => {
            cancelled.push(conversationId);
          },
        },
      },
    );
    const h = harness;
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    const handoff = await post(h, `/${id}/handoff`, req());
    expect(handoff.status).toBe(202);
    expect(handoff.body).toEqual({ conversation_id: id });
    expect((await get(h, `/${id}/events`)).body).toMatchObject({
      handoff: 'pending',
      responder: 'agent',
    });
    // Asking again while pending changes nothing.
    await post(h, `/${id}/handoff`, req());

    // While pending the Company Agent keeps answering (§8.9).
    await post(h, `/${id}/messages`, msg('The order is A-1.'));
    await readUntil(h, id, (e) => companyMessages(e).length === 2);
    expect(forwarded).toEqual([]);

    // A message the agent has not taken up when the person joins goes to them: 'Color blue.'
    // waits behind the turn answering 'Size medium.'.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.conversations.handoff(id); // pending already: nothing
    await post(h, `/${id}/messages`, msg('Size medium.'));
    await sleep(50);
    await post(h, `/${id}/messages`, msg('Color blue.'));
    const joined = await h.conversations.humanJoined(id);
    expect(joined).toMatchObject({ handoff: 'none', responder: 'human' });
    expect(forwarded).toEqual(['Color blue.']);
    // The turn already under way still writes its reply.
    release();
    await readUntil(h, id, (e, last) => last.working === false && companyMessages(e).length === 3);
    await h.conversations.postMessage(id, {
      text: 'Hi, I am Sam.',
      author: { type: 'human', name: 'Sam' },
    });
    await post(h, `/${id}/messages`, msg('Medium.'));
    expect(forwarded).toEqual(['Color blue.', 'Medium.']);

    const read = await get(h, `/${id}/events`);
    expect(read.body.working).toBe(false);
    const events = read.body.events as PoppyEvent[];
    expect(states(events)).toEqual(['pending/agent', 'none/human']);
    expect(companyMessages(events).at(-1)?.message).toEqual({
      id: expect.any(String),
      role: 'company',
      author: { type: 'human', name: 'Sam' },
      text: 'Hi, I am Sam.',
    });

    const closed = await post(h, `/${id}/close`, req());
    expect(closed.status).toBe(202);
    expect(closed.body).toEqual({ conversation_id: id });
    expect(cancelled).toEqual([id]);
    const end = await get(h, `/${id}/events`);
    expect(end.body).toMatchObject({
      working: false,
      handoff: 'none',
      responder: 'human',
      closed: true,
    });
    expect(states(end.body.events).at(-1)).toBe('none/human/closed');
  });

  it('a hook that finds no one: handoff back to none with the reason; a person leaving gives it back', async () => {
    harness = await setup(() => ({ text: 'ok' }), {
      handoff: { request: () => ({ unavailable: 'Our team is offline until 9am.' }) },
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await readUntil(harness, id, settled);
    expect((await post(harness, `/${id}/handoff`, req())).status).toBe(202);
    const read = await get(harness, `/${id}/events`);
    expect(read.body).toMatchObject({ handoff: 'none', responder: 'agent' });
    const events = read.body.events as PoppyEvent[];
    expect(events.slice(-3).map((e) => e.type)).toEqual(['state', 'message', 'state']);
    expect(states(events)).toEqual(['pending/agent', 'none/agent']);
    expect(companyMessages(events).at(-1)?.message.text).toBe('Our team is offline until 9am.');

    const joined = await setup(() => ({ text: 'back to the agent' }), {
      handoff: { request: () => 'joined' },
    });
    const id2 = (await post(joined, '', msg('hi'))).body.conversation_id;
    await readUntil(joined, id2, settled);
    await post(joined, `/${id2}/handoff`, req());
    expect((await get(joined, `/${id2}/events`)).body.responder).toBe('human');
    await joined.conversations.humanLeft(id2);
    await post(joined, `/${id2}/messages`, msg('still there?'));
    const later = await readUntil(joined, id2, (e) => companyMessages(e).length === 2);
    expect(companyMessages(later.events).at(-1)?.message.text).toBe('back to the agent');
    await joined.close();
  });

  it('a cancel withdraws a pending handoff, unless the withdraw hook keeps looking', async () => {
    let keep = false;
    const withdrawn: string[] = [];
    harness = await setup(() => ({ text: 'ok' }), {
      handoff: {
        request: () => 'queued',
        withdraw: ({ conversationId }) => {
          withdrawn.push(conversationId);
          return !keep;
        },
      },
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await readUntil(harness, id, settled);
    // A cancel when nothing is pending changes nothing.
    expect((await post(harness, `/${id}/handoff/cancel`, req())).status).toBe(202);
    expect(withdrawn).toEqual([]);

    await post(harness, `/${id}/handoff`, req());
    const cancel = await post(harness, `/${id}/handoff/cancel`, req());
    expect(cancel.status).toBe(202);
    expect(cancel.body).toEqual({ conversation_id: id });
    expect(withdrawn).toEqual([id]);
    expect((await get(harness, `/${id}/events`)).body.handoff).toBe('none');

    keep = true;
    await post(harness, `/${id}/handoff`, req());
    await post(harness, `/${id}/handoff/cancel`, req());
    expect((await get(harness, `/${id}/events`)).body.handoff).toBe('pending');
    const events = (await get(harness, `/${id}/events`)).body.events as PoppyEvent[];
    expect(states(events)).toEqual(['pending/agent', 'none/agent', 'pending/agent']);
  });

  it('handoff requests and cancels are acted on in the order they are accepted', async () => {
    const order: string[] = [];
    harness = await setup(() => ({ text: 'ok' }), {
      handoff: {
        request: async () => {
          order.push('request:start');
          await sleep(80);
          order.push('request:end');
          return 'queued' as const;
        },
        withdraw: () => {
          order.push('withdraw');
        },
      },
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await readUntil(harness, id, settled);
    const handoff = post(harness, `/${id}/handoff`, req());
    await sleep(20);
    await post(harness, `/${id}/handoff/cancel`, req());
    await handoff;
    expect(order).toEqual(['request:start', 'request:end', 'withdraw']);
    expect((await get(harness, `/${id}/events`)).body.handoff).toBe('none');
  });

  it('closed: no more messages, handoffs or cancels (409), events stay readable, a close again is 202', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await readUntil(harness, id, settled);
    const close = req();
    expect((await post(harness, `/${id}/close`, close)).status).toBe(202);
    for (const path of ['messages', 'handoff', 'handoff/cancel']) {
      const res = await post(harness, `/${id}/${path}`, path === 'messages' ? msg('more') : req());
      expect(res.status, path).toBe(409);
      expect(res.body.error).toBe('conversation_closed');
    }
    const read = await get(harness, `/${id}/events`);
    expect(read.body).toMatchObject({ working: false, handoff: 'none', closed: true });
    expect(read.body.events.at(-1)).toMatchObject({ type: 'state', closed: true });
    // A retried close, and a new one: 202, nothing changes.
    expect((await post(harness, `/${id}/close`, close)).status).toBe(202);
    const again = await post(harness, `/${id}/close`, req());
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ conversation_id: id });
    const reread = await get(harness, `/${id}/events`);
    expect(reread.body.events).toHaveLength(read.body.events.length);
  });

  it('a close drops a reply still being written', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness = await setup(async () => {
      await gate;
      return { text: 'too late' };
    });
    const id = (await post(harness, '', msg('hi'))).body.conversation_id;
    await sleep(50);
    expect((await post(harness, `/${id}/close`, req())).status).toBe(202);
    release();
    await sleep(150);
    const read = await get(harness, `/${id}/events`);
    expect(read.body.working).toBe(false);
    expect(companyMessages(read.body.events)).toHaveLength(0);
  });
});

// ── direct conversations ─────────────────────────────────────────────────────

describe('Poppy Direct Conversations (§8.10)', () => {
  it('user_requested, open a Direct Conversation on the same thread, parent blocked, close', async () => {
    const opened: string[] = [];
    const closedHooks: string[] = [];
    harness = await setup((args) => ({ text: `seen ${args.messages.length}` }), {
      direct: {
        opened: ({ conversationId, parentId }) => {
          opened.push(`${parentId}>${conversationId}`);
        },
        closed: ({ conversationId }) => {
          closedHooks.push(conversationId);
        },
      },
    });
    const h = harness;
    const parent = (await post(h, '', msg('exchange the jacket'))).body.conversation_id;
    await readUntil(h, parent, settled);
    const eventId = await h.conversations.requestUser(
      parent,
      'A specialist needs to confirm the exchange.',
    );
    const requested = await get(h, `/${parent}/events`);
    expect(requested.body.events.at(-1)).toMatchObject({
      id: eventId,
      type: 'user_requested',
      reason: 'A specialist needs to confirm the exchange.',
    });
    // The event doesn't change the conversation's state.
    expect(requested.body).toMatchObject({ working: false, handoff: 'none', responder: 'agent' });

    const direct = await post(h, '', {
      id: rid('msg'),
      parent_conversation_id: parent,
      message: { author: { type: 'human' }, text: 'Hi, I have a question.' },
    });
    expect(direct.status).toBe(201);
    const directId = direct.body.conversation_id;
    expect(directId).not.toBe(parent);
    expect(opened).toEqual([`${parent}>${directId}`]);
    const parentEvents = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(parentEvents.at(-1)).toMatchObject({ type: 'direct_opened', conversation_id: directId });

    // The Direct Conversation answers in the parent's thread: the model sees the earlier history.
    await readUntil(h, directId, settled);
    const directCall = h.agent?.model.calls.at(-1);
    expect(JSON.stringify(directCall?.messages)).toContain('exchange the jacket');
    expect((await h.store.getConversation(directId))?.threadId).toBe(
      (await h.store.getConversation(parent))?.threadId,
    );

    for (const [path, body] of [
      [`/${parent}/messages`, msg('meanwhile')],
      [`/${parent}/handoff`, req()],
      [`/${parent}/handoff/cancel`, req()],
    ] as const) {
      const res = await post(h, path, body);
      expect(res.status, path).toBe(409);
      expect(res.body).toMatchObject({
        error: 'direct_conversation_open',
        conversation_id: directId,
      });
    }
    const second = await post(h, '', { parent_conversation_id: parent, ...msg('another') });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('direct_conversation_open');
    // A Direct Conversation can't be a parent.
    const nested = await post(h, '', { parent_conversation_id: directId, ...msg('nested') });
    expect(nested.status).toBe(400);
    expect(nested.body.error).toBe('invalid_request');
    // The parent can still be read.
    expect((await get(h, `/${parent}/events`)).status).toBe(200);

    expect((await post(h, `/${directId}/close`, req())).status).toBe(202);
    expect(closedHooks).toEqual([directId]);
    const afterClose = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(afterClose.at(-1)).toMatchObject({ type: 'direct_closed', conversation_id: directId });
    expect((await post(h, `/${parent}/messages`, msg('back here'))).status).toBe(202);
  });

  it('accepting user_requested without a message: the Company speaks first; the same acceptance returns the same conversation', async () => {
    harness = await setup((args) => ({
      text: JSON.stringify(args.messages).includes('A specialist needs')
        ? 'Hello, I am the specialist.'
        : 'ok',
    }));
    const h = harness;
    const parent = (await post(h, '', msg('exchange the jacket'))).body.conversation_id;
    await readUntil(h, parent, settled);
    const eventId = await h.conversations.requestUser(parent, 'A specialist needs to confirm.');

    // Not a user_requested event of that parent: invalid_request.
    const parentMessage = (await get(h, `/${parent}/events`)).body.events[0].id;
    for (const bad of [parentMessage, 'evt_nope']) {
      const res = await post(h, '', {
        id: rid('dir'),
        parent_conversation_id: parent,
        user_requested_event_id: bad,
      });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    // Without both IDs a message is required.
    expect((await post(h, '', { id: rid('dir'), parent_conversation_id: parent })).status).toBe(
      400,
    );

    const accept = {
      id: rid('dir'),
      parent_conversation_id: parent,
      user_requested_event_id: eventId,
    };
    const res = await fetch(`${h.url}/poppy/conversations?wait=3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...U1 },
      body: JSON.stringify(accept),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const directId = body.conversation_id;
    // Held until the Company's first message.
    expect(body.events.map((e: PoppyEvent) => e.type)).toEqual(['message']);
    expect(body.events[0].message).toMatchObject({
      role: 'company',
      author: { type: 'agent' },
      text: 'Hello, I am the specialist.',
    });
    expect(body.events[0].message).not.toHaveProperty('as_of_request');
    await readUntil(h, directId, (_e, last) => last.working === false);

    // The same parent and event, even with another request ID and after it closes: the same one.
    const again = await post(h, '', { ...accept, id: rid('dir') });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ conversation_id: directId });
    await post(h, `/${directId}/close`, req());
    const afterClose = await post(h, '', { ...accept, id: rid('dir') });
    expect(afterClose.body).toEqual({ conversation_id: directId });
    const messages = companyMessages((await get(h, `/${directId}/events`)).body.events);
    expect(messages).toHaveLength(1);
    // Another User cannot claim it.
    const other = await post(h, '', { ...accept, id: rid('dir') }, auth('u2||out'));
    expect(other.status).toBe(404);
  });

  it('unknown or closed parents; closing the parent closes its Direct Conversation', async () => {
    harness = await setup(() => ({ text: 'ok' }));
    const h = harness;
    const unknown = await post(h, '', { parent_conversation_id: 'cnv_nope', ...msg('x') });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('conversation_not_found');

    const closedParent = (await post(h, '', msg('a'))).body.conversation_id;
    await post(h, `/${closedParent}/close`, req());
    const onClosed = await post(h, '', { parent_conversation_id: closedParent, ...msg('x') });
    expect(onClosed.status).toBe(409);
    expect(onClosed.body.error).toBe('conversation_closed');

    const parent = (await post(h, '', msg('b'))).body.conversation_id;
    const directId = (await post(h, '', { parent_conversation_id: parent, ...msg('c') })).body
      .conversation_id;
    await post(h, `/${parent}/close`, req());
    const direct = await get(h, `/${directId}/events`);
    expect(direct.body.closed).toBe(true);
    const parentEvents = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(parentEvents.slice(-2).map((e) => e.type)).toEqual(['direct_closed', 'state']);
  });

  it('in a Direct Conversation, an authorization event is also asked in a message', async () => {
    const agent = buildAgent((_a, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'list_orders', input: {} } } : { text: '' },
    );
    agent.registry.register(
      {
        name: 'list_orders',
        kind: 'read',
        description: 'x',
        inputSchema: z.object({}),
        roles: ['scope:poppy:read'],
      },
      { execute: async () => ({}) },
    );
    harness = await serve({
      service: agent.service,
      toolRoles: (name) => agent.registry.spec(name)?.roles,
    });
    const parent = (
      await post(harness, '', { id: 'msg_d0', message: { author: { type: 'agent' }, context: {} } })
    ).body.conversation_id;
    const directId = (
      await post(harness, '', {
        id: 'msg_d1',
        parent_conversation_id: parent,
        message: { author: { type: 'human' }, text: 'my orders?' },
      })
    ).body.conversation_id;
    const { events } = await readUntil(harness, directId, (e) =>
      e.some((x) => x.type === 'authorization'),
    );
    await readUntil(harness, directId, settled);
    const all = (await get(harness, `/${directId}/events`)).body.events as PoppyEvent[];
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'insufficient_scope',
    });
    expect(companyMessages(all).at(-1)?.message.text).toMatch(/sign in/);
  });
});

// ── durability ───────────────────────────────────────────────────────────────

describe('Poppy durability', () => {
  it('another replica writes the reply of a turn whose writer died — once', async () => {
    const agent = buildAgent(() => ({ text: 'recovered reply' }));
    const store = new InMemoryPoppyStore();
    const { runId, threadId } = await agent.service.chat({
      actor: { id: 'poppy:x', roles: [PERSONAL_AGENT_ROLE] },
      message: 'hi',
      transient: true,
    });
    const now = Date.now();
    await store.createConversation({
      id: 'cnv_orphan',
      clientId: CLIENT,
      userId: 'u1',
      accountRef: null,
      agentName: '',
      threadId,
      parentId: null,
      openDirectId: null,
      working: true,
      handoff: 'none',
      responder: 'agent',
      closed: false,
      context: {},
      protocolVersion: '1.0',
      extensions: {},
      prompt: null,
      activeRunId: runId,
      turnSeq: 1,
      grant: {
        actor: { id: 'poppy:x', roles: [PERSONAL_AGENT_ROLE] },
        scopes: [],
        signedIn: false,
      },
      prunedSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    harness = await serve({ service: agent.service, toolRoles: () => undefined, store });
    const { events } = await readUntil(harness, 'cnv_orphan', settled);
    expect(companyMessages(events).map((e) => e.message.text)).toEqual(['recovered reply']);
    await sleep(100);
    const again = await get(harness, '/cnv_orphan/events');
    expect(companyMessages(again.body.events)).toHaveLength(1);
  });
});

describe('publicOrigin', () => {
  it('prefers baseUrl; else the request, upgraded to https behind a TLS proxy of an https issuer', () => {
    const request = { protocol: 'http', host: 'api.acme.com' };
    expect(publicOrigin(request, 'https://acme.com/')).toBe('https://acme.com');
    expect(publicOrigin(request, undefined, 'https://auth.acme.com')).toBe('https://api.acme.com');
    expect(publicOrigin(request, undefined, undefined)).toBe('http://api.acme.com');
  });
});
