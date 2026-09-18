// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { afterEach, describe, expect, it } from 'vitest';
import { anyOf, apiKeyAuth, type McpAuth, McpAuthError } from '../src/mcp/auth.js';
import type { McpConfig } from '../src/mcp/define_config.js';

/**
 * Boots a real AdonisJS app with ONLY `providers/mcp_provider.ts` and hits `/mcp` over HTTP, to pin
 * what an MCP client sees when it is refused: the status, the `WWW-Authenticate` challenge that sends
 * it to the login, and the RFC 9728 document that challenge points at.
 *
 * The app has no body parser, so an authenticated POST reaches the transport with an empty body and is
 * answered `400 no valid session ID` — which is the observable for "the auth let it through".
 */

const oauthMeta = {
  issuer: 'https://idp.example.com/oidc',
  authorizationEndpoint: 'https://idp.example.com/oidc/auth',
  tokenEndpoint: 'https://idp.example.com/oidc/token',
  scopesSupported: ['openid', 'offline_access'],
  resourceName: 'Acme',
};

/** An OAuth-shaped strategy: `good` passes, `web` is a recognized-but-refused client, `weak` is a 403. */
const oauthAuth: McpAuth = {
  oauth: async () => oauthMeta,
  async verify(token) {
    if (token === 'web') throw new McpAuthError('token was not issued for MCP');
    if (token === 'weak') throw new McpAuthError('missing scope', { status: 403 });
    if (token !== 'good') throw new Error('invalid or expired access token');
    return {
      token,
      clientId: 'claude',
      scopes: [],
      extra: { actor: { id: 'u1', roles: ['ADMIN'] } },
    };
  },
};

interface BootedApp {
  url: string;
  close(): Promise<void>;
}

async function bootApp(mcp: Partial<McpConfig>): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/mcp_provider.js')] },
      config: { mcp: { name: 'test', version: '0.0.0', ...mcp } },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();

  const server = await app.container.make('server');
  await server.boot();
  const node: Server = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  const { port } = node.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
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

function post(booted: BootedApp, token?: string) {
  return fetch(`${booted.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(initialize),
  });
}

/** Passed auth: the request reached the transport (see the note on the empty body above). */
async function expectAuthenticated(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: 'Bad Request: no valid session ID' },
  });
}

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

describe('mcp_provider: the 401 sends the client to the login', () => {
  it('challenges a request with no token, pointing at the metadata (no error code)', async () => {
    booted = await bootApp({ auth: oauthAuth });
    const response = await post(booted);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${booted.url}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(await response.json()).toEqual({ error: 'missing bearer token' });
  });

  it('adds error="invalid_token" when the token was refused', async () => {
    booted = await bootApp({ auth: oauthAuth });
    const response = await post(booted, 'nope');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${booted.url}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('answers a typed refusal with its message, and a 403 with insufficient_scope', async () => {
    booted = await bootApp({ auth: oauthAuth });

    const refused = await post(booted, 'web');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'token was not issued for MCP' });

    const forbidden = await post(booted, 'weak');
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('www-authenticate')).toMatch(
      /^Bearer error="insufficient_scope", resource_metadata="/,
    );
  });

  it('lets a verified token through', async () => {
    booted = await bootApp({ auth: oauthAuth });
    const response = await post(booted, 'good');
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expectAuthenticated(response);
  });

  it('sends a bare Bearer challenge when the auth exposes no OAuth', async () => {
    booted = await bootApp({ auth: apiKeyAuth({ apiKeys: ['k1'] }) });
    const response = await post(booted, 'nope');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });
});

describe('mcp_provider: publicUrl', () => {
  it('builds the resource and the challenge from publicUrl, not from the request', async () => {
    booted = await bootApp({ auth: oauthAuth, publicUrl: 'https://app.example.com' });

    const challenge = (await post(booted)).headers.get('www-authenticate');
    expect(challenge).toBe(
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"',
    );

    const metadata = await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('access-control-allow-origin')).toBe('*');
    expect(await metadata.json()).toEqual({
      resource: 'https://app.example.com/mcp',
      authorization_servers: ['https://idp.example.com/oidc'],
      scopes_supported: ['openid', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'Acme',
    });
  });

  it('falls back to the request protocol and Host when publicUrl is unset', async () => {
    booted = await bootApp({ auth: oauthAuth });
    const metadata = await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp`);
    expect(((await metadata.json()) as { resource: string }).resource).toBe(`${booted.url}/mcp`);
  });

  it('refuses to boot with a publicUrl that carries a path', async () => {
    await expect(
      bootApp({ auth: oauthAuth, publicUrl: 'https://app.example.com/base' }),
    ).rejects.toThrow(/origin only/);
  });
});

describe('mcp_provider: anyOf', () => {
  it('accepts either strategy and still mounts the OAuth metadata of the one that has it', async () => {
    booted = await bootApp({ auth: anyOf(apiKeyAuth({ apiKeys: ['k1'] }), oauthAuth) });

    await expectAuthenticated(await post(booted, 'k1'));
    await expectAuthenticated(await post(booted, 'good'));

    const refused = await post(booted, 'web');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'token was not issued for MCP' });
    expect(refused.headers.get('www-authenticate')).toContain('resource_metadata=');

    const metadata = await fetch(`${booted.url}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
  });
});
