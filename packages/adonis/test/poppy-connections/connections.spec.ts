// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryStateStore, runTick, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../../src/durable/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  ToolRegistry,
} from '../../src/index.js';
import { generateEs256Key } from '../../src/poppy-client/keys.js';
import {
  createPoppyConnectionsHandler,
  InMemoryPoppyConnectionStore,
  PoppyConnections,
  type PoppyConnectionsConfig,
  type PoppyPendingConnect,
  registerPoppyConnectionTools,
  Sealer,
} from '../../src/poppy-connections/index.js';
import { resumeAfterConnect } from '../../src/poppy-connections/resume.js';
import type { AiToolCtx, ToolHandler } from '../../src/spi/tool.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../../src/testing/index.js';
import type { ToolSpec } from '../../src/types.js';
import { FakeCompany, type FakeOptions } from '../poppy-client/fixtures/fake_company.js';

vi.setConfig({ testTimeout: 20_000 });

const SECRET = 'x'.repeat(32);

interface App {
  fake: FakeCompany;
  connections: PoppyConnections;
  store: InMemoryPoppyConnectionStore;
  base: string;
  tools: Map<string, { spec: ToolSpec; handler: ToolHandler<any> }>;
  connected: PoppyPendingConnect[];
  close(): Promise<void>;
}

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** A fake Company and THIS app's agent side, its routes served on a real port. */
async function setup(
  overrides: Partial<PoppyConnectionsConfig> = {},
  fakeOptions: FakeOptions = {},
  hooks: {
    onConnected?: (pending: PoppyPendingConnect) => Promise<void>;
    registry?: ToolRegistry;
  } = {},
): Promise<App> {
  const fake = await new FakeCompany(fakeOptions).start();
  const store = new InMemoryPoppyConnectionStore();
  const connected: PoppyPendingConnect[] = [];
  let handle: ReturnType<typeof createPoppyConnectionsHandler>;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    void handle({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      async readBody() {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      },
      send(status, headers, body) {
        res.writeHead(status, headers);
        res.end(body);
      },
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const connections = new PoppyConnections({
    config: {
      baseUrl: base,
      identity: {
        name: 'Acme Assistant',
        keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
      },
      companies: [fake.domain],
      insecureDev: true,
      ...overrides,
    },
    store,
    secret: SECRET,
    production: false,
    onConnected: async (pending) => {
      connected.push(pending);
      await hooks.onConnected?.(pending);
    },
  });
  handle = createPoppyConnectionsHandler(connections);
  const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler<any> }>();
  registerPoppyConnectionTools(
    {
      register: (spec: ToolSpec, handler: ToolHandler<any>) => {
        tools.set(spec.name, { spec, handler });
        hooks.registry?.register(spec, handler);
      },
    } as unknown as ToolRegistry,
    connections,
  );
  return {
    fake,
    connections,
    store,
    base,
    tools,
    connected,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.stop();
    },
  };
}

const actor = { id: 'profile-1', tenantRef: 'account-1' };
const ctx = (callId = 'call-1'): AiToolCtx =>
  ({
    actor,
    threadId: 'thread-1',
    runId: 'run-1',
    requestId: 'req-1',
    toolCallId: callId,
  }) as AiToolCtx;

async function tool(a: App, name: string, input: unknown, callId?: string) {
  return a.tools.get(`poppy_${name}`)!.handler.execute(input, ctx(callId));
}
async function preflight(a: App, name: string, input: unknown, callId?: string) {
  return a.tools.get(`poppy_${name}`)!.handler.preflight!(input, ctx(callId), { phase: 'prepare' });
}

/** The `connect` card's link (its detail). */
async function connectLink(
  a: App,
  input: Record<string, unknown> = {},
  callId?: string,
): Promise<string> {
  const pre = (await preflight(a, 'connect', { company: a.fake.domain, ...input }, callId)) as {
    status: string;
    confirmation: { detail: string };
  };
  expect(pre.status).toBe('ready');
  return /(http:\/\/\S+\/connect\/\S+)$/.exec(pre.confirmation.detail)![1]!;
}

/** Plays the person's browser through Direct Sign-In from the connect page. */
async function direct(a: App, link: string): Promise<string> {
  const toCompany = await fetch(`${link}/direct`, { method: 'POST', redirect: 'manual' });
  expect(toCompany.status).toBe(303);
  const authorize = await fetch(toCompany.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!);
  return callback.text();
}

describe('poppy-connections: identity', () => {
  it('serves its client metadata and public keys under {path}', async () => {
    app = await setup();
    const meta = await (await fetch(`${app.base}/poppy-agent/agent.json`)).json();
    expect(meta).toMatchObject({
      client_id: `${app.base}/poppy-agent/agent.json`,
      client_name: 'Acme Assistant',
      jwks_uri: `${app.base}/poppy-agent/jwks.json`,
      redirect_uris: [`${app.base}/poppy-agent/oauth/callback`],
      token_endpoint_auth_method: 'private_key_jwt',
    });
    // The default logo_uri resolves (a consent screen shows it).
    expect(meta.logo_uri).toBe(`${app.base}/poppy-agent/logo.svg`);
    const logo = await fetch(meta.logo_uri);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(await logo.text()).toContain('>A</text>');
    const jwks = await (await fetch(`${app.base}/poppy-agent/jwks.json`)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('insecureDev is refused in production', () => {
    expect(
      () =>
        new PoppyConnections({
          config: { baseUrl: 'http://x', identity: { name: 'x', keys: [] }, insecureDev: true },
          store: new InMemoryPoppyConnectionStore(),
          secret: SECRET,
          production: true,
        }),
    ).toThrow(/development only/);
  });
});

describe('poppy-connections: allow-list', () => {
  it('denies every company by default, and anything off the list', async () => {
    app = await setup({ companies: [] });
    expect(app.connections.policy(app.fake.domain)).toBeNull();
    expect(await tool(app, 'companies', {})).toEqual({ companies: [] });
    // Each refusal points the model back to the list (a guessed domain is a common slip).
    expect(await preflight(app, 'connect', { company: app.fake.domain })).toMatchObject({
      status: 'denied',
      reason: expect.stringContaining('Call poppy_companies'),
    });
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      error: 'not_allowed',
      next: expect.stringContaining('poppy_companies'),
    });
    expect(app.fake.log.length + app.fake.sessions.size).toBe(0); // nothing was fetched
  });

  it('a company named rather than by domain resolves to the one allowed company', async () => {
    app = await setup();
    const domain = app.fake.domain;
    // Before connecting, only the label could name it; there is none → refused as given.
    expect(await tool(app, 'tools', { company: 'fakeco.com' })).toMatchObject({
      error: 'not_allowed',
    });
    await direct(app, await connectLink(app));
    // Connected: its organization ("Fake Co") names it, as a word or a guessed domain.
    for (const name of ['Fake Co', 'fakeco.com', 'FAKECO']) {
      const listed = (await tool(app, 'tools', { company: name })) as { tools?: unknown[] };
      expect(listed.tools, name).toBeDefined();
    }
    expect(await tool(app, 'tools', { company: 'other.example' })).toMatchObject({
      error: 'not_allowed',
    });
    expect(await app.connections.resolveCompany('account-1', 'Fake Co')).toBe(domain);
  });

  it('a label names an allowed company before any connection', async () => {
    const fake = await new FakeCompany().start();
    const domain = fake.domain;
    await fake.stop();
    const connections = new PoppyConnections({
      config: {
        baseUrl: 'http://127.0.0.1:1',
        identity: {
          name: 'X',
          keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
        },
        companies: { [domain]: { label: 'Acme Shop' }, 'b.example': { label: 'Acme' } },
        insecureDev: true,
      },
      store: new InMemoryPoppyConnectionStore(),
      secret: SECRET,
      production: false,
    });
    expect(await connections.resolveCompany('o', 'acmeshop.com')).toBe(domain);
    expect(await connections.resolveCompany('o', 'Acme')).toBe('b.example');
    expect(await connections.resolveCompany('o', 'nope.example')).toBe('nope.example');
  });

  it('lists the allowed ones with their connection', async () => {
    app = await setup();
    expect(await tool(app, 'companies', {})).toEqual({
      companies: [{ company: app.fake.domain, connected: false, scopes: [] }],
    });
  });
});

describe('poppy-connections: connect flows', () => {
  it('Direct: the card carries the link, the callback connects and resumes the parked call', async () => {
    app = await setup();
    const link = await connectLink(app);
    expect(await (await fetch(link)).text()).toContain('/direct');
    expect(await direct(app, link)).toContain('Connected to Fake Co');

    expect(app.connected).toHaveLength(1);
    expect(app.connected[0]).toMatchObject({
      toolCallId: 'call-1',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(await tool(app, 'connect', { company: app.fake.domain })).toMatchObject({
      connected: true,
    });
    const [row] = await app.store.listConnections('account-1');
    expect(row).toMatchObject({
      status: 'active',
      organization: 'Fake Co',
      domain: app.fake.domain,
    });
    // Sealed at rest: no Account Token in clear.
    const token = [...app.fake.accountTokens.keys()][0]!;
    expect(row!.state).not.toContain(token);
    expect(
      new Sealer(SECRET).open<{ accountToken: { refreshToken: string } }>(row!.state).accountToken
        .refreshToken,
    ).toBe(token);
    // Already connected: no new card.
    expect(await preflight(app, 'connect', { company: app.fake.domain }, 'call-2')).toMatchObject({
      status: 'completed',
    });
    // The link is single-purpose: done is done.
    expect(await (await fetch(link)).text()).toContain('Connected to Fake Co');
  });

  it('the same call reaches the same link (a replay does not mint another)', async () => {
    app = await setup();
    expect(await connectLink(app)).toBe(await connectLink(app));
    expect(await connectLink(app, {}, 'call-9')).not.toBe(await connectLink(app));
  });

  it('Mediated: credentials and the code go through this app’s page, never stored', async () => {
    app = await setup();
    const link = await connectLink(app);
    const page = await (await fetch(link)).text();
    expect(page).toContain('type="password"');
    const step = await fetch(`${link}/mediated`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'dana@example.com', password: 'hunter2' }).toString(),
    });
    expect(await step.text()).toContain('ending in 71');
    const done = await fetch(`${link}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=123456',
    });
    expect(await done.text()).toContain('Connected to Fake Co');
    const [row] = await app.store.listConnections('account-1');
    expect(row!.scope).toBe('poppy:read');
    const pending = await app.store.getPending(app.connections.connectIdFor('run-1:call-1'));
    expect(JSON.stringify(pending)).not.toContain('hunter2');
    expect(row!.state).not.toContain('hunter2');
  });

  it('Device: a code to approve at the company, then "I approved it"', async () => {
    app = await setup({}, { devicePendingPolls: 1 });
    const link = await connectLink(app);
    const page = await (await fetch(`${link}/device`, { method: 'POST' })).text();
    expect(page).toContain('WDJB-MJHT');
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Not approved yet',
    );
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Not approved yet',
    );
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Connected to Fake Co',
    );
    expect(app.connected).toHaveLength(1);
  });

  it('an unknown or expired link says so', async () => {
    app = await setup({ connectTtlSeconds: 1 });
    expect((await fetch(`${app.base}/poppy-agent/connect/${'a'.repeat(32)}`)).status).toBe(410);
    const link = await connectLink(app);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await fetch(link)).status).toBe(410);
  });
});

describe('poppy-connections: tools at the company', () => {
  it('reads run at once; a write is an action with a confirmation; scope step-up', async () => {
    app = await setup();
    expect(app.tools.get('poppy_read')!.spec.kind).toBe('read');
    expect(app.tools.get('poppy_write')!.spec.kind).toBe('action');
    expect(app.tools.get('poppy_request')!.spec.kind).toBe('action');
    expect(app.tools.get('poppy_connect')!.spec.kind).toBe('action');

    // Not connected: the write is refused before any card.
    expect(
      await preflight(app, 'write', { company: app.fake.domain, tool: 'place_order' }),
    ).toMatchObject({ status: 'denied' });

    // Mediated grants only poppy:read.
    const link = await connectLink(app);
    await fetch(`${link}/mediated`, {
      method: 'POST',
      body: 'email=dana%40example.com&password=hunter2',
    });
    await fetch(`${link}/code`, { method: 'POST', body: 'code=123456' });

    const listed = (await tool(app, 'tools', { company: app.fake.domain })) as {
      tools: { name: string; readOnly: boolean }[];
    };
    expect(listed.tools.map((t) => [t.name, t.readOnly])).toEqual([
      ['whoami', true],
      ['search_products', true],
      ['place_order', false],
      ['book_trip', false],
    ]);
    expect(
      await tool(app, 'read', {
        company: app.fake.domain,
        tool: 'search_products',
        arguments: { query: 'boots' },
      }),
    ).toMatchObject({
      result: expect.stringContaining('insulated boots'),
    });
    expect(
      await tool(app, 'read', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({
      error: 'not_read_only',
    });
    const card = await preflight(app, 'write', {
      company: app.fake.domain,
      tool: 'place_order',
      arguments: { sku: 'x' },
    });
    expect(card).toMatchObject({
      status: 'ready',
      confirmation: {
        title: 'Fake Co: place_order',
        detail: expect.stringContaining('"sku": "x"'),
      },
    });
    // Approved, but the connection lacks poppy:write → a step-up, not a failure.
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({
      error: 'needs_permission',
      scopes: ['poppy:write'],
    });
    // Step up through connect (Direct grants poppy:write), then the write runs.
    const more = await connectLink(app, { scopes: ['poppy:write'] }, 'call-2');
    await direct(app, more);
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({
      result: 'ordered x',
    });
  });

  it('a two-step company write: the card shows its preview, confirming commits with the token', async () => {
    app = await setup();
    await direct(app, await connectLink(app));
    const input = { company: app.fake.domain, tool: 'book_trip', arguments: { city: 'Lisbon' } };
    // The card carries the company's own preview; nothing is booked yet.
    const card = await preflight(app, 'write', input);
    expect(card).toMatchObject({
      status: 'ready',
      confirmation: { detail: expect.stringContaining('Preview: book a trip to Lisbon.') },
    });
    expect(app.fake.trips).toEqual([]);
    // Confirmed: one write call previews and commits — the trip is booked once.
    expect(await tool(app, 'write', input)).toMatchObject({
      result: expect.stringContaining('"booked"'),
    });
    expect(app.fake.trips).toEqual(['Lisbon']);
    // A tool without the convention runs once, as is.
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'y' },
      }),
    ).toMatchObject({ result: 'ordered y' });
  });

  it('twoStep: false leaves a two-step tool to the model (only the preview runs)', async () => {
    app = await setup({}, {}, {});
    app.tools.clear();
    registerPoppyConnectionTools(
      {
        register: (spec: ToolSpec, handler: ToolHandler<any>) => {
          app!.tools.set(spec.name, { spec, handler });
        },
      } as unknown as ToolRegistry,
      app.connections,
      { twoStep: false },
    );
    await direct(app, await connectLink(app));
    const out = (await tool(app, 'write', {
      company: app.fake.domain,
      tool: 'book_trip',
      arguments: { city: 'Porto' },
    })) as { result: string };
    expect(JSON.parse(out.result)).toMatchObject({ status: 'preview' });
    expect(app.fake.trips).toEqual([]);
  });

  it('ask narrows the token to the read scopes; request uses the grant', async () => {
    app = await setup();
    // Not connected: the company asks for a sign-in → the tool says connect.
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({
      error: 'not_connected',
    });
    await direct(app, await connectLink(app));
    const asked = (await tool(app, 'ask', {
      company: app.fake.domain,
      message: 'show my orders',
    })) as Record<string, unknown>;
    expect(asked.reply).toContain('Here are your orders.');
    const used = [...app.fake.tokens.values()].filter((t) => t.signedIn && !t.bearer);
    expect(used.some((t) => t.scope === 'poppy:read')).toBe(true);
    const requested = (await tool(app, 'request', {
      company: app.fake.domain,
      message: 'hello',
    })) as Record<string, unknown>;
    expect(requested.reply).toContain('You said: hello');
    expect(
      await preflight(app, 'request', { company: app.fake.domain, message: 'cancel ord_1042' }),
    ).toMatchObject({
      status: 'ready',
      confirmation: { title: 'Ask Fake Co to act', detail: 'cancel ord_1042' },
    });
  });
});

describe('poppy-connections: revocation and refresh', () => {
  it('disconnect revokes the Account Token at the company; later calls say not connected', async () => {
    app = await setup();
    await direct(app, await connectLink(app));
    expect(await preflight(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      status: 'ready',
    });
    expect(await tool(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      disconnected: true,
    });
    expect([...app.fake.accountTokens.values()].every((t) => t.revoked)).toBe(true);
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({
      status: 'revoked',
      scope: '',
    });
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({ error: 'not_connected' });
    expect(await preflight(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      status: 'completed',
    });
    // However the company words its refusal (a bare 401 here), not connected means: connect.
    app.fake.bareMcpErrors = true;
    expect(await tool(app, 'tools', { company: app.fake.domain })).toMatchObject({
      error: 'not_connected',
    });
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      error: 'not_connected',
    });
  });

  it('a revocation at the company is noticed (invalid_grant) and the connection marked revoked', async () => {
    app = await setup({}, { accessTtl: 1 });
    await direct(app, await connectLink(app));
    for (const t of app.fake.accountTokens.values()) t.revoked = true;
    await new Promise((r) => setTimeout(r, 1100));
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({ error: 'not_connected' });
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({ status: 'revoked' });
  });

  it('expired Session Tokens renew with the Account Token, a rotated one is kept sealed', async () => {
    app = await setup({}, { accessTtl: 1, rotateAccountToken: true });
    await direct(app, await connectLink(app));
    const first = [...app.fake.accountTokens.keys()];
    await new Promise((r) => setTimeout(r, 1100));
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      result: expect.stringContaining('"signed_in":true'),
    });
    const current = [...app.fake.accountTokens.entries()]
      .filter(([, t]) => !t.revoked)
      .map(([k]) => k);
    expect(current.some((k) => !first.includes(k))).toBe(true);
    const [row] = await app.store.listConnections('account-1');
    expect(
      new Sealer(SECRET).open<{ accountToken: { refreshToken: string } }>(row!.state).accountToken
        .refreshToken,
    ).toBe(current[0]);
  });

  it('two owners never share a connection', async () => {
    app = await setup();
    await direct(app, await connectLink(app));
    const other = { ...ctx(), actor: { id: 'profile-2', tenantRef: 'account-2' } } as AiToolCtx;
    expect(
      await app.tools
        .get('poppy_ask')!
        .handler.execute({ company: app.fake.domain, message: 'show my orders' }, other),
    ).toMatchObject({
      error: 'not_connected',
    });
  });
});

describe('poppy-connections: the connect card resumes the turn (durable, single serial worker)', () => {
  it('the sign-in decides the parked connect call; the turn continues connected', async () => {
    const store = new InMemoryAgentStore();
    const registry = new ToolRegistry();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider((args, turn) => {
        const result = args.messages.at(-1);
        if (turn === 0)
          return {
            text: '',
            toolCall: { name: 'poppy_connect', input: { company: app!.fake.domain } },
          };
        return { text: `after connect: ${JSON.stringify(result?.content ?? '')}` };
      }),
      store,
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry,
      agents: new AgentRegistry(),
    });
    // `durable:work` as deployed: start only persists the run; ONE worker ticks.
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      runDispatcher: { dispatch: () => {} },
    });
    setDurableAgentContext({ factory, store });
    registerAgentWorkflow(engine);
    const service = new AgentService(new DurableAgentRunner(engine, store), store, factory);
    let stopped = false;
    const worker = (async () => {
      while (!stopped) {
        await runTick(engine);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    try {
      app = await setup(
        {},
        {},
        { registry, onConnected: (pending) => resumeAfterConnect(service, pending) },
      );
      const owner = { id: 'profile-1', tenantRef: 'account-1' };
      const { runId } = await service.chat({ actor: owner, message: 'order boots at Fake Co' });
      const toolCallId = 'call-0-poppy_connect';
      const deadline = Date.now() + 8000;
      while (
        !store
          .toolCallRows()
          .some((r) => r.toolName === 'poppy_connect' && r.status === 'pending_approval')
      ) {
        if (Date.now() > deadline) throw new Error('never parked');
        await new Promise((r) => setTimeout(r, 20));
      }
      const approval = store.toolCallRows().find((r) => r.toolName === 'poppy_connect')!;
      const link = app.connections.connectUrl(
        app.connections.connectIdFor(`${runId}:${approval.toolCallId ?? toolCallId}`),
      );
      expect(await direct(app, link)).toContain('Connected to Fake Co');
      while ((await engine.getRun(runId))?.status !== 'completed') {
        if (Date.now() > deadline)
          throw new Error(`run stuck: ${(await engine.getRun(runId))?.status}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      const row = store.toolCallRows().find((r) => r.toolName === 'poppy_connect')!;
      expect(row.status).toBe('executed');
      expect(JSON.stringify(row)).toContain('"connected":true');
    } finally {
      stopped = true;
      await worker;
      setDurableAgentContext(undefined);
    }
  });
});

describe('poppy-connections: for loops that do not park on approvals', () => {
  it("connect: 'link' is a read tool returning the link; writes: false leaves the writes to the app", async () => {
    app = await setup();
    const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler<any> }>();
    registerPoppyConnectionTools(
      {
        register: (spec: ToolSpec, handler: ToolHandler<any>) =>
          tools.set(spec.name, { spec, handler }),
      } as unknown as ToolRegistry,
      app.connections,
      { connect: 'link', writes: false, ability: 'companies.use' },
    );
    expect([...tools.keys()].sort()).toEqual(
      ['poppy_ask', 'poppy_companies', 'poppy_connect', 'poppy_read', 'poppy_tools'].sort(),
    );
    expect(tools.get('poppy_connect')!.spec.kind).toBe('read');
    expect([...tools.values()].every((t) => t.spec.ability === 'companies.use')).toBe(true);
    const out = (await tools
      .get('poppy_connect')!
      .handler.execute({ company: app.fake.domain }, ctx())) as {
      connected: boolean;
      link: string;
    };
    expect(out.connected).toBe(false);
    expect(await direct(app, out.link)).toContain('Connected to Fake Co');
    expect(
      await tools
        .get('poppy_connect')!
        .handler.execute({ company: app.fake.domain }, ctx('call-2')),
    ).toMatchObject({
      connected: true,
    });
    const { callCompanyTool } = await import('../../src/poppy-connections/index.js');
    expect(
      await callCompanyTool(
        app.connections,
        'account-1',
        { company: app.fake.domain, tool: 'place_order', arguments: { sku: 'y' } },
        false,
      ),
    ).toMatchObject({
      result: 'ordered y',
    });
  });
});
