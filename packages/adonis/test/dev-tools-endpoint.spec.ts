// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeIdentity } from '../src/dev-tools/authkit-bridge.js';
import type { DevTool, DevToolsDecision, DevToolsLib } from '../src/dev-tools/contract.js';
import { registerDevTools } from '../src/dev-tools/index.js';
import { type McpAuth, McpAuthError } from '../src/mcp/auth.js';
import type { McpConfig } from '../src/mcp/define_config.js';
import { ToolRegistry } from '../src/tool-registry.js';

/**
 * Boots a real AdonisJS app with `mcp_provider` and a fake lib provider that registers dev tools from
 * its own `boot()` — listed BEFORE `mcp_provider`, so the hub must already exist (bound in
 * `register()`). Hits `/mcp/agora` over HTTP, and with the SDK's own Streamable HTTP client.
 */

const calls: Record<string, number> = {};
const audit: Array<{ level: string; obj: Record<string, unknown> }> = [];

const read = (name: string, extra: Partial<DevTool> = {}): DevTool => ({
  name,
  kind: 'read',
  description: `${name} (test)`,
  input: { type: 'object', properties: {} },
  run: async () => ({ items: [{ id: 1, tool: name, clientSecret: 'shh' }], next: null }),
  ...extra,
});

const byToken =
  (token: string) =>
  async (ctx: HttpContext): Promise<DevToolsDecision> =>
    ctx.request.header('authorization') === `Bearer ${token}`
      ? { allowed: true }
      : { allowed: false, reason: 'unauthenticated' };

const counted = (lib: string, authorize: DevToolsLib['authorize']): DevToolsLib['authorize'] => {
  return async (ctx) => {
    calls[lib] = (calls[lib] ?? 0) + 1;
    return authorize(ctx);
  };
};

/** durable: console token; telescope: open; payments: always forbidden. */
function defaultLibs(): DevToolsLib[] {
  return [
    {
      lib: 'durable',
      title: 'Durable workflows',
      authorize: counted('durable', byToken('dur-token')),
      tools: [
        read('durable_list_runs'),
        read('durable_get_run', {
          input: {
            type: 'object',
            properties: { id: { type: 'string' }, full: { type: 'boolean' } },
            required: ['id'],
          },
          run: async (input, call) => ({ id: input.id, caller: call.caller }),
        }),
        {
          ...read('durable_retry_run'),
          kind: 'action',
          run: async () => ({ status: 'retried' }),
        },
      ],
    },
    {
      lib: 'telescope',
      title: 'Telescope',
      authorize: counted('telescope', async () => ({ allowed: true })),
      tools: [
        read('telescope_list_entries'),
        read('telescope_diagnose_exception', { available: () => false }),
      ],
    },
    {
      lib: 'payments',
      title: 'Payments',
      authorize: counted('payments', async () => ({ allowed: false, reason: 'forbidden' })),
      tools: [read('payments_list_payments')],
    },
  ];
}

let libsToRegister: DevToolsLib[] = [];
let registered: boolean | undefined;

class FakeLibProvider {
  constructor(protected app: ApplicationService) {}
  async boot() {
    for (const lib of libsToRegister) {
      registered = await registerDevTools(this.app as never, lib);
    }
  }
}

interface BootedApp {
  url: string;
  app: ApplicationService;
  close(): Promise<void>;
}

interface BootOptions {
  libs?: DevToolsLib[];
  registry?: ToolRegistry;
  authkit?: (url: () => string) => unknown;
  extraProviders?: Array<() => Promise<{ default: unknown }>>;
  config?: Record<string, unknown>;
}

async function bootApp(mcp: Partial<McpConfig>, options: BootOptions = {}): Promise<BootedApp> {
  libsToRegister = options.libs ?? defaultLibs();
  registered = undefined;
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => Promise.resolve({ default: FakeLibProvider }),
          ...(options.extraProviders ?? []),
          () => import('../providers/mcp_provider.js'),
        ],
      },
      config: { mcp: { name: 'test', version: '0.0.0', ...mcp }, ...options.config },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  let url = '';
  if (options.registry) {
    const registry = options.registry;
    app.container.singleton(ToolRegistry, () => registry);
  }
  if (options.authkit) {
    const fake = options.authkit(() => url);
    app.container.bindValue('authkit.server' as never, fake as never);
  }
  const logger = {
    info: (obj: Record<string, unknown>) => audit.push({ level: 'info', obj }),
    debug: (obj: Record<string, unknown>) => audit.push({ level: 'debug', obj }),
    warn: (obj: Record<string, unknown>) => audit.push({ level: 'warn', obj }),
    error: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger,
  };
  app.container.bindValue('logger', logger as never);
  await app.boot();

  const server = await app.container.make('server');
  server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
  await server.boot();
  const node: Server = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  const { port } = node.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;

  return {
    url,
    app,
    async close() {
      await app.terminate();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

function rpc(url: string, body: unknown, token?: string, method = 'POST') {
  return fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const callTool = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: args },
});

async function toolNames(url: string, token?: string): Promise<string[]> {
  const response = await rpc(`${url}/mcp/agora`, listTools, token);
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.result.tools.map((tool: { name: string }) => tool.name).sort();
}

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
  for (const key of Object.keys(calls)) delete calls[key];
  audit.length = 0;
});

describe('dev tools endpoint: a real MCP client over Streamable HTTP', () => {
  it('initializes, lists the allowed libs and calls a tool, redacted', async () => {
    booted = await bootApp({});
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${booted.url}/mcp/agora`), {
      requestInit: { headers: { authorization: 'Bearer dur-token' } },
    });
    await client.connect(transport);
    expect(client.getInstructions()).toContain('Durable workflows, Telescope');
    expect(client.getInstructions()).not.toContain('Payments');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'durable_get_run',
      'durable_list_runs',
      'telescope_list_entries',
    ]);
    const getRun = tools.find((tool) => tool.name === 'durable_get_run');
    expect(getRun?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(getRun?.annotations).toEqual({ readOnlyHint: true });

    const result = await client.callTool({ name: 'durable_list_runs', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({
      items: [{ id: 1, tool: 'durable_list_runs', clientSecret: '[redacted]' }],
      next: null,
    });

    const caller = await client.callTool({ name: 'durable_get_run', arguments: { id: 'r1' } });
    const callerText = (caller.content as Array<{ text: string }>)[0]?.text ?? '';
    const hash = createHash('sha256').update('dur-token').digest('hex').slice(0, 12);
    expect(JSON.parse(callerText)).toEqual({
      id: 'r1',
      caller: { id: `token:${hash}`, via: 'token' },
    });

    const invalid = await client.callTool({
      name: 'durable_get_run',
      arguments: { id: 'r1', extra: true },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
  });
});

describe('dev tools endpoint: per-lib authorize', () => {
  it('lists only the tools of the libs that allow the caller', async () => {
    booted = await bootApp({});
    // no token: durable says unauthenticated, payments forbidden, telescope open
    expect(await toolNames(booted.url)).toEqual(['telescope_list_entries']);
    expect(await toolNames(booted.url, 'dur-token')).toEqual([
      'durable_get_run',
      'durable_list_runs',
      'telescope_list_entries',
    ]);
  });

  it('runs each needed authorize once per request, and only the called lib for tools/call', async () => {
    booted = await bootApp({});
    await toolNames(booted.url);
    expect(calls).toEqual({ durable: 1, telescope: 1, payments: 1 });
    await rpc(`${booted.url}/mcp/agora`, callTool('telescope_list_entries'));
    expect(calls).toEqual({ durable: 1, telescope: 2, payments: 1 });
  });

  it('answers a call to a denied lib like a denied console API call: 401 or 403', async () => {
    booted = await bootApp({});
    const unauthenticated = await rpc(`${booted.url}/mcp/agora`, callTool('durable_list_runs'));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer realm="agora-dev"');
    expect(await unauthenticated.json()).toEqual({ error: 'unauthenticated' });

    const wrongToken = await rpc(`${booted.url}/mcp/agora`, callTool('durable_list_runs'), 'nope');
    expect(wrongToken.status).toBe(401);
    expect(wrongToken.headers.get('www-authenticate')).toBe(
      'Bearer realm="agora-dev", error="invalid_token"',
    );

    const forbidden = await rpc(`${booted.url}/mcp/agora`, callTool('payments_list_payments'));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('www-authenticate')).toBeNull();
    expect(await forbidden.json()).toEqual({ error: 'forbidden' });

    const warned = audit.filter((line) => line.level === 'warn');
    expect(warned.map((line) => line.obj.status)).toEqual([401, 401, 403]);
    expect(JSON.stringify(warned)).not.toContain('nope');
  });

  it('all denied with a redirectTo → 401 without resource_metadata; a throw → 403', async () => {
    booted = await bootApp(
      {},
      {
        libs: [
          {
            lib: 'media',
            title: 'Media',
            authorize: async () => ({
              allowed: false,
              reason: 'unauthenticated',
              redirectTo: '/login',
            }),
            tools: [read('media_list_disks')],
          },
        ],
      },
    );
    const response = await rpc(`${booted.url}/mcp/agora`, listTools);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="agora-dev"');
    await booted.close();

    booted = await bootApp(
      {},
      {
        libs: [
          {
            lib: 'media',
            title: 'Media',
            authorize: async () => {
              throw new Error('boom');
            },
            tools: [read('media_list_disks')],
          },
        ],
      },
    );
    expect((await rpc(`${booted.url}/mcp/agora`, listTools)).status).toBe(403);
  });

  it('an unknown tool is authorized like any call, then a tool error', async () => {
    booted = await bootApp({});
    const response = await rpc(`${booted.url}/mcp/agora`, callTool('durable_nope'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Tool "durable_nope" is not registered');
    expect(calls).toEqual({ durable: 1, telescope: 1, payments: 1 });
  });

  it('an unknown tool from a caller every lib refuses is a 401, like a real one', async () => {
    booted = await bootApp({}, { libs: [{ ...defaultLibs()[0]! }] });
    const unknown = await rpc(`${booted.url}/mcp/agora`, callTool('payments_list_payments'));
    const known = await rpc(`${booted.url}/mcp/agora`, callTool('durable_list_runs'));
    expect([unknown.status, known.status]).toEqual([401, 401]);
  });

  it('reads a console-shaped verdict: true, false, { redirectTo }', async () => {
    const libOf = (id: string, verdict: unknown): DevToolsLib => ({
      lib: id,
      title: id,
      authorize: (async () => verdict) as unknown as DevToolsLib['authorize'],
      tools: [read(`${id}_list_things`)],
    });
    booted = await bootApp(
      {},
      { libs: [libOf('yes', true), libOf('no', false), libOf('login', { redirectTo: '/login' })] },
    );
    expect(await toolNames(booted.url)).toEqual(['yes_list_things']);
    expect((await rpc(`${booted.url}/mcp/agora`, callTool('no_list_things'))).status).toBe(403);
    expect((await rpc(`${booted.url}/mcp/agora`, callTool('login_list_things'))).status).toBe(401);
  });

  it('GET and DELETE are 405 once authorized, 401 before', async () => {
    booted = await bootApp({}, { libs: [{ ...defaultLibs()[0]! }] });
    expect((await rpc(`${booted.url}/mcp/agora`, null, undefined, 'GET')).status).toBe(401);
    const get = await rpc(`${booted.url}/mcp/agora`, null, 'dur-token', 'GET');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await rpc(`${booted.url}/mcp/agora`, null, 'dur-token', 'DELETE')).status).toBe(405);
  });

  it('writes one audit line per call: debug for reads, args redacted, token hashed', async () => {
    booted = await bootApp({ devTools: { actions: 'execute' } });
    await rpc(`${booted.url}/mcp/agora`, callTool('durable_get_run', { id: 'r1' }), 'dur-token');
    await rpc(`${booted.url}/mcp/agora`, callTool('durable_retry_run'), 'dur-token');
    const lines = audit.filter((line) => line.obj.devTool !== undefined);
    const hash = createHash('sha256').update('dur-token').digest('hex').slice(0, 12);
    expect(lines).toEqual([
      {
        level: 'debug',
        obj: {
          devTool: 'durable_get_run',
          lib: 'durable',
          caller: `token:${hash}`,
          kind: 'read',
          ok: true,
          ms: expect.any(Number),
          args: '{"id":"r1"}',
        },
      },
      {
        level: 'info',
        obj: expect.objectContaining({ devTool: 'durable_retry_run', kind: 'action', ok: true }),
      },
    ]);
  });
});

describe('dev tools endpoint: actions', () => {
  it('hides actions by default, even when the product endpoint executes them', async () => {
    booted = await bootApp({ actions: 'execute' });
    expect(await toolNames(booted.url, 'dur-token')).not.toContain('durable_retry_run');
    const response = await rpc(
      `${booted.url}/mcp/agora`,
      callTool('durable_retry_run'),
      'dur-token',
    );
    const body = await response.json();
    expect(body.result.isError).toBe(true);
  });

  it('serves the actions of the libs or tools listed in devTools.actions', async () => {
    booted = await bootApp({ devTools: { actions: ['durable'] } });
    expect(await toolNames(booted.url, 'dur-token')).toContain('durable_retry_run');
    const response = await rpc(
      `${booted.url}/mcp/agora`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      'dur-token',
    );
    const retry = (await response.json()).result.tools.find(
      (tool: { name: string }) => tool.name === 'durable_retry_run',
    );
    expect(retry.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    const call = await rpc(`${booted.url}/mcp/agora`, callTool('durable_retry_run'), 'dur-token');
    expect((await call.json()).result.content[0].text).toBe('{"status":"retried"}');
  });
});

/** An OAuth-shaped product auth like meuprontoo's `meuprontooMcpAuth()`: `good` passes. */
const productAuth: McpAuth = {
  oauth: async () => ({
    issuer: 'https://idp.example.com/oidc',
    authorizationEndpoint: 'https://idp.example.com/oidc/auth',
    tokenEndpoint: 'https://idp.example.com/oidc/token',
    scopesSupported: ['openid'],
    resourceName: 'Product',
  }),
  async verify(token) {
    if (token !== 'good') throw new McpAuthError('invalid token');
    return {
      token,
      clientId: 'claude',
      scopes: [],
      extra: { actor: { id: 'u1', roles: ['ADMIN'] } },
    };
  },
};

describe('dev tools endpoint: next to a product endpoint (meuprontoo-like config)', () => {
  const productRegistry = async () => {
    const registry = new ToolRegistry();
    const { z } = await import('zod');
    registry.register(
      { name: 'listar_perfis', kind: 'read', description: 'profiles', inputSchema: z.object({}) },
      { execute: async () => [] },
    );
    registry.register(
      { name: 'marcar_dose', kind: 'action', description: 'dose', inputSchema: z.object({}) },
      { execute: async () => 'ok' },
    );
    return registry;
  };
  let throttled = 0;
  const productConfig = (): Partial<McpConfig> => ({
    name: 'meuprontoo',
    path: 'api/mcp',
    auth: productAuth,
    allowedTools: ['listar_perfis', 'marcar_dose'],
    actions: 'execute',
    stateless: true,
    middleware: [
      async (_ctx: HttpContext, next: () => Promise<void>) => {
        throttled++;
        return next();
      },
    ],
  });

  it('keeps the two apart: tools, auth, actions, middleware and metadata', async () => {
    throttled = 0;
    const registry = await productRegistry();
    booted = await bootApp(productConfig(), { registry });

    const product = await rpc(`${booted.url}/api/mcp`, listTools, 'good');
    const productTools = (await product.json()).result.tools.map((t: { name: string }) => t.name);
    expect(productTools.sort()).toEqual(['listar_perfis', 'marcar_dose']);
    expect(throttled).toBe(1);

    // The dev endpoint: no product auth, no product tools, no product actions, no throttle.
    expect(await toolNames(booted.url, 'dur-token')).toEqual([
      'durable_get_run',
      'durable_list_runs',
      'telescope_list_entries',
    ]);
    expect(throttled).toBe(1);
    // Product token means nothing here (durable's console does not accept it).
    expect(await toolNames(booted.url, 'good')).toEqual(['telescope_list_entries']);
    // A dev tool never enters the agent registry.
    expect(
      registry
        .allSpecs()
        .map((spec) => spec.name)
        .sort(),
    ).toEqual(['listar_perfis', 'marcar_dose']);
    // Without authkit, the dev endpoint is no OAuth protected resource.
    expect(
      (await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp/agora`)).status,
    ).toBe(404);
    expect((await fetch(`${booted.url}/.well-known/oauth-protected-resource/api/mcp`)).status).toBe(
      200,
    );
  });

  it('applies devTools.middleware to the dev endpoint only', async () => {
    let devHits = 0;
    booted = await bootApp({
      devTools: {
        middleware: [
          async (_ctx: HttpContext, next: () => Promise<void>) => {
            devHits++;
            return next();
          },
        ],
      },
    });
    await toolNames(booted.url);
    expect(devHits).toBe(1);
  });

  it('fails boot when devTools.path is a product endpoint path', async () => {
    await expect(
      bootApp(
        { ...productConfig(), devTools: { path: 'api/mcp' } },
        { registry: await productRegistry() },
      ),
    ).rejects.toThrow(/devTools.path "api\/mcp"/);
  });

  it('devTools: false mounts nothing and libs register nothing', async () => {
    booted = await bootApp({ devTools: false });
    expect(registered).toBe(false);
    expect(booted.app.container.hasBinding('agora.devTools')).toBe(false);
    expect((await rpc(`${booted.url}/mcp/agora`, listTools)).status).toBe(404);
  });

  it('serves under a custom path', async () => {
    booted = await bootApp({ devTools: { path: '/_dev/mcp/' } });
    expect(registered).toBe(true);
    const response = await rpc(`${booted.url}/_dev/mcp`, listTools);
    expect(response.status).toBe(200);
  });
});

// ── authkit sign-in ──────────────────────────────────────────────────────────

interface FakeToken {
  accountId: string;
  aud?: string;
  scope?: string;
  gty?: string;
  clientId?: string;
}

/** An authkit server in-process: tokens by value, accounts by id. */
function fakeAuthkit(tokens: (url: string) => Record<string, FakeToken>) {
  const accounts: Record<string, { id: string; email: string; globalRoles: string[] }> = {
    admin: { id: 'admin', email: 'admin@example.com', globalRoles: ['ADMIN'] },
    user: { id: 'user', email: 'user@example.com', globalRoles: [] },
  };
  return (url: () => string) => ({
    config: {
      get issuer() {
        return `${url()}/oidc`;
      },
      globalRolesClaim: 'roles',
      findAccount: async (id: string) => accounts[id] ?? null,
    },
    provider: {
      AccessToken: {
        async find(token: string) {
          const found = tokens(url())[token];
          if (found === undefined) return undefined;
          return { ...found, clientId: found.clientId ?? 'claude-code', isExpired: false };
        },
      },
    },
  });
}

/** A console gate written for browsers: `authkitDashboardAuthorize()`'s logic over `ctx.authkit`. */
const authkitAdminOnly = async (ctx: HttpContext): Promise<DevToolsDecision> => {
  const authkit = (
    ctx as unknown as {
      authkit?: { check(): Promise<boolean>; hasGlobalRole(role: string): boolean };
    }
  ).authkit;
  if (!authkit || !(await authkit.check())) return { allowed: false, reason: 'unauthenticated' };
  return authkit.hasGlobalRole('ADMIN')
    ? { allowed: true }
    : { allowed: false, reason: 'forbidden' };
};

describe('dev tools endpoint: sign-in through authkit', () => {
  const libs = (): DevToolsLib[] => [
    {
      lib: 'durable',
      title: 'Durable workflows',
      authorize: authkitAdminOnly,
      tools: [
        read('durable_list_runs', {
          run: async (_input, call) => ({ items: [], next: null, caller: call.caller }),
        }),
      ],
    },
    {
      lib: 'telescope',
      title: 'Telescope',
      authorize: byToken('tel-token'),
      tools: [read('telescope_list_entries')],
    },
  ];
  const tokens = (url: string): Record<string, FakeToken> => ({
    'at-admin': { accountId: 'admin', aud: `${url}/mcp/agora` },
    'at-user': { accountId: 'user', aud: `${url}/mcp/agora` },
    'at-product': { accountId: 'admin', aud: `${url}/api/mcp` },
    'at-gone': { accountId: 'deleted', aud: `${url}/mcp/agora` },
    'poppy-plain': { accountId: 'admin', aud: `${url}/mcp/agora`, gty: 'poppy', scope: 'openid' },
    'poppy-dev': {
      accountId: 'admin',
      aud: `${url}/mcp/agora`,
      gty: 'poppy',
      scope: 'openid agora:dev',
    },
  });

  it('serves its own protected-resource metadata and challenges with it', async () => {
    booted = await bootApp({}, { libs: libs(), authkit: fakeAuthkit(tokens) });
    const meta = await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp/agora`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      resource: `${booted.url}/mcp/agora`,
      authorization_servers: [`${booted.url}/oidc`],
      resource_name: 'Agora dev tools',
    });
    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@adonis-agora/oauth:resources')
    ] as Array<{ path?: string }>;
    expect(registry.some((r) => r.path === '/mcp/agora')).toBe(true);

    const anonymous = await rpc(`${booted.url}/mcp/agora`, listTools);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer realm="agora-dev", resource_metadata="${booted.url}/.well-known/oauth-protected-resource/mcp/agora"`,
    );
  });

  it('bridges the signed-in account to the console authorize, like a browser session', async () => {
    booted = await bootApp({}, { libs: libs(), authkit: fakeAuthkit(tokens) });
    expect(await toolNames(booted.url, 'at-admin')).toEqual(['durable_list_runs']);
    const call = await rpc(`${booted.url}/mcp/agora`, callTool('durable_list_runs'), 'at-admin');
    expect(JSON.parse((await call.json()).result.content[0].text).caller).toEqual({
      id: 'user:admin',
      via: 'session',
    });
    // signed in without the role → 403, like the console (not a 401: the person IS signed in)
    const user = await rpc(`${booted.url}/mcp/agora`, listTools, 'at-user');
    expect(user.status).toBe(403);
    // a console token still reaches its authorizeByToken console
    expect(await toolNames(booted.url, 'tel-token')).toEqual(['telescope_list_entries']);
  });

  it('refuses a token issued for another resource, or for an account that is gone', async () => {
    booted = await bootApp({}, { libs: libs(), authkit: fakeAuthkit(tokens) });
    const product = await rpc(`${booted.url}/mcp/agora`, listTools, 'at-product');
    expect(product.status).toBe(401);
    expect(product.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(product.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect((await rpc(`${booted.url}/mcp/agora`, listTools, 'at-gone')).status).toBe(401);
  });

  it('accepts a Poppy token only with the agora:dev scope', async () => {
    booted = await bootApp({}, { libs: libs(), authkit: fakeAuthkit(tokens) });
    const plain = await rpc(`${booted.url}/mcp/agora`, listTools, 'poppy-plain');
    expect(plain.status).toBe(403);
    expect(plain.headers.get('www-authenticate')).toContain(
      'error="insufficient_scope", scope="agora:dev"',
    );
    expect(await toolNames(booted.url, 'poppy-dev')).toEqual(['durable_list_runs']);
    const call = await rpc(`${booted.url}/mcp/agora`, callTool('durable_list_runs'), 'poppy-dev');
    expect((await call.json()).result.isError).toBeUndefined();
  });
});

describe('bridgeIdentity', () => {
  const identity = {
    userId: 'admin',
    email: 'a@example.com',
    globalRoles: ['ADMIN'],
    issuedAt: 0,
    expiresAt: 0,
    raw: {},
  };
  const appWithout = { container: { hasBinding: () => false } } as unknown as ApplicationService;

  it('sets ctx.authkit and re-authenticates an authkit_client default guard', async () => {
    const guard = {
      driverName: 'authkit_client',
      isAuthenticated: false,
      authenticationAttempted: true,
    };
    let checked = 0;
    const ctx = {
      auth: {
        use: () => guard,
        check: async () => {
          checked++;
          expect(guard.authenticationAttempted).toBe(false);
          return true;
        },
      },
    } as unknown as HttpContext;
    await bridgeIdentity(appWithout, ctx, identity);
    const authkit = (
      ctx as unknown as {
        authkit: { check(): Promise<boolean>; hasGlobalRole(r: string): boolean };
      }
    ).authkit;
    expect(await authkit.check()).toBe(true);
    expect(authkit.hasGlobalRole('ADMIN')).toBe(true);
    expect(checked).toBe(1);
  });

  it('builds the authenticator with the app authkit client when there is one', async () => {
    let resolved: unknown;
    const app = {
      container: {
        hasBinding: (name: string) => name === 'authkit.client',
        make: async () => ({
          async createAuthenticator(
            _ctx: unknown,
            options: {
              resolver: {
                resolver(rc: unknown): Promise<{ resolve(c: unknown): Promise<unknown> }>;
              };
            },
          ) {
            const resolver = await options.resolver.resolver({});
            resolved = await resolver.resolve({});
            return { fromClient: true };
          },
        }),
      },
    } as unknown as ApplicationService;
    const ctx = {} as HttpContext;
    await bridgeIdentity(app, ctx, identity);
    expect((ctx as unknown as { authkit: unknown }).authkit).toEqual({ fromClient: true });
    expect(resolved).toBe(identity);
  });
});
