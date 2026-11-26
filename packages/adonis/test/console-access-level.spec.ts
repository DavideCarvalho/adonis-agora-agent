// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentConsoleAuthorize,
  anyAuthorize,
  authorizeByToken,
  type ConsoleAuthorizeRequest,
} from '../src/console-authorize.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

/**
 * The governance console distinguishes reading from changing: a grant limited to reading
 * (`authorizeByToken`'s default, documented for MCP clients and scrapers) reads every table but
 * cannot change a model price. `authorize` is told which one a request is.
 */

interface Booted {
  url: string;
  pricing: InMemoryPricingStore;
  close(): Promise<void>;
}

async function boot(authorize: AgentConsoleAuthorize): Promise<Booted> {
  const store = new InMemoryAgentStore();
  const pricing = new InMemoryPricingStore();
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          store,
          actorResolver: {
            resolve: (ctx: HttpContext) => ({ id: ctx.request.header('x-actor') ?? 'anon' }),
          },
          governanceQueries: new InMemoryGovernanceQueries(store),
          pricingStore: pricing,
          dashboard: { authorize },
        },
      },
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
    pricing,
    async close() {
      await new Promise<void>((resolve) => node.close(() => resolve()));
      await app.terminate();
    },
  };
}

const price = { modelId: 'gpt-x', inputPricePer1m: 1, outputPricePer1m: 2 };

function call(booted: Booted, method: 'GET' | 'POST', headers: Record<string, string>) {
  return fetch(`${booted.url}/agent/governance/pricing`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(price) } : {}),
  });
}

let booted: Booted | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

describe('governance routes: read-level and write-level grants', () => {
  it('a read token (authorizeByToken default) reads prices but cannot change them', async () => {
    booted = await boot(authorizeByToken({ token: 'mcp-token' }));
    const bearer = { authorization: 'Bearer mcp-token' };
    expect((await call(booted, 'GET', bearer)).status).toBe(200);
    const refused = await call(booted, 'POST', bearer);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'forbidden' });
    expect(await booted.pricing.listCurrentPrices()).toEqual([]);
  });

  it("a token with `access: 'write'` changes prices", async () => {
    booted = await boot(authorizeByToken({ token: 'ops-token', access: 'write' }));
    const saved = await call(booted, 'POST', { authorization: 'Bearer ops-token' });
    expect(saved.status).toBe(200);
    expect(await booted.pricing.listCurrentPrices()).toMatchObject([{ modelId: 'gpt-x' }]);
  });

  it('anyAuthorize: the read token reads, the admin writes', async () => {
    booted = await boot(
      anyAuthorize(
        authorizeByToken({ token: 'mcp-token' }),
        (ctx) => ctx.request.header('x-actor') === 'admin',
      ),
    );
    expect((await call(booted, 'POST', { authorization: 'Bearer mcp-token' })).status).toBe(403);
    expect((await call(booted, 'POST', { 'x-actor': 'admin' })).status).toBe(200);
  });

  it('tells authorize whether the request reads or writes', async () => {
    const seen: ConsoleAuthorizeRequest[] = [];
    booted = await boot((_ctx, _actor, request) => {
      if (request) seen.push(request);
      return request?.action === 'read';
    });
    expect((await call(booted, 'GET', {})).status).toBe(200);
    expect((await call(booted, 'POST', {})).status).toBe(403);
    expect(seen).toEqual([{ action: 'read' }, { action: 'write' }]);
  });

  it("narrows this app's own changes to the viewer's capabilities, with the same wording", async () => {
    booted = await boot(() => ({ allowed: true, capabilities: ['agent:approvals:decide'] }));
    const refused = await call(booted, 'POST', {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: 'the viewer lacks agent:pricing:write' });
    expect((await call(booted, 'GET', {})).status).toBe(200);
    const apps = await (await fetch(`${booted.url}/agent/governance/apps`)).json();
    expect(apps.viewer).toEqual({ capabilities: ['agent:approvals:decide'] });
  });

  it('a wildcard, or no capabilities at all, keeps every change', async () => {
    booted = await boot(() => ({ allowed: true, capabilities: ['agent:console:*'] }));
    expect((await call(booted, 'POST', {})).status).toBe(200);
    await booted.close();
    booted = await boot(() => true);
    expect((await call(booted, 'POST', {})).status).toBe(200);
    const apps = await (await fetch(`${booted.url}/agent/governance/apps`)).json();
    expect(apps.viewer).toEqual({ capabilities: null });
  });

  it('`{ allowed: false, redirectTo }` sends a page to sign in and answers an API call 401', async () => {
    booted = await boot(() => ({ allowed: false, redirectTo: '/login' }));
    const page = await fetch(`${booted.url}/agent/governance/pricing`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login');
    await page.text();
    const api = await call(booted, 'GET', { accept: 'application/json' });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'unauthenticated', redirectTo: '/login' });
  });
});
