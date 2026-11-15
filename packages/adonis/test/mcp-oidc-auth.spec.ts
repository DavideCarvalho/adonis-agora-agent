// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authkitDashboardAuthorize } from '@adonis-agora/authkit-client';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jwtAuth } from '../src/dev-tools/auth.js';
import type { DevTool, DevToolsLib } from '../src/dev-tools/contract.js';
import { registerDevTools } from '../src/dev-tools/index.js';
import { anyOf, apiKeyAuth, McpAuthError, resolveMcpAuth } from '../src/mcp/auth.js';
import type { McpConfig } from '../src/mcp/define_config.js';
import { oidcAuth } from '../src/mcp/oidc-auth.js';

/**
 * The remote half of the topology spec (§C): product MCP endpoints verify JWTs of an authkit that
 * runs elsewhere (`oidcAuth`), and the dev hub's `jwtAuth` bridges the caller into `ctx.authkit`, so
 * a console gated by `authkitDashboardAuthorize` accepts it. No authkit-server in the app: the issuer
 * is an in-memory OIDC discovery + JWKS server.
 */

// ── the remote issuer ───────────────────────────────────────────────────────

let issuerServer: Server;
let issuer = '';
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;

function serveIssuer(req: IncomingMessage, res: ServerResponse) {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/.well-known/openid-configuration') {
    return json(200, {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
    });
  }
  if (req.url === '/jwks') return json(200, { keys: [{ ...publicJwk, kid: 'k1', alg: 'ES256' }] });
  json(404, {});
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  otherKey = (await generateKeyPair('ES256')).privateKey;
  issuerServer = createServer(serveIssuer);
  await new Promise<void>((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
});

function jwt(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; expiresIn?: string | number } = {},
) {
  return new SignJWT({ iss: issuer, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? privateKey);
}

// ── the app (no authkit-server) ─────────────────────────────────────────────

let libsToRegister: DevToolsLib[] = [];

class FakeLibProvider {
  constructor(protected app: ApplicationService) {}
  async boot() {
    for (const lib of libsToRegister) await registerDevTools(this.app as never, lib);
  }
}

interface Booted {
  url: string;
  app: ApplicationService;
  close(): Promise<void>;
}

let booted: Booted | undefined;

async function bootApp(
  mcp: (url: () => string) => Partial<McpConfig>,
  libs: DevToolsLib[] = [],
): Promise<Booted> {
  libsToRegister = libs;
  let url = '';
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => Promise.resolve({ default: FakeLibProvider }),
          () => import('../providers/mcp_provider.js'),
        ],
      },
      config: { mcp: { name: 'test', version: '0.0.0', ...mcp(() => url) } },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  const server = await app.container.make('server');
  server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
  await server.boot();
  const node = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  return {
    url,
    app,
    async close() {
      await app.terminate();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

function post(url: string, path: string, body: unknown, token?: string) {
  return fetch(`${url}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY];
});

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

// ── product endpoint: oidcAuth ──────────────────────────────────────────────

describe('oidcAuth on a product MCP endpoint (authkit on another server)', () => {
  it('advertises the remote issuer and challenges an anonymous caller with resource_metadata', async () => {
    booted = await bootApp(() => ({ auth: oidcAuth({ issuer }), stateless: true }));
    const meta = await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      resource: `${booted.url}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Agent MCP Server',
    });

    const anonymous = await post(booted.url, 'mcp', initialize);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${booted.url}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('accepts a token issued for the endpoint, with no authkit-server in the app', async () => {
    booted = await bootApp(() => ({ auth: oidcAuth({ issuer }), stateless: true }));
    expect(booted.app.container.hasBinding('authkit.server' as never)).toBe(false);
    const token = await jwt({ sub: 'u-1', aud: `${booted.url}/mcp`, roles: ['ADMIN'] });
    const response = await post(booted.url, 'mcp', initialize, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: 'test' } } });
  });

  it('refuses another audience, an expired or forged token: 401 invalid_token', async () => {
    booted = await bootApp(() => ({ auth: oidcAuth({ issuer }), stateless: true }));
    const aud = `${booted.url}/mcp`;
    const tokens = [
      await jwt({ sub: 'u-1', aud: `${booted.url}/mcp/agora` }),
      await jwt({ sub: 'u-1', aud }, { expiresIn: Math.floor(Date.now() / 1000) - 3600 }),
      await jwt({ sub: 'u-1', aud }, { key: otherKey }),
    ];
    for (const token of tokens) {
      const response = await post(booted.url, 'mcp', initialize, token);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", resource_metadata="${booted.url}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
  });

  it('a token of another issuer is not its own: anyOf hands it to the next strategy', async () => {
    booted = await bootApp(() => ({
      auth: anyOf(oidcAuth({ issuer }), apiKeyAuth({ apiKeys: ['machine-key'] })),
      stateless: true,
    }));
    expect((await post(booted.url, 'mcp', initialize, 'machine-key')).status).toBe(200);
    const foreign = await new SignJWT({ iss: 'https://elsewhere.example.com', sub: 'x' })
      .setProtectedHeader({ alg: 'ES256' })
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await post(booted.url, 'mcp', initialize, foreign)).status).toBe(401);
  });

  it('requiredScopes: a token without them is a 403 insufficient_scope', async () => {
    booted = await bootApp(() => ({
      auth: oidcAuth({ issuer, requiredScopes: ['mcp'] }),
      stateless: true,
    }));
    const aud = `${booted.url}/mcp`;
    const without = await post(booted.url, 'mcp', initialize, await jwt({ sub: 'u', aud }));
    expect(without.status).toBe(403);
    expect(without.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    const withScope = await jwt({ sub: 'u', aud, scope: 'openid mcp' });
    expect((await post(booted.url, 'mcp', initialize, withScope)).status).toBe(200);
  });

  it('honours an explicit resource (the URL listed in authkit mcpClients.resources)', async () => {
    booted = await bootApp(() => ({
      auth: oidcAuth({ issuer, resource: 'https://agent.example.com/mcp' }),
      stateless: true,
    }));
    const ok = await jwt({ sub: 'u', aud: 'https://agent.example.com/mcp' });
    expect((await post(booted.url, 'mcp', initialize, ok)).status).toBe(200);
    const local = await jwt({ sub: 'u', aud: `${booted.url}/mcp` });
    expect((await post(booted.url, 'mcp', initialize, local)).status).toBe(401);
  });
});

describe('oidcAuth.verify', () => {
  const resource = 'https://agent.example.com/mcp';
  const app = {} as ApplicationService;

  it('maps the token to the actor, keeps the impersonator as `act`, and bridges ctx.authkit', async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    const ctx = {} as HttpContext;
    const token = await jwt({
      sub: 'u-1',
      aud: resource,
      email: 'u1@example.com',
      roles: ['ADMIN'],
      client_id: 'claude',
      act: { sub: 'admin-9', email: 'admin@example.com' },
    });
    const info = await auth.verify(token, { resource, ctx });
    expect(info.extra.actor).toEqual({ id: 'u-1', roles: ['ADMIN'] });
    expect(info.extra.act).toEqual({ sub: 'admin-9', email: 'admin@example.com' });
    expect(info.clientId).toBe('claude');
    const authkit = (ctx as unknown as { authkit: { getIdentity(): Promise<unknown> } }).authkit;
    expect(await authkit.getIdentity()).toMatchObject({
      userId: 'u-1',
      email: 'u1@example.com',
      globalRoles: ['ADMIN'],
      actor: { sub: 'admin-9', email: 'admin@example.com' },
    });
  });

  it('a self-referential act is not an impersonation', async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    const info = await auth.verify(await jwt({ sub: 'u', aud: resource, act: { sub: 'u' } }), {
      resource,
    });
    expect(info.extra.act).toBeUndefined();
  });

  it('does not bridge a client_credentials token, nor with authkit: false', async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    const machine = {} as HttpContext;
    await auth.verify(await jwt({ sub: 'svc', client_id: 'svc', aud: resource }), {
      resource,
      ctx: machine,
    });
    expect((machine as { authkit?: unknown }).authkit).toBeUndefined();

    const off = await resolveMcpAuth(oidcAuth({ issuer, authkit: false }), { app });
    const ctx = {} as HttpContext;
    await off.verify(await jwt({ sub: 'u', aud: resource }), { resource, ctx });
    expect((ctx as { authkit?: unknown }).authkit).toBeUndefined();
  });

  it("runs the app's resolveUser only for a token with an email (never mirrors an empty one)", async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    const built: unknown[] = [];
    let checks = 0;
    const requestCtx = () =>
      ({
        containerResolver: {
          make: async () => ({
            async createAuthenticator(_ctx: unknown, options: unknown) {
              built.push(options);
              return { fromApp: true };
            },
          }),
        },
        auth: {
          use: () => ({ driverName: 'authkit_client', isAuthenticated: false }),
          check: async () => {
            checks++;
            return true;
          },
        },
      }) as unknown as HttpContext;

    const bare = requestCtx();
    await auth.verify(await jwt({ sub: 'u', aud: resource, roles: ['ADMIN'] }), {
      resource,
      ctx: bare,
    });
    expect(built).toHaveLength(0);
    expect(checks).toBe(0);
    const identity = await (
      bare as unknown as { authkit: { getIdentity(): Promise<{ globalRoles: string[] }> } }
    ).authkit.getIdentity();
    expect(identity.globalRoles).toEqual(['ADMIN']);

    const full = requestCtx();
    await auth.verify(await jwt({ sub: 'u', aud: resource, email: 'u@example.com' }), {
      resource,
      ctx: full,
    });
    expect(built).toHaveLength(1);
    expect((full as unknown as { authkit: unknown }).authkit).toEqual({ fromApp: true });
    expect(checks).toBe(1);
  });

  it('a recognized-but-refused token is an McpAuthError; a foreign one a plain Error', async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    await expect(
      auth.verify(await jwt({ sub: 'u', aud: 'https://other.example.com' }), { resource }),
    ).rejects.toBeInstanceOf(McpAuthError);
    const error = await auth.verify('not-a-jwt', { resource }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McpAuthError);
  });

  it('a Poppy token gets the personal-agent roles', async () => {
    const auth = await resolveMcpAuth(oidcAuth({ issuer }), { app });
    const info = await auth.verify(
      await jwt({ sub: 'u', aud: resource, gty: 'poppy', scope: 'notes' }),
      { resource },
    );
    expect(info.extra.actor.roles).toEqual(expect.arrayContaining(['personal_agent']));
  });

  it('rejects a non-URL issuer at config time', () => {
    expect(() => oidcAuth({ issuer: 'id.example.com' })).toThrow(/absolute http\(s\) URL/);
  });
});

// ── dev hub: jwtAuth → authkitDashboardAuthorize ────────────────────────────

describe('dev hub jwtAuth with a remote authkit', () => {
  const seenCallers: unknown[] = [];
  const tool: DevTool = {
    name: 'durable_list_runs',
    kind: 'read',
    description: 'test',
    input: { type: 'object', properties: {} },
    run: async (_input, call) => {
      seenCallers.push(call.caller);
      return { items: [] };
    },
  };
  const consoleLib = (): DevToolsLib => ({
    lib: 'durable',
    title: 'Durable',
    // The gate a console uses with authkit, unchanged: it reads `ctx.authkit`.
    authorize: authkitDashboardAuthorize() as NonNullable<DevToolsLib['authorize']>,
    tools: [tool],
  });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const call = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'durable_list_runs', arguments: {} },
  };

  beforeEach(() => {
    seenCallers.length = 0;
  });

  it('a console gated by authkitDashboardAuthorize accepts an ADMIN token, refuses the rest', async () => {
    booted = await bootApp(() => ({ devTools: { auth: jwtAuth({ issuer }) } }), [consoleLib()]);
    const aud = `${booted.url}/mcp/agora`;

    const admin = await post(
      booted.url,
      'mcp/agora',
      list,
      await jwt({ sub: 'u-1', aud, roles: ['ADMIN'] }),
    );
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['durable_list_runs']);

    const member = await post(booted.url, 'mcp/agora', list, await jwt({ sub: 'u-2', aud }));
    expect(member.status).toBe(403);

    expect((await post(booted.url, 'mcp/agora', list)).status).toBe(401);
  });

  it('without the bridge (authkit: false) the same console refuses the caller', async () => {
    booted = await bootApp(
      () => ({ devTools: { auth: jwtAuth({ issuer, authkit: false }) } }),
      [consoleLib()],
    );
    const token = await jwt({ sub: 'u-1', aud: `${booted.url}/mcp/agora`, roles: ['ADMIN'] });
    const response = await post(booted.url, 'mcp/agora', list, token);
    expect(response.status).not.toBe(200);
  });

  it('audits an impersonation by the real actor, on behalf of the subject', async () => {
    booted = await bootApp(() => ({ devTools: { auth: jwtAuth({ issuer }) } }), [consoleLib()]);
    const token = await jwt({
      sub: 'u-1',
      aud: `${booted.url}/mcp/agora`,
      roles: ['ADMIN'],
      act: { sub: 'admin-9' },
    });
    const response = await post(booted.url, 'mcp/agora', call, token);
    expect(response.status).toBe(200);
    expect(seenCallers).toEqual([{ id: 'user:admin-9', via: 'session', onBehalfOf: 'user:u-1' }]);
  });
});
