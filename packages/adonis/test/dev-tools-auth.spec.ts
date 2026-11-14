// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindDevToolsPrincipal,
  type DevToolsAuth,
  devToolsPrincipal,
  discoverJwksUri,
  introspectionAuth,
  issuerMetadataUrls,
  jwtAuth,
} from '../src/dev-tools/auth.js';
import type { DevTool, DevToolsDecision, DevToolsLib } from '../src/dev-tools/contract.js';
import { registerDevTools } from '../src/dev-tools/index.js';
import type { McpConfig } from '../src/mcp/define_config.js';

/**
 * `devTools.auth` against a real AdonisJS app (mcp_provider + a fake lib provider) and an in-process
 * authorization server serving OIDC discovery, a JWKS and an introspection endpoint.
 */

// ── the authorization server ────────────────────────────────────────────────

let issuerServer: Server;
let issuer = '';
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;
const hits: string[] = [];
/** Opaque tokens the introspection endpoint knows. */
const opaque: Record<string, Record<string, unknown>> = {};

function serveIssuer(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '/';
  hits.push(url);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url === '/.well-known/openid-configuration') {
    return json(200, {
      issuer,
      jwks_uri: `${issuer}/keys`,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
    });
  }
  if (url === '/keys') return json(200, { keys: [{ ...publicJwk, kid: 'k1', alg: 'ES256' }] });
  if (url === '/introspect' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const basic = Buffer.from('hub:s3cret').toString('base64');
      if (req.headers.authorization !== `Basic ${basic}`) return json(401, {});
      const token = new URLSearchParams(body).get('token') ?? '';
      json(200, opaque[token] ?? { active: false });
    });
    return;
  }
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

async function jwt(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; expiresIn?: string | number } = {},
) {
  return new SignJWT({ iss: issuer, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? privateKey);
}

// ── the app ─────────────────────────────────────────────────────────────────

const read = (name: string, extra: Partial<DevTool> = {}): DevTool => ({
  name,
  kind: 'read',
  description: `${name} (test)`,
  input: { type: 'object', properties: {} },
  run: async (_input, call) => ({ items: [], next: null, caller: call.caller }),
  ...extra,
});

const seen: Array<{ principal: unknown; user: unknown }> = [];

/** An authorize reading the principal's roles, and recording what it saw. */
const adminByClaims = async (ctx: HttpContext): Promise<DevToolsDecision> => {
  const principal = devToolsPrincipal(ctx);
  seen.push({ principal, user: (ctx as unknown as { auth?: { user?: unknown } }).auth?.user });
  if (principal === undefined) return { allowed: false, reason: 'unauthenticated' };
  return principal.roles?.includes('admin') === true
    ? { allowed: true }
    : { allowed: false, reason: 'forbidden' };
};

/** An authorize written for `ctx.auth`, the way an app gates its consoles. */
const adminByAuthUser = async (ctx: HttpContext): Promise<DevToolsDecision> => {
  const auth = (ctx as unknown as { auth?: { check(): Promise<boolean>; user?: unknown } }).auth;
  if (!auth || !(await auth.check())) return { allowed: false, reason: 'unauthenticated' };
  return (auth.user as { isAdmin?: boolean } | undefined)?.isAdmin === true
    ? { allowed: true }
    : { allowed: false, reason: 'forbidden' };
};

const byToken =
  (token: string) =>
  async (ctx: HttpContext): Promise<DevToolsDecision> =>
    ctx.request.header('authorization') === `Bearer ${token}`
      ? { allowed: true }
      : { allowed: false, reason: 'unauthenticated' };

function libs(): DevToolsLib[] {
  return [
    {
      lib: 'durable',
      title: 'Durable',
      authorize: adminByClaims,
      tools: [read('durable_list_runs')],
    },
    {
      lib: 'telescope',
      title: 'Telescope',
      authorize: byToken('console-token'),
      tools: [read('telescope_list_entries')],
    },
  ];
}

let libsToRegister: DevToolsLib[] = [];

class FakeLibProvider {
  constructor(protected app: ApplicationService) {}
  async boot() {
    for (const lib of libsToRegister) await registerDevTools(this.app as never, lib);
  }
}

interface Booted {
  url: string;
  close(): Promise<void>;
}

let booted: Booted | undefined;
const warnings: string[] = [];

async function bootApp(
  auth: (hub: () => string) => DevToolsAuth | Record<string, unknown>,
  options: { libs?: DevToolsLib[]; authkit?: unknown } = {},
): Promise<Booted> {
  libsToRegister = options.libs ?? libs();
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
      config: {
        mcp: {
          name: 'test',
          version: '0.0.0',
          devTools: { auth: auth(() => url) },
        } as Partial<McpConfig>,
      },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp('web');
  await app.init();
  if (options.authkit !== undefined) {
    app.container.bindValue('authkit.server' as never, options.authkit as never);
  }
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (_obj: unknown, msg: string) => warnings.push(msg),
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
  const node = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  return {
    url,
    async close() {
      await app.terminate();
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

function rpc(url: string, body: unknown, token?: string) {
  return fetch(`${url}/mcp/agora`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const callTool = (name: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: {} },
});

async function toolNames(url: string, token?: string): Promise<string[]> {
  const response = await rpc(url, listTools, token);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name).sort();
}

const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

beforeEach(() => {
  seen.length = 0;
  hits.length = 0;
  warnings.length = 0;
  delete (globalThis as Record<symbol, unknown>)[REGISTRY];
});

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const metadataUrl = (url: string) => `${url}/.well-known/oauth-protected-resource/mcp/agora`;

// ── tests ───────────────────────────────────────────────────────────────────

describe('devTools.auth: jwtAuth', () => {
  it('advertises the issuer, and challenges an anonymous caller with resource_metadata', async () => {
    booted = await bootApp(() => jwtAuth({ issuer, scopes: ['openid', 'agora:dev'] }));
    const meta = await fetch(metadataUrl(booted.url));
    expect(meta.status).toBe(200);
    expect(meta.headers.get('access-control-allow-origin')).toBe('*');
    expect(await meta.json()).toEqual({
      resource: `${booted.url}/mcp/agora`,
      authorization_servers: [issuer],
      scopes_supported: ['openid', 'agora:dev'],
      bearer_methods_supported: ['header'],
      resource_name: 'Agora dev tools',
    });

    const anonymous = await rpc(booted.url, listTools);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer realm="agora-dev", resource_metadata="${metadataUrl(booted.url)}"`,
    );
  });

  it('a valid token lists the tools, and authorize sees the claims; the call is audited by subject', async () => {
    booted = await bootApp(() => jwtAuth({ issuer }));
    const token = await jwt({ sub: 'u-1', aud: `${booted.url}/mcp/agora`, roles: ['admin'] });
    expect(await toolNames(booted.url, token)).toEqual(['durable_list_runs']);
    const principal = seen.at(-1)?.principal as {
      subject: string;
      roles: string[];
      claims: Record<string, unknown>;
    };
    expect(principal).toMatchObject({ subject: 'u-1', roles: ['admin'] });
    expect(principal.claims).toMatchObject({ iss: issuer, sub: 'u-1' });

    const call = await rpc(booted.url, callTool('durable_list_runs'), token);
    const result = JSON.parse((await call.json()).result.content[0].text);
    expect(result.caller).toEqual({ id: 'user:u-1', via: 'session' });
    // discovered once, keys cached
    expect(hits.filter((h) => h === '/.well-known/openid-configuration').length).toBe(1);
  });

  it('signed in without the role is a 403, not a login loop', async () => {
    booted = await bootApp(() => jwtAuth({ issuer }));
    const token = await jwt({ sub: 'u-2', aud: `${booted.url}/mcp/agora`, roles: [] });
    const response = await rpc(booted.url, listTools, token);
    expect(response.status).toBe(403);
  });

  it('wrong audience, expired or forged → 401 invalid_token with resource_metadata', async () => {
    booted = await bootApp(() => jwtAuth({ issuer }));
    const aud = `${booted.url}/mcp/agora`;
    const tokens = [
      await jwt({ sub: 'u-1', aud: `${booted.url}/mcp`, roles: ['admin'] }),
      await jwt(
        { sub: 'u-1', aud, roles: ['admin'] },
        { expiresIn: Math.floor(Date.now() / 1000) - 120 },
      ),
      await jwt({ sub: 'u-1', aud, roles: ['admin'] }, { key: otherKey }),
    ];
    for (const token of tokens) {
      const response = await rpc(booted.url, listTools, token);
      expect(response.status).toBe(401);
      const challenge = response.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(`resource_metadata="${metadataUrl(booted.url)}"`);
    }
  });

  it('a token of another issuer is not its own: 401 unless a console takes it', async () => {
    booted = await bootApp(() => jwtAuth({ issuer }));
    const foreign = await jwt({
      iss: 'https://elsewhere.example.com',
      sub: 'u-1',
      aud: `${booted.url}/mcp/agora`,
      roles: ['admin'],
    });
    const response = await rpc(booted.url, listTools, foreign);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // a console token (not a JWT) still reaches its authorizeByToken console
    expect(await toolNames(booted.url, 'console-token')).toEqual(['telescope_list_entries']);
  });

  it('an anonymous caller is sent to the login even when a console answers a bare false', async () => {
    booted = await bootApp(() => jwtAuth({ issuer }), {
      libs: [
        {
          lib: 'durable',
          title: 'Durable',
          authorize: async () => false,
          tools: [read('durable_list_runs')],
        } as never,
      ],
    });
    const response = await rpc(booted.url, listTools);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('resolveUser puts the user on ctx.auth for an authorize written against ctx.auth.user', async () => {
    const users: Record<string, { id: string; isAdmin: boolean }> = {
      'u-1': { id: 'u-1', isAdmin: true },
      'u-2': { id: 'u-2', isAdmin: false },
    };
    booted = await bootApp(
      () =>
        jwtAuth({
          issuer,
          jwksUri: `${issuer}/keys`,
          resolveUser: (claims) => users[String(claims.sub)] ?? null,
        }),
      {
        libs: [
          {
            lib: 'payments',
            title: 'Payments',
            authorize: adminByAuthUser,
            tools: [read('payments_list_charges')],
          },
        ],
      },
    );
    const aud = `${booted.url}/mcp/agora`;
    expect(await toolNames(booted.url, await jwt({ sub: 'u-1', aud }))).toEqual([
      'payments_list_charges',
    ]);
    expect((await rpc(booted.url, listTools, await jwt({ sub: 'u-2', aud }))).status).toBe(403);
    const gone = await rpc(booted.url, listTools, await jwt({ sub: 'u-9', aud }));
    expect(gone.status).toBe(401);
    expect(gone.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('requiredScopes: a token without them is a 403 insufficient_scope', async () => {
    booted = await bootApp(() => jwtAuth({ issuer, requiredScopes: ['agora:dev'] }));
    const aud = `${booted.url}/mcp/agora`;
    const plain = await rpc(
      booted.url,
      listTools,
      await jwt({ sub: 'u-1', aud, roles: ['admin'], scope: 'openid' }),
    );
    expect(plain.status).toBe(403);
    expect(plain.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(
      await toolNames(
        booted.url,
        await jwt({ sub: 'u-1', aud, roles: ['admin'], scope: 'openid agora:dev' }),
      ),
    ).toEqual(['durable_list_runs']);
  });

  it('with authkit installed, devTools.auth wins and the hub does not register with authkit', async () => {
    const authkit = {
      config: { issuer: 'http://authkit.local/oidc' },
      provider: { AccessToken: { find: async () => undefined } },
    };
    booted = await bootApp(() => jwtAuth({ issuer }), { authkit });
    const meta = (await (await fetch(metadataUrl(booted.url))).json()) as {
      authorization_servers: string[];
    };
    expect(meta.authorization_servers).toEqual([issuer]);
    const registry = (globalThis as Record<symbol, unknown>)[REGISTRY] as
      | Array<{ path?: string }>
      | undefined;
    expect(registry?.some((r) => r.path === '/mcp/agora') ?? false).toBe(false);
  });

  it('fails boot on a devTools.auth without verify', async () => {
    await expect(bootApp(() => ({ authorizationServers: [issuer] }))).rejects.toThrow(
      /devTools\.auth\.verify/,
    );
  });
});

describe('devTools.auth: introspectionAuth', () => {
  it('accepts an active token for this resource and refuses the rest', async () => {
    booted = await bootApp((hub) => {
      const resource = () => `${hub()}/mcp/agora`;
      opaque['op-admin'] = {
        active: true,
        sub: 'u-1',
        roles: ['admin'],
        get aud() {
          return resource();
        },
      };
      opaque['op-other'] = {
        active: true,
        sub: 'u-1',
        roles: ['admin'],
        aud: 'https://api.example.com',
      };
      return introspectionAuth({
        issuer,
        endpoint: `${issuer}/introspect`,
        clientId: 'hub',
        clientSecret: 's3cret',
      });
    });
    expect(await toolNames(booted.url, 'op-admin')).toEqual(['durable_list_runs']);
    expect((await rpc(booted.url, listTools, 'op-other')).status).toBe(401);
    const inactive = await rpc(booted.url, listTools, 'op-unknown');
    expect(inactive.status).toBe(401);
    expect(inactive.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('jwtAuth discovery', () => {
  it('tries OIDC discovery, then RFC 8414 for an issuer with a path', () => {
    expect(issuerMetadataUrls('https://id.example.com/realms/dev')).toEqual([
      'https://id.example.com/realms/dev/.well-known/openid-configuration',
      'https://id.example.com/.well-known/oauth-authorization-server/realms/dev',
      'https://id.example.com/realms/dev/.well-known/oauth-authorization-server',
    ]);
    expect(issuerMetadataUrls('https://tenant.auth0.com/')).toEqual([
      'https://tenant.auth0.com/.well-known/openid-configuration',
      'https://tenant.auth0.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('refuses metadata that names another issuer, and says to set jwksUri', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ issuer: 'https://evil.example.com', jwks_uri: 'x' }), {
        status: 200,
      })) as typeof fetch;
    await expect(discoverJwksUri('https://id.example.com', fake)).rejects.toThrow(/jwksUri/);
  });

  it('rejects a non-URL issuer at config time', () => {
    expect(() => jwtAuth({ issuer: 'id.example.com' })).toThrow(/absolute http\(s\) URL/);
  });
});

describe('bindDevToolsPrincipal', () => {
  it('overlays an @adonisjs/auth-like authenticator, keeping its own methods working', async () => {
    class Authenticator {
      #guard = 'web';
      user: unknown = undefined;
      authenticationAttempted = false;
      get defaultGuard() {
        return this.#guard;
      }
      use(name?: string) {
        return { name: name ?? this.#guard };
      }
      async check() {
        return false;
      }
    }
    const original = new Authenticator();
    const ctx = { auth: original } as unknown as HttpContext;
    const user = { id: 7, isAdmin: true };
    bindDevToolsPrincipal(ctx, { subject: '7', claims: { sub: '7' }, user });
    const auth = (ctx as unknown as { auth: Authenticator & { isAuthenticated: boolean } }).auth;
    expect(auth.user).toBe(user);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.authenticationAttempted).toBe(true);
    expect(await auth.check()).toBe(true);
    expect(auth.defaultGuard).toBe('web');
    expect(auth.use('api')).toEqual({ name: 'api' });
    expect(devToolsPrincipal(ctx)?.subject).toBe('7');
  });

  it('without a user, leaves ctx.auth alone', () => {
    const ctx = {} as HttpContext;
    bindDevToolsPrincipal(ctx, { subject: 's', claims: {} });
    expect((ctx as unknown as { auth?: unknown }).auth).toBeUndefined();
    expect(devToolsPrincipal(ctx)?.subject).toBe('s');
  });
});
