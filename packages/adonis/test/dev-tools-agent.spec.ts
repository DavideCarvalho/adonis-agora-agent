// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { afterEach, describe, expect, it } from 'vitest';
import type { ListRunsResult, RunDetail } from '../src/index.js';
import { authorizeByToken } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

/**
 * The agent's own governance tools on `/mcp/agora`: registered by `agent_provider` into the hub that
 * `mcp_provider` binds, gated by `dashboard.authorize`, returning what the console's routes return.
 */

class Governance extends InMemoryGovernanceQueries {
  override async listRuns(): Promise<ListRunsResult> {
    return {
      items: [
        {
          runId: 'r1',
          threadId: 't1',
          actorRef: 'user:1',
          agentName: 'support',
          status: 'completed',
          startedAt: '2026-11-11T00:00:00.000Z',
        },
      ],
      nextCursor: 'c2',
      prevCursor: null,
      hasNext: true,
      hasPrev: false,
    } as unknown as ListRunsResult;
  }
  override async runDetail(): Promise<RunDetail | null> {
    return {
      run: { runId: 'r1', actorRef: 'user:1' },
      messages: [{ id: 'm1', role: 'user', content: 'x'.repeat(5000), createdAt: '' }],
      toolCalls: [],
      approvals: [],
      usage: [],
    } as unknown as RunDetail;
  }
}

interface Booted {
  url: string;
  close(): Promise<void>;
}

async function boot(agent: Record<string, unknown>): Promise<Booted> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [
          () => import('../providers/agent_provider.js'),
          () => import('../providers/mcp_provider.js'),
        ],
      },
      config: {
        mcp: { name: 'test', version: '0.0.0' },
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: { resolve: () => ({ id: 'admin', roles: ['ADMIN'] }) },
          governanceQueries: new Governance(new InMemoryAgentStore()),
          ...agent,
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
    async close() {
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

const rpc = (url: string, body: unknown, token?: string) =>
  fetch(`${url}/mcp/agora`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

let booted: Booted | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

describe('the agent registers its governance tools', () => {
  const dashboard = { authorize: authorizeByToken({ token: 'console' }) };

  it('lists the seven read tools behind dashboard.authorize', async () => {
    booted = await boot({ dashboard });
    expect((await rpc(booted.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(
      401,
    );
    const list = await rpc(booted.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'console');
    const names = (await list.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(names.sort()).toEqual([
      'agent_get_reliability',
      'agent_get_run',
      'agent_get_spend',
      'agent_get_tool_stats',
      'agent_list_pending_approvals',
      'agent_list_recent_tool_calls',
      'agent_list_runs',
    ]);
  });

  it('agent_list_runs returns what GET /agent/governance/runs returns', async () => {
    booted = await boot({ dashboard });
    const route = await fetch(`${booted.url}/agent/governance/runs`, {
      headers: { authorization: 'Bearer console' },
    });
    const console = await route.json();
    const response = await rpc(booted.url, call('agent_list_runs'), 'console');
    const tool = JSON.parse((await response.json()).result.content[0].text);
    expect(tool).toEqual({ items: console.data, next: console.meta.nextCursor });
  });

  it('agent_get_run leaves messages out unless asked, then cuts each to 2 KB', async () => {
    booted = await boot({ dashboard });
    const without = await rpc(booted.url, call('agent_get_run', { id: 'r1' }), 'console');
    const plain = JSON.parse((await without.json()).result.content[0].text);
    expect(plain.messages).toBeUndefined();
    expect(plain.messageCount).toBe(1);
    const withMessages = await rpc(
      booted.url,
      call('agent_get_run', { id: 'r1', includeMessages: true }),
      'console',
    );
    const full = JSON.parse((await withMessages.json()).result.content[0].text);
    expect(Buffer.byteLength(full.messages[0].content)).toBeLessThanOrEqual(2048);
    expect(full.messages[0].content).toMatch(/truncated, 5000 bytes/);
  });

  it('registers nothing when the console is disabled', async () => {
    booted = await boot({ dashboard: { ...dashboard, enabled: false } });
    const response = await rpc(booted.url, call('agent_list_runs'), 'console');
    expect((await response.json()).result.isError).toBe(true);
  });
});
