import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { A2aAuth, A2aCaller } from '../src/a2a/auth.js';
import { personalAgentGate } from '../src/a2a/gate.js';
import { type A2aBrand, createA2aHandler, personalAgentActorId } from '../src/a2a/handler.js';
import {
  PERSONAL_AGENT_ROLE,
  REQUEST_PERMISSION_TOOL,
  registerRequestPermissionTool,
} from '../src/a2a/permission-tool.js';
import { A2aError, parseSendMessage } from '../src/a2a/protocol.js';
import { InMemoryA2aStore } from '../src/a2a/store.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  ToolRegistry,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript, InMemoryAgentStore } from '../src/testing/index.js';

// ── fakes ──────────────────────────────────────────────────────────────────────

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeCtx(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
) {
  const sent: Sent = { status: 200, headers: {}, body: '' };
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
  const ctx = {
    request: {
      url: () => url.split('?')[0],
      method: () => method,
      header: (name: string) => headers[name.toLowerCase()],
      qs: () => query,
      protocol: () => 'https',
      host: () => 'brand.example',
      request: Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body)]),
    },
    response: {
      status(code: number) {
        sent.status = code;
        return this;
      },
      header(name: string, value: string) {
        sent.headers[name.toLowerCase()] = value;
        return this;
      },
      send(body: string) {
        sent.body = body;
      },
    },
  };
  return { ctx: ctx as never, sent, json: () => JSON.parse(sent.body) };
}

/** `Bearer user|<sub>` or `Bearer deleg|<sub>|<account>|<scope,scope>` — anything else is a 401. */
const fakeAuth: A2aAuth = {
  async authenticate(ctx: any): Promise<A2aCaller | null> {
    const header: string | undefined = ctx.request.header('authorization');
    const [kind, sub, account, scopes] = (header?.replace(/^Bearer /, '') ?? '').split('|');
    if (kind === 'user' && sub) {
      return { issuer: 'https://pa.example', sub, name: 'PA', delegation: null };
    }
    if (kind === 'deleg' && sub && account) {
      return {
        issuer: 'https://pa.example',
        sub,
        name: 'PA',
        delegation: { accountId: account, scopes: scopes ? scopes.split(',') : [], grantId: 'g1' },
      };
    }
    ctx.response.header('WWW-Authenticate', 'Bearer realm="a2a"');
    ctx.response.status(401).send('');
    return null;
  },
  async cardSecurity(_ctx, interfaceUrl) {
    return { securitySchemes: { paJwt: { interfaceUrl } } };
  },
  async stepUp(_ctx, missingScopes) {
    return { 'pact.missingScopes': missingScopes, 'pact.verificationUriComplete': 'https://c' };
  },
  async receipt(_ctx, input) {
    return { 'pact.receipt': input };
  },
  async delegableScopes() {
    return { 'orders:read': 'See orders', 'orders:cancel': 'Cancel orders' };
  },
};

function buildAgent(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const sink = new InProcessTokenStreamSink();
  const registry = new ToolRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: personalAgentGate(new DefaultToolAuthorizer()),
    registry,
    agents: new AgentRegistry(),
  });
  const service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
  return { service, registry, store };
}

const brands = new Map<string, A2aBrand>([
  ['support', { id: 'support', agentName: 'default', card: { name: 'Acme', description: 'Help' } }],
  [
    'sales',
    { id: 'sales', agentName: 'default', card: { name: 'Acme Sales', description: 'Buy' } },
  ],
]);

function handlerFor(
  script: FakeScript,
  actions: 'approve-delegated' | 'reject' = 'approve-delegated',
) {
  const agent = buildAgent(script);
  const store = new InMemoryA2aStore();
  const handle = createA2aHandler({
    path: 'a2a',
    baseUrl: 'https://brand.example',
    brands,
    rootCardBrand: 'support',
    auth: fakeAuth,
    store,
    service: agent.service,
    registry: agent.registry,
    actions,
    timeoutMs: 5_000,
    maxBodyBytes: 64 * 1024,
  });
  return { handle, ...agent, a2aStore: store };
}

function send(text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra },
  });
}

async function call(
  handle: ReturnType<typeof createA2aHandler>,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
) {
  const c = makeCtx(method, url, opts);
  const handled = await handle(c.ctx);
  return { handled, ...c };
}

// ── protocol ───────────────────────────────────────────────────────────────────

describe('parseSendMessage (PACT §4.1)', () => {
  const reason = (raw: string) => {
    try {
      parseSendMessage(raw);
      return 'ok';
    } catch (error) {
      return (error as A2aError).reason;
    }
  };

  it('accepts a text message and joins its text parts', () => {
    expect(parseSendMessage(send('hi', { contextId: 'c1' }))).toMatchObject({
      text: 'hi',
      contextId: 'c1',
    });
  });

  it('maps every malformed shape to its A2A reason', () => {
    expect(reason('{')).toBe('INVALID_PARAMS');
    expect(reason(send('hi', { taskId: 't' }))).toBe('TASK_NOT_FOUND');
    expect(reason(send('hi', { role: 'ROLE_AGENT' }))).toBe('INVALID_PARAMS');
    expect(reason(send('   '))).toBe('INVALID_PARAMS');
    expect(reason(send('', { parts: [{ raw: 'aGk=' }] }))).toBe('CONTENT_TYPE_NOT_SUPPORTED');
    expect(reason(send('hi', { parts: [] }))).toBe('INVALID_PARAMS');
    expect(reason(JSON.stringify({ message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } }))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('builds the AIP-193 envelope', () => {
    expect(new A2aError('TASK_NOT_FOUND', 'Task not found: t').toJSON()).toEqual({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        message: 'Task not found: t',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'TASK_NOT_FOUND',
            domain: 'a2a-protocol.org',
          },
        ],
      },
    });
  });
});

// ── routing ────────────────────────────────────────────────────────────────────

describe('A2A routing (PACT §2)', () => {
  let h: ReturnType<typeof handlerFor>;
  beforeEach(() => {
    h = handlerFor(() => ({ text: 'hello' }));
  });
  const auth = { authorization: 'Bearer user|u1' };

  it('leaves non-A2A paths alone', async () => {
    expect((await call(h.handle, 'GET', '/dashboard')).handled).toBe(false);
  });

  it('serves the Agent Card per brand, and at the root for the configured one', async () => {
    const card = await call(h.handle, 'GET', '/a2a/support/.well-known/agent-card.json');
    expect(card.json()).toMatchObject({
      name: 'Acme',
      description: 'Help',
      supportedInterfaces: [
        {
          url: 'https://brand.example/a2a/support',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
        },
      ],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { paJwt: { interfaceUrl: 'https://brand.example/a2a/support' } },
      skills: [],
    });
    const root = await call(h.handle, 'GET', '/.well-known/agent-card.json');
    expect(root.json().name).toBe('Acme');
  });

  it('unknown brand and unmatched routes: bare 404/405, before auth', async () => {
    const unknown = await call(h.handle, 'GET', '/a2a/nope/.well-known/agent-card.json');
    expect(unknown.sent.status).toBe(404);
    expect(unknown.sent.headers['content-type']).not.toBe('application/a2a+json');
    for (const [method, url, status] of [
      ['GET', '/a2a/support/unknown', 404],
      ['GET', '/a2a/support/message:send', 405],
      ['PUT', '/a2a/support/message:send', 405],
      ['POST', '/a2a/support/tasks', 405],
      ['DELETE', '/a2a/support/tasks/t1/pushNotificationConfigs', 405],
      ['POST', '/a2a/support/tasks/t1/pushNotificationConfigs/c1', 405],
    ] as const) {
      const res = await call(h.handle, method, url);
      expect(res.sent.status, `${method} ${url}`).toBe(status);
      expect(res.sent.headers['content-type']).not.toBe('application/a2a+json');
    }
  });

  it('401 before the body is read', async () => {
    const res = await call(h.handle, 'POST', '/a2a/support/message:send', { body: '{' });
    expect(res.sent.status).toBe(401);
    expect(res.sent.headers['www-authenticate']).toBe('Bearer realm="a2a"');
  });

  it('tasks: empty list with pageSize, task lookups and unsupported operations', async () => {
    const list = await call(h.handle, 'GET', '/a2a/support/tasks?pageSize=20', { headers: auth });
    expect(list.json()).toEqual({ tasks: [], nextPageToken: '', pageSize: 20, totalSize: 0 });
    expect(list.sent.headers['content-type']).toBe('application/a2a+json');
    expect(
      (await call(h.handle, 'GET', '/a2a/support/tasks', { headers: auth })).json().pageSize,
    ).toBe(50);
    const bad = await call(h.handle, 'GET', '/a2a/support/tasks?pageSize=0', { headers: auth });
    expect(bad.json().error.details[0].reason).toBe('INVALID_PARAMS');

    const task = await call(h.handle, 'GET', '/a2a/support/tasks/t9', { headers: auth });
    expect(task.sent.status).toBe(404);
    expect(task.json().error).toMatchObject({ message: 'Task not found: t9', status: 'NOT_FOUND' });
    const cancel = await call(h.handle, 'POST', '/a2a/support/tasks/t9:cancel', { headers: auth });
    expect(cancel.json().error.message).toBe('Task not found: t9');

    for (const [method, url, reason] of [
      ['POST', '/a2a/support/message:stream', 'UNSUPPORTED_OPERATION'],
      ['POST', '/a2a/support/tasks/t9:subscribe', 'UNSUPPORTED_OPERATION'],
      ['GET', '/a2a/support/extendedAgentCard', 'UNSUPPORTED_OPERATION'],
      ['GET', '/a2a/support/tasks/t9/pushNotificationConfigs', 'PUSH_NOTIFICATION_NOT_SUPPORTED'],
      [
        'DELETE',
        '/a2a/support/tasks/t9/pushNotificationConfigs/c1',
        'PUSH_NOTIFICATION_NOT_SUPPORTED',
      ],
    ] as const) {
      const res = await call(h.handle, method, url, { headers: auth });
      expect(res.json().error.details[0].reason, url).toBe(reason);
    }
  });
});

// ── message:send ───────────────────────────────────────────────────────────────

describe('message:send (PACT §4)', () => {
  it('answers synchronously, mints a contextId and continues it', async () => {
    const h = handlerFor((args, turn) => ({ text: `reply ${turn}:${args.messages.length}` }));
    const headers = { authorization: 'Bearer user|u1', 'content-type': 'text/plain' };
    const first = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers,
      body: send('hi'),
    });
    expect(first.sent.status).toBe(200);
    expect(first.sent.headers['content-type']).toBe('application/a2a+json');
    const message = first.json().message;
    expect(message).toMatchObject({ role: 'ROLE_AGENT', contextId: expect.any(String) });
    expect(message.parts[0].text).toMatch(/^reply 0/);
    expect(message).not.toHaveProperty('taskId');

    const second = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers,
      body: send('again', { contextId: message.contextId }),
    });
    expect(second.json().message.contextId).toBe(message.contextId);
    expect(second.json().message.parts[0].text).toMatch(/^reply 1/);
  });

  it('runs identity-only turns as a stable personal-agent actor', async () => {
    let seen: unknown;
    const h = handlerFor((args) => {
      seen = args;
      return { text: 'ok' };
    });
    await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer user|u1' },
      body: send('hi'),
    });
    const threads = await h.store.listThreads(personalAgentActorId('https://pa.example', 'u1'));
    // Transient: kept out of the thread list (and so out of the user's own chat UI).
    expect(threads).toEqual([]);
    expect(seen).toBeDefined();
  });

  it('a repeated messageId returns the stored reply without re-running', async () => {
    let runs = 0;
    const h = handlerFor(() => {
      runs += 1;
      return { text: `run ${runs}` };
    });
    const headers = { authorization: 'Bearer user|u1' };
    const messageId = crypto.randomUUID();
    const body = (contextId?: string) =>
      JSON.stringify({
        message: {
          messageId,
          role: 'ROLE_USER',
          parts: [{ text: 'hi' }],
          ...(contextId ? { contextId } : {}),
        },
      });
    const first = (
      await call(h.handle, 'POST', '/a2a/support/message:send', { headers, body: body() })
    ).json();
    const retry = (
      await call(h.handle, 'POST', '/a2a/support/message:send', {
        headers,
        body: body(first.message.contextId),
      })
    ).json();
    expect(retry.message.messageId).toBe(first.message.messageId);
    expect(runs).toBe(1);
  });

  it("another user's or another brand's context is an unknown contextId", async () => {
    const h = handlerFor(() => ({ text: 'ok' }));
    const owner = (
      await call(h.handle, 'POST', '/a2a/support/message:send', {
        headers: { authorization: 'Bearer user|owner' },
        body: send('hi'),
      })
    ).json().message.contextId;
    for (const [brand, sub] of [
      ['support', 'intruder'],
      ['sales', 'owner'],
    ] as const) {
      const res = await call(h.handle, 'POST', `/a2a/${brand}/message:send`, {
        headers: { authorization: `Bearer user|${sub}` },
        body: send('hi', { contextId: owner }),
      });
      expect(res.sent.status).toBe(400);
      expect(res.json().error).toMatchObject({
        message: 'Unknown contextId',
        status: 'INVALID_ARGUMENT',
      });
    }
  });

  it('a delegated context refuses a token for another account (PACT §5.5)', async () => {
    const h = handlerFor(() => ({ text: 'ok' }));
    const contextId = (
      await call(h.handle, 'POST', '/a2a/support/message:send', {
        headers: { authorization: 'Bearer deleg|u1|acct-1|orders:read' },
        body: send('hi'),
      })
    ).json().message.contextId;
    const res = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer deleg|u1|acct-2|orders:read' },
      body: send('hi', { contextId }),
    });
    expect(res.json().error.details[0].reason).toBe('INVALID_PARAMS');
  });
});

// ── delegation ─────────────────────────────────────────────────────────────────

describe('delegated turns (PACT §5)', () => {
  function withCancelTool(h: ReturnType<typeof handlerFor>, ran: string[]) {
    h.registry.register(
      {
        name: 'cancel_order',
        kind: 'action',
        description: 'Cancel an order',
        inputSchema: z.object({ id: z.string() }),
        roles: ['orders:cancel'],
      },
      {
        execute: async (input) => {
          ran.push((input as { id: string }).id);
          return { cancelled: true };
        },
      },
    );
  }
  const cancelScript: FakeScript = (_args, turn) =>
    turn === 0
      ? { text: 'Cancelling. ', toolCall: { name: 'cancel_order', input: { id: 'A-1' } } }
      : { text: 'Done.' };

  it('approves an action the delegation grants, and signs a receipt for it', async () => {
    const ran: string[] = [];
    const h = handlerFor(cancelScript);
    withCancelTool(h, ran);
    const res = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer deleg|u1|acct-1|orders:cancel' },
      body: send('cancel A-1'),
    });
    expect(ran).toEqual(['A-1']);
    const message = res.json().message;
    expect(message.parts[0].text).toContain('Done.');
    expect(message.metadata['pact.receipt']).toMatchObject({
      scopesUsed: ['orders:cancel'],
      actions: [{ tool: 'cancel_order', argsHash: expect.any(String) }],
    });
  });

  it('without the scope the action is never offered; with policy "reject" it is refused', async () => {
    const ran: string[] = [];
    const h = handlerFor(cancelScript, 'reject');
    withCancelTool(h, ran);
    await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer deleg|u1|acct-1|orders:cancel' },
      body: send('cancel A-1'),
    });
    expect(ran).toEqual([]);

    const identity = handlerFor(cancelScript);
    withCancelTool(identity, ran);
    await call(identity.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer user|u1' },
      body: send('cancel A-1'),
    });
    expect(ran).toEqual([]);
  });

  it('a read under a delegated scope is in the receipt too', async () => {
    const h = handlerFor((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'list_orders', input: {} } }
        : { text: 'Two orders.' },
    );
    h.registry.register(
      {
        name: 'list_orders',
        kind: 'read',
        description: 'List orders',
        inputSchema: z.object({}),
        roles: ['orders:read'],
      },
      { execute: async () => ({ orders: 2 }) },
    );
    const res = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer deleg|u1|acct-1|orders:read' },
      body: send('my orders'),
    });
    expect(res.json().message.metadata['pact.receipt']).toMatchObject({
      scopesUsed: ['orders:read'],
      actions: [{ tool: 'list_orders' }],
    });
  });

  it('request_permission becomes a TASK_STATE_AUTH_REQUIRED step-up', async () => {
    const h = handlerFor((_args, turn) =>
      turn === 0
        ? {
            text: 'I need permission to cancel orders.',
            toolCall: { name: REQUEST_PERMISSION_TOOL, input: { scopes: ['orders:cancel'] } },
          }
        : { text: 'unreachable' },
    );
    registerRequestPermissionTool(h.registry, await fakeAuth.delegableScopes());
    const res = await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer deleg|u1|acct-1|orders:read' },
      body: send('cancel A-1'),
    });
    const task = res.json().task;
    expect(task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(task.status.message.parts[0].text).toContain('I need permission');
    expect(task.metadata).toMatchObject({
      'pact.missingScopes': ['orders:cancel'],
      'pact.verificationUriComplete': 'https://c',
    });
    expect(task.contextId).toEqual(expect.any(String));
  });

  it('request_permission is reachable only by personal agents', () => {
    const registry = new ToolRegistry();
    registerRequestPermissionTool(registry, { a: 'A' });
    expect(registry.spec(REQUEST_PERMISSION_TOOL)?.roles).toEqual([PERSONAL_AGENT_ROLE]);
  });
});

describe('personalAgentGate', () => {
  const gate = personalAgentGate(new DefaultToolAuthorizer());
  const tool = (roles?: string[]) =>
    ({ name: 't', kind: 'read', description: '', inputSchema: z.object({}), roles }) as never;
  const pa = { id: 'pa:1', roles: [PERSONAL_AGENT_ROLE, 'orders:read'] };
  const human = { id: 'u1', roles: ['USER'] };

  it('keeps tools that name no role away from personal agents (and only from them)', async () => {
    expect(await gate.can(pa, tool())).toBe(false);
    expect(await gate.can(human, tool())).toBe(true);
  });

  it('lets personal agents reach tools that name their role or a delegated scope', async () => {
    expect(await gate.can(pa, tool([PERSONAL_AGENT_ROLE]))).toBe(true);
    expect(await gate.can(pa, tool(['orders:read']))).toBe(true);
    expect(await gate.can(pa, tool(['orders:cancel']))).toBe(false);
    expect(await gate.can(human, tool([PERSONAL_AGENT_ROLE]))).toBe(false);
  });

  it('an app tool with no roles is never run for a personal agent', async () => {
    const ran: string[] = [];
    const h = handlerFor((_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'internal_report', input: {} } } : { text: 'ok' },
    );
    h.registry.register(
      { name: 'internal_report', kind: 'read', description: 'x', inputSchema: z.object({}) },
      { execute: async () => (ran.push('ran'), {}) },
    );
    await call(h.handle, 'POST', '/a2a/support/message:send', {
      headers: { authorization: 'Bearer user|u1' },
      body: send('report'),
    });
    expect(ran).toEqual([]);
  });
});
