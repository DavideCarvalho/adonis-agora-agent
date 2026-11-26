// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpAuth } from '../src/mcp/auth.js';
import type { McpConfig } from '../src/mcp/define_config.js';
import {
  McpSessionPool,
  mcpPrincipalOf,
  resolveMcpSessionLimits,
} from '../src/mcp/session-pool.js';

/**
 * MCP sessions are bound to the caller that opened them, capped per caller and per endpoint, and
 * closed when idle: a bearer holder looping `initialize` cannot grow memory without bound, and a
 * session id is useless to anyone else.
 */

/** `alice-*` and `bob` tokens, each its own actor. */
const auth: McpAuth = {
  async verify(token) {
    if (!token.startsWith('alice') && token !== 'bob') throw new Error('invalid token');
    return {
      token,
      clientId: 'claude',
      scopes: [],
      extra: { actor: { id: token.startsWith('alice') ? 'alice' : 'bob', roles: ['ADMIN'] } },
    };
  },
};

interface Booted {
  url: string;
  close(): Promise<void>;
}

async function bootApp(mcp: Partial<McpConfig>): Promise<Booted> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/mcp_provider.js')] },
      config: { mcp: { name: 'test', version: '0.0.0', auth, ...mcp } },
    })
    .create(new URL('../', import.meta.url));
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  const server = await app.container.make('server');
  server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
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

const headers = (token: string, session?: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
  ...(session !== undefined
    ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' }
    : {}),
});

async function initialize(booted: Booted, token: string): Promise<Response> {
  const response = await fetch(`${booted.url}/mcp`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    }),
  });
  await response.text();
  return response;
}

async function listTools(booted: Booted, token: string, session: string): Promise<Response> {
  const response = await fetch(`${booted.url}/mcp`, {
    method: 'POST',
    headers: headers(token, session),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  return response;
}

let booted: Booted | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

describe('mcp_provider sessions', () => {
  it('binds a session to the caller that opened it', async () => {
    booted = await bootApp({});
    const opened = await initialize(booted, 'alice-1');
    expect(opened.status).toBe(200);
    const session = opened.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();

    expect((await listTools(booted, 'alice-2', session)).status).toBe(200);
    const stolen = await listTools(booted, 'bob', session);
    expect(stolen.status).toBe(403);
    expect(await stolen.json()).toMatchObject({
      error: { message: expect.stringContaining('another caller') },
    });
    // GET (the SSE stream) and DELETE are bound the same way.
    const get = await fetch(`${booted.url}/mcp`, { headers: headers('bob', session) });
    expect(get.status).toBe(403);
    await get.text();
    const del = await fetch(`${booted.url}/mcp`, {
      method: 'DELETE',
      headers: headers('bob', session),
    });
    expect(del.status).toBe(403);
    await del.text();
  });

  it("caps each caller's sessions, closing its least recently used one", async () => {
    booted = await bootApp({ sessions: { maxPerPrincipal: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await initialize(booted, 'alice')).headers.get('mcp-session-id')!);
    }
    const first = await listTools(booted, 'alice', ids[0]!);
    expect(first.status).toBe(404);
    await first.text();
    expect((await listTools(booted, 'alice', ids[2]!)).status).toBe(200);
    // Bob is not affected by Alice's cap.
    expect((await initialize(booted, 'bob')).status).toBe(200);
  });

  it('refuses a new session past the endpoint cap with 503', async () => {
    booted = await bootApp({ sessions: { max: 1, maxPerPrincipal: 1 } });
    expect((await initialize(booted, 'alice')).status).toBe(200);
    const refused = await initialize(booted, 'bob');
    expect(refused.status).toBe(503);
  });

  it('refuses invalid limits at boot', async () => {
    await expect(bootApp({ sessions: { max: 0 } })).rejects.toThrow(/sessions.max/);
  });
});

describe('McpSessionPool', () => {
  const transport = () => {
    const t = {
      closed: 0,
      close: async () => {
        t.closed += 1;
      },
    };
    return t;
  };

  it('closes sessions idle past idleTimeoutMs', () => {
    let now = 0;
    const pool = new McpSessionPool({ idleTimeoutMs: 1_000 }, { now: () => now });
    const a = transport();
    pool.open('a', 'p', a);
    now = 500;
    expect(pool.get('a', 'p')).toBe(a);
    now = 1_400;
    expect(pool.get('a', 'p')).toBe(a); // used at 500: idle 900 ms
    now = 2_500;
    pool.sweep();
    expect(pool.size).toBe(0);
    expect(a.closed).toBe(1);
    expect(pool.get('a', 'p')).toBe('unknown');
  });

  it('frees idle sessions before refusing a new one', () => {
    let now = 0;
    const pool = new McpSessionPool(
      { max: 1, maxPerPrincipal: 1, idleTimeoutMs: 100 },
      { now: () => now },
    );
    pool.open('a', 'p', transport());
    expect(pool.open('b', 'q', transport())).toBe('full');
    now = 200;
    expect(pool.open('b', 'q', transport())).toBe(true);
  });

  it('keys a principal by client and actor', () => {
    const info = (clientId: string, id: string) =>
      ({ token: '', clientId, scopes: [], extra: { actor: { id } } }) as never;
    expect(mcpPrincipalOf(info('c', 'u'))).toBe(mcpPrincipalOf(info('c', 'u')));
    expect(mcpPrincipalOf(info('c', 'u'))).not.toBe(mcpPrincipalOf(info('d', 'u')));
    expect(resolveMcpSessionLimits(undefined)).toEqual({
      max: 1000,
      maxPerPrincipal: 16,
      idleTimeoutMs: 30 * 60_000,
    });
    expect(() => resolveMcpSessionLimits({ max: 2, maxPerPrincipal: 3 })).toThrow(/cannot exceed/);
  });
});
