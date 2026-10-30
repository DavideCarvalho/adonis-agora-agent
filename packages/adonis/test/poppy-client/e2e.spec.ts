import { stat } from 'node:fs/promises';
import { afterEach, assert, describe, it, vi } from 'vitest';
import { callOpenApi } from '../../src/poppy-client/api.js';
import {
  authorizeBrowserJoin,
  browserJoinCode,
  browserSessionEndpoint,
} from '../../src/poppy-client/browser.js';
import {
  ConversationClient,
  newMessageId,
  type StreamItem,
} from '../../src/poppy-client/conversations.js';
import { ConversationError, ResourceAuthError } from '../../src/poppy-client/errors.js';
import { waitForRelayedCallback } from '../../src/poppy-client/identity_server.js';
import { ask } from '../../src/poppy-client/llm.js';
import { connectMcp } from '../../src/poppy-client/mcp.js';
import {
  completeDirectSignIn,
  deviceSignIn,
  eligibleSignInTypes,
  mediatedSignIn,
  startDirectSignIn,
  submitMediatedCode,
} from '../../src/poppy-client/signin.js';
import { excludedTasks, sendFeedback } from '../../src/poppy-client/task_coverage.js';
import { rejects } from './fixtures/assert.js';
import type { World } from './fixtures/setup.js';
import { browse, world } from './fixtures/setup.js';

// End-to-end against in-process HTTP servers (keys, DPoP, SSE reconnects): generous under a loaded run.
vi.setConfig({ testTimeout: 20_000 });

let w: World;
const noViolations = (assert: { deepEqual: (a: unknown, b: unknown) => void }) =>
  assert.deepEqual(w.fake.violations, []);

async function directSignIn(scope = 'orders:read orders:write') {
  const c = await w.agent.company(w.fake.domain);
  const pending = await startDirectSignIn(c, scope);
  const back = await browse(pending.url);
  return { c, result: await completeDirectSignIn(c, pending, back.searchParams), pending };
}

async function collect(
  gen: AsyncGenerator<StreamItem>,
  until: (items: StreamItem[]) => boolean,
  ac: AbortController,
) {
  const items: StreamItem[] = [];
  for await (const item of gen) {
    items.push(item);
    if (until(items)) {
      ac.abort();
      break;
    }
  }
  return items;
}

describe('sessions (section 5)', () => {
  afterEach(async () => w.cleanup());

  it('a signed-out request carries only the Session header: delegated key, delegation, sid', async () => {
    w = await world({ requireNonce: true });
    const c = await w.agent.company(w.fake.domain);
    assert.isNull(await c.token());
    assert.match(c.userId, /^usr_/);
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hello: 'world', signed_in: false });
    const sid = c.sessionId;
    await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(c.sessionId, sid);
    assert.equal(w.fake.sessions.size, 1);
    assert.notInclude(
      w.fake.log.join(' '),
      '/oauth/token',
      'a signed-out Session needs nothing from the authorization server',
    );
    const mode = (await stat(w.store.path)).mode & 0o777;
    assert.equal(mode, 0o600);
    noViolations(assert);
  });

  it('invalid_session starts a new Session once, then stops', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await callOpenApi(c, { method: 'GET', path: '/public' });
    const old = c.sessionId;
    [...w.fake.sessions.values()][0]!.ended = true;
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.notEqual(c.sessionId, old);
    assert.isTrue(w.logs.some((l) => l.includes('invalid_session')));
    noViolations(assert);

    const original = w.fake.sessions.set.bind(w.fake.sessions);
    w.fake.sessions.set = ((k: string, v: { ended?: boolean }) => {
      v.ended = true;
      return original(k, v as never);
    }) as never;
    for (const s of w.fake.sessions.values()) s.ended = true;
    await rejects(() => callOpenApi(c, { method: 'GET', path: '/public' }), /invalid_session/);
  });

  it('429 Retry-After is waited out', async () => {
    w = await world({ rateLimitOnce: true });
    const c = await w.agent.company(w.fake.domain);
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.isTrue(w.logs.some((l) => l.includes('Retry-After')));
  });

  it('a Company without an issuer offers only signed-out Sessions, named by its domain', async () => {
    w = await world({ noIssuer: true });
    const c = await w.agent.company(w.fake.domain);
    assert.equal(c.issuer, w.fake.origin);
    assert.isUndefined(c.discovered.metadata);
    assert.deepEqual(eligibleSignInTypes(c, 'orders:read'), []);
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    noViolations(assert);
  });
});

describe('sign-in (section 4)', () => {
  afterEach(async () => w.cleanup());

  it('Direct Sign-In: PKCE, state, iss; then signed-in API calls', async () => {
    w = await world();
    const { c, result } = await directSignIn();
    assert.equal(result.grantedScope, 'orders:read orders:write');
    assert.isNotNull(await c.token());
    assert.equal(w.callbacks.length, 1);
    const r = await callOpenApi(c, { method: 'GET', path: '/orders' });
    assert.equal(r.status, 200);
    noViolations(assert);
  });

  it('Direct Sign-In callback relay through the state dir', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const pending = await startDirectSignIn(c, 'orders:read');
    const waiting = waitForRelayedCallback(w.dir, pending.state, { pollMs: 20 });
    await browse(pending.url);
    const params = await waiting;
    await completeDirectSignIn(c, pending, params);
    assert.isNotNull(await c.token());
  });

  it('Direct Sign-In rejects a wrong iss, a wrong state, and access_denied', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const pending = await startDirectSignIn(c, 'orders:read');
    const back = await browse(pending.url);
    const swapped = new URLSearchParams(back.searchParams);
    swapped.set('iss', 'https://other.example');
    await rejects(() => completeDirectSignIn(c, pending, swapped), /iss/);
    const badState = new URLSearchParams(back.searchParams);
    badState.set('state', 'x'.repeat(22));
    await rejects(() => completeDirectSignIn(c, pending, badState), /state/);
    const denied = await browse(`${pending.url}&login_hint=deny`);
    await rejects(() => completeDirectSignIn(c, pending, denied.searchParams), /access_denied/);
  });

  it('scopes are checked against the sign-in type', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    assert.deepEqual(eligibleSignInTypes(c, 'orders:read'), ['direct', 'device', 'mediated']);
    assert.deepEqual(eligibleSignInTypes(c, 'addresses'), ['direct', 'device']);
    await rejects(() => mediatedSignIn(c, 'orders:write', {}), /can't grant/);
  });

  it('Device Sign-In polls through authorization_pending and slow_down', async () => {
    w = await world({ devicePendingPolls: 2 });
    const c = await w.agent.company(w.fake.domain);
    const sleeps: number[] = [];
    const polls: string[] = [];
    let shown = '';
    const r = await deviceSignIn(c, 'orders:read', {
      display: (i) => {
        shown = i.userCode;
        assert.equal(i.organization.name, 'Fake Co');
      },
      sleep: async (ms) => void sleeps.push(ms),
      onPoll: (s) => polls.push(s),
    });
    assert.equal(shown, 'WDJB-MJHT');
    assert.deepEqual(polls, ['authorization_pending', 'authorization_pending', 'slow_down']);
    assert.deepEqual(sleeps, [1000, 1000, 1000, 6000]);
    assert.equal(r.grantedScope, 'orders:read');
    noViolations(assert);
  });

  it('a device link on a foreign host is never shown', async () => {
    w = await world({ devicePendingPolls: 0 });
    const c = await w.agent.company(w.fake.domain);
    const real = c.tokens.deviceAuthorization.bind(c.tokens);
    c.tokens.deviceAuthorization = async (scope) => ({
      ...(await real(scope)),
      verification_uri: 'http://evil.example/device',
    });
    let shown = false;
    await rejects(
      () =>
        deviceSignIn(c, 'orders:read', {
          display: () => {
            shown = true;
          },
          sleep: async () => {},
        }),
      /isn't this Company's/,
    );
    assert.isFalse(shown);
  });

  it('Mediated Sign-In with a one-time code', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const failed = await mediatedSignIn(c, 'orders:read', {
      email: 'dana@example.com',
      password: 'wrong',
    });
    assert.equal(failed.status, 'failed');
    const first = await mediatedSignIn(c, 'orders:read', {
      email: 'dana@example.com',
      password: 'hunter2',
    });
    assert.equal(first.status, 'code_required');
    if (first.status !== 'code_required') return;
    assert.equal(first.sentTo, 'Text to the phone number ending in 71');
    const wrong = await submitMediatedCode(c, 'orders:read', first.signInId, '000000');
    assert.equal(wrong.status, 'code_required');
    const done = await submitMediatedCode(c, 'orders:read', first.signInId, '123456');
    assert.equal(done.status, 'complete');
    assert.isNotNull(await c.token());
    assert.notInclude(JSON.stringify(w.logs), 'hunter2');
    noViolations(assert);
  });

  it('a refresh token serves a new Session too; rotation is honoured; narrower scope works', async () => {
    w = await world({ rotateAccountToken: true, accessTtl: 1 });
    const { c } = await directSignIn();
    const first = c.state.accountToken!.refreshToken;
    await c.newSession();
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
    assert.notEqual(c.state.accountToken!.refreshToken, first);
    const narrow = await c.token({ scope: 'orders:read' });
    assert.equal(narrow?.scope, 'orders:read');
    noViolations(assert);
  });

  it('a refresh response without refresh_token keeps the one we have', async () => {
    w = await world();
    const { c } = await directSignIn();
    const first = c.state.accountToken!.refreshToken;
    const t = await c.token({ forceRenew: true });
    assert.isNotNull(t);
    assert.equal(c.state.accountToken!.refreshToken, first);
  });

  it('a challenge without a code is insufficient_scope; so is a token without the scope', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    try {
      await callOpenApi(c, { method: 'POST', path: '/addresses', body: {} });
      assert.fail('expected a challenge');
    } catch (e) {
      assert.instanceOf(e, ResourceAuthError);
      assert.equal((e as ResourceAuthError).code, 'insufficient_scope');
      assert.equal((e as ResourceAuthError).status, 401);
      assert.equal((e as ResourceAuthError).scope, 'addresses');
    }
    await directSignIn('orders:read');
    try {
      await callOpenApi(c, { method: 'POST', path: '/addresses', body: {} });
      assert.fail('expected insufficient_scope');
    } catch (e) {
      assert.instanceOf(e, ResourceAuthError);
      assert.equal((e as ResourceAuthError).scope, 'addresses');
    }
  });

  it('disconnect revokes the refresh token and the Session continues signed out', async () => {
    w = await world();
    const { c } = await directSignIn();
    const sid = c.sessionId;
    assert.isTrue(await c.signOut());
    assert.isNull(await c.token());
    assert.equal(c.sessionId, sid);
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/public' })).status, 200);
    noViolations(assert);
  });

  it('a revoked refresh token: invalid_token, invalid_grant, then signed out', async () => {
    w = await world();
    const { c } = await directSignIn();
    w.fake.revokeAtCompany();
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hello: 'world', signed_in: false });
    assert.isUndefined(c.state.accountToken);
    noViolations(assert);
  });

  it('a new sign-in revokes the refresh token it replaces', async () => {
    w = await world();
    await directSignIn('orders:read');
    const old = [...w.fake.accountTokens.values()][0];
    const { c } = await directSignIn('orders:read orders:write');
    assert.isTrue(old?.revoked);
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
  });

  it("DPoP is the Company's choice: without it in the metadata, plain Bearer and no proof", async () => {
    w = await world({ noDpop: true });
    const { c } = await directSignIn();
    assert.equal(c.state.tokens.default?.tokenType, 'Bearer');
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
    noViolations(assert);
  });

  it('with DPoP in the metadata: a bound token, its proof, and a nonce retry', async () => {
    w = await world({ requireNonce: true });
    const { c } = await directSignIn();
    assert.equal(c.state.tokens.default?.tokenType, 'DPoP');
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
    assert.isTrue(w.fake.log.includes('oauth error use_dpop_nonce'));
    noViolations(assert);
  });

  it('a service with its own tokens: resource from its protected resource metadata', async () => {
    w = await world({ apiResource: true, noDpop: true });
    const { c } = await directSignIn();
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
    const own = Object.values(c.state.tokens).find((t) => t.resource === `${w.fake.origin}/api`);
    assert.isDefined(own);
    noViolations(assert);
  });
});

describe('APIs (7)', () => {
  afterEach(async () => w.cleanup());

  it('MCP over streamable HTTP: Session header, and a Bearer token issued for its url', async () => {
    w = await world();
    const { c } = await directSignIn('orders:read');
    const mcp = await connectMcp(c);
    const { tools } = await mcp.client.listTools();
    assert.includeMembers(
      tools.map((t) => t.name),
      ['whoami', 'search_products', 'place_order'],
    );
    const r = await mcp.client.callTool({ name: 'whoami', arguments: {} });
    assert.include(JSON.stringify(r.content), 'signed_in');
    // A tool behind a scope the session lacks: 403 insufficient_scope → ResourceAuthError + scope.
    const refused = await mcp.client
      .callTool({ name: 'place_order', arguments: { sku: 'x' } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.instanceOf(refused, ResourceAuthError);
    assert.equal((refused as ResourceAuthError).code, 'insufficient_scope');
    assert.equal((refused as ResourceAuthError).scope, 'orders:write');
    await mcp.close();
    const bearer = Object.values(c.state.tokens).find((t) => t.tokenType === 'Bearer');
    assert.equal(bearer?.resource, w.fake.mcpUrl);
    noViolations(assert);
  });

  it('signed out, MCP takes only the Session header; a tool that needs the account challenges', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const mcp = await connectMcp(c);
    const r = await mcp.client.callTool({ name: 'search_products', arguments: { query: 'boots' } });
    assert.include(JSON.stringify(r.content), 'insulated boots');
    const refused = await mcp.client
      .callTool({ name: 'place_order', arguments: { sku: 'x' } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.equal((refused as ResourceAuthError).code, 'insufficient_scope');
    assert.equal((refused as ResourceAuthError).status, 401);
    await mcp.close();
    noViolations(assert);
  });

  it('refuses to send the token to a foreign origin', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await rejects(
      () => callOpenApi(c, { method: 'GET', path: 'https://evil.example/steal' }),
      /refusing/,
    );
  });
});

describe('conversations (7)', () => {
  afterEach(async () => w.cleanup());

  it('SSE: deltas, final message, state events, Last-Event-ID resume', async () => {
    w = await world({ dropStreamAfterFirstMessage: true });
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const start = await conv.start({
      id: newMessageId(),
      author: { type: 'agent' },
      text: 'hello',
      context: { locale: 'en-US', time_zone: 'America/Los_Angeles', user_available: true },
    });
    assert.match(start.conversation_id, /^cnv_/);
    const ac = new AbortController();
    const firstReply = (items: StreamItem[]) =>
      items.filter(
        (i) =>
          i.kind === 'event' && i.event.type === 'message' && i.event.message?.role === 'company',
      ).length >= 2;
    const pending = collect(
      conv.follow(start.conversation_id, { signal: ac.signal }),
      firstReply,
      ac,
    );
    await new Promise((r) => setTimeout(r, 100));
    await conv.send(start.conversation_id, {
      id: newMessageId(),
      author: { type: 'agent' },
      text: 'second',
      data: { n: 2 },
    });
    const items = await pending;
    const kinds = items.map((i) => i.kind);
    assert.include(kinds, 'reconnected');
    const messages = items.flatMap((i) =>
      i.kind === 'event' && i.event.type === 'message' ? [i.event] : [],
    );
    assert.equal(
      messages.filter((m) => m.message?.role === 'company')[0]?.message?.text,
      'You said: hello',
    );
    assert.isTrue(items.some((i) => i.kind === 'event' && i.event.type === 'state'));
    const ids = items.flatMap((i) => (i.kind === 'event' ? [i.event.id] : []));
    assert.equal(new Set(ids).size, ids.length, 'no event handled twice');
    assert.isAbove(w.fake.lastEventIdHeaders.length, 0);
    noViolations(assert);
  });

  it('a stream that connects after the reply (dropped after it) resumes with Last-Event-ID', async () => {
    w = await world({ dropStreamAfterFirstMessage: true });
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const start = await conv.start({
      id: newMessageId(),
      author: { type: 'agent' },
      text: 'hello',
    });
    await new Promise((r) => setTimeout(r, 150)); // the reply is already in the backlog
    const ac = new AbortController();
    const items = await collect(
      conv.follow(start.conversation_id, { signal: ac.signal }),
      (seen) => seen.some((i) => i.kind === 'reconnected'),
      ac,
    );
    assert.isTrue(
      items.some((i) => i.kind === 'event' && i.event.message?.text === 'You said: hello'),
    );
  });

  it('long-poll reads, idempotent retries, message_id_conflict, handoff, close', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const m = { id: newMessageId(), author: { type: 'agent' } as const, text: 'hi' };
    const a = await conv.start(m);
    const b = await conv.start(m);
    assert.equal(b.conversation_id, a.conversation_id);
    await rejects(() => conv.start({ ...m, text: 'different' }), /message_id_conflict/);
    const { events, state } = await conv.collect(a.conversation_id);
    assert.equal(state.status, 'idle');
    assert.isTrue(events.some((e) => e.message?.text === 'You said: hi'));
    const h = await conv.handoff(a.conversation_id);
    assert.equal(h.status, 'queued');
    await new Promise((r) => setTimeout(r, 80));
    const after = await conv.collect(a.conversation_id);
    assert.equal(after.state.responder, 'human');
    const closed = await conv.close(a.conversation_id);
    assert.equal(closed.status, 'closed');
    try {
      await conv.send(a.conversation_id, {
        id: newMessageId(),
        author: { type: 'agent' },
        text: 'more',
      });
      assert.fail('expected conversation_closed');
    } catch (e) {
      assert.instanceOf(e, ConversationError);
      assert.equal((e as ConversationError).code, 'conversation_closed');
    }
    noViolations(assert);
  });

  it('follow(untilSettled) on an already settled conversation returns instead of waiting', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const a = await conv.start({ id: newMessageId(), author: { type: 'agent' }, text: 'hi' });
    await conv.collect(a.conversation_id);
    // Nothing changes the state now (like a handoff with no one available): no `state` event.
    const drained = (async () => {
      const items = [];
      for await (const item of conv.follow(a.conversation_id, { untilSettled: true })) {
        items.push(item);
      }
      return items;
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve('hung'), 2000));
    assert.notEqual(await Promise.race([drained, timeout]), 'hung');
    noViolations(assert);
  });

  it('authorization event, sign in, continue the same conversation', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id: id } = await conv.start({
      id: newMessageId(),
      author: { type: 'agent' },
      text: 'show my orders',
    });
    const first = await conv.collect(id);
    const auth = first.events.find((e) => e.type === 'authorization');
    assert.equal(auth?.error, 'insufficient_scope');
    assert.equal(auth?.scope, 'orders:read');
    await directSignIn('orders:read');
    await conv.send(id, { id: newMessageId(), author: { type: 'agent' }, text: 'orders please' });
    const second = await conv.collect(id);
    const reply = second.events.find((e) => e.type === 'message' && e.message?.role === 'company');
    assert.deepEqual(reply?.message?.data, { orders: [{ id: 'ord_1042', item: 'jacket' }] });
    noViolations(assert);
  });

  it('user_requested → Direct Conversation with parent, direct_opened/closed', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id: parent } = await conv.start({
      id: newMessageId(),
      author: { type: 'agent' },
      text: 'need a specialist',
    });
    const r = await conv.collect(parent);
    assert.isTrue(r.events.some((e) => e.type === 'user_requested'));
    const direct = await conv.start(
      { id: newMessageId(), author: { type: 'human' }, text: 'Hi, it is me' },
      { parentConversationId: parent },
    );
    await rejects(
      () => conv.send(parent, { id: newMessageId(), author: { type: 'agent' }, text: 'x' }),
      /direct_conversation_open/,
    );
    await conv.close(direct.conversation_id);
    const after = await conv.collect(parent);
    const types = after.events.map((e) => e.type);
    assert.includeMembers(types, ['direct_opened', 'direct_closed']);
    noViolations(assert);
  });
});

describe('web browsing (6)', () => {
  afterEach(async () => w.cleanup());

  /** Plays the agent's own browser. */
  async function loadPage(endpoint: string) {
    const res = await fetch(endpoint);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { html: await res.text(), cookie };
  }
  const submit = (endpoint: string, code: string, cookie: string) =>
    fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ code }).toString(),
    });

  it('the three steps: page, authorize with the access token, submit with the cookie', async () => {
    w = await world();
    const { c } = await directSignIn();
    const endpoint = browserSessionEndpoint(c);
    const { html, cookie } = await loadPage(endpoint);
    const code = browserJoinCode(html);
    await authorizeBrowserJoin(c, code);
    const res = await submit(endpoint, code, cookie);
    assert.equal(res.status, 303);
    assert.deepEqual(w.fake.browserJoins, [{ sessionId: c.sessionId, account: 'acct_1' }]);
    // The code works once.
    assert.equal((await submit(endpoint, code, cookie)).status, 400);
    await rejects(() => authorizeBrowserJoin(c, code), /invalid_request/);
    noViolations(assert);
  });

  it('a signed-out join, and a browser without the cookie is refused', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const endpoint = browserSessionEndpoint(c);
    const page = await loadPage(endpoint);
    const code = browserJoinCode(page.html);
    await authorizeBrowserJoin(c, code);
    assert.equal((await submit(endpoint, code, '')).status, 400);
    const again = await loadPage(endpoint);
    const second = browserJoinCode(again.html);
    await authorizeBrowserJoin(c, second);
    assert.equal((await submit(endpoint, second, again.cookie)).status, 303);
    assert.deepEqual(w.fake.browserJoins, [{ sessionId: c.sessionId, account: undefined }]);
    assert.throws(() => browserJoinCode('<form></form>'), /no code field/);
    noViolations(assert);
  });
});

describe('task coverage (9)', () => {
  afterEach(async () => w.cleanup());

  it('excluded tasks: public, and references to unlisted APIs or unknown types are dropped', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const tasks = await excludedTasks(c);
    assert.deepEqual(
      tasks.map((t) => t.task),
      ['Send a wire transfer', 'Close an account'],
    );
    assert.deepEqual(tasks[0]?.alternative?.references, [
      { type: 'web', url: `${w.fake.origin}/wire` },
    ]);
  });

  it('feedback: 202 without a body, or 200 with an alternative', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const report = { task: 'Pay with a gift card', description: 'No way to apply one.' };
    assert.isNull(await sendFeedback(c, report));
    w.fake.feedbackAlternative = { instructions: 'Apply it at checkout.' };
    assert.equal((await sendFeedback(c, report))?.instructions, 'Apply it at checkout.');
    assert.deepEqual(w.fake.feedback[0], report);
    noViolations(assert);
  });
});

describe('LLM mode', () => {
  afterEach(async () => w.cleanup());

  it('ask: scripted model talks to the company and uses MCP; writes need consent', async () => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const script = [
      {
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'mcp_search_products', arguments: '{"query":"jacket"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '2',
            type: 'function',
            function: { name: 'mcp_place_order', arguments: '{"sku":"x"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '3',
            type: 'function',
            function: { name: 'talk_to_company', arguments: '{"text":"Is it warm?"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '4',
            type: 'function',
            function: { name: 'finish', arguments: '{"answer":"Yes, size M for $70."}' },
          },
        ],
      },
    ];
    const requests: any[] = [];
    const transcript: string[] = [];
    const r = await ask(c, 'find a warm jacket', {
      apiKey: 'test',
      baseUrl: 'http://llm.invalid/chat',
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const msg = script.shift()!;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...msg } }] }),
        );
      },
      log: (l) => transcript.push(l),
    });
    assert.equal(r.answer, 'Yes, size M for $70.');
    assert.equal(r.steps, 4);
    const toolMsgs = requests[3].messages
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => m.content);
    assert.include(toolMsgs[0], 'insulated jacket');
    assert.include(toolMsgs[1], 'refused');
    assert.include(toolMsgs[2], 'You said: Is it warm?');
    const all = JSON.stringify(requests);
    for (const t of Object.values(c.state.tokens)) assert.notInclude(all, t.accessToken);
    assert.isTrue(w.fake.conversations.get(r.conversationId!)?.status === 'closed');
    noViolations(assert);
  });
});
