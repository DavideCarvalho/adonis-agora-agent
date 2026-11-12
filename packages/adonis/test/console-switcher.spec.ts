// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGORA_CONSOLES_BINDING,
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  countOtherConsoles,
  listVisibleConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../src/console-switcher.js';
import {
  AGENT_CONSOLE_ID,
  agentConsoleDecision,
  registerAgentConsole,
  searchAgentConsole,
  switcherShellConfig,
} from '../src/dashboard/switcher.js';
import type { AgentGovernanceQueries, ListRunsResult, RunDetail } from '../src/index.js';
import { authorizeByToken } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';

function fakeApp(inProduction = false) {
  const values = new Map<string, unknown>();
  return {
    inProduction,
    values,
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => values.set(key, value),
      make: async (key: string) => values.get(key),
    },
  };
}

const ctx = () => ({ request: { header: () => undefined } }) as unknown as HttpContext;

const entry = (id: string, extra: Partial<AgoraConsoleEntry> = {}): AgoraConsoleEntry => ({
  id,
  title: id,
  icon: 'generic',
  path: `/${id}`,
  order: 50,
  authorize: async () => ({ allowed: true }),
  ...extra,
});

describe('registerAgoraConsole', () => {
  it('creates the binding when absent and reuses it (two copies, one registry)', async () => {
    const app = fakeApp();
    expect(await registerAgoraConsole(app, entry('durable'))).toBe(true);
    expect(await registerAgoraConsole(app, entry('agent'))).toBe(true);
    const registry = app.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    expect(registry.entries.map((e) => e.id)).toEqual(['durable', 'agent']);
    expect(countOtherConsoles(registry, 'agent')).toBe(1);
  });

  it('skips another version, warns on a duplicate id, rejects a bad id or path', async () => {
    const app = fakeApp();
    app.values.set(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    expect(await registerAgoraConsole(app, entry('agent'))).toBe(false);

    const other = fakeApp();
    const warn = vi.fn();
    await registerAgoraConsole(other, entry('agent'));
    expect(await registerAgoraConsole(other, entry('agent'), { warn })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();

    await expect(registerAgoraConsole(other, entry('Bad'))).rejects.toThrow(/must match/);
    await expect(
      registerAgoraConsole(other, entry('x', { path: '//evil.example' })),
    ).rejects.toThrow(/same-origin/);
  });
});

describe('listVisibleConsoles', () => {
  it('runs every gate in parallel, keeps the allowed, excludes self, sorted', async () => {
    vi.useFakeTimers();
    try {
      const registry: AgoraConsoleRegistry = {
        version: 1,
        entries: [
          entry('media', { order: 50 }),
          entry('agent', { order: 30 }),
          entry('durable', { order: 10, icon: 'nope' as never }),
          entry('payments', { order: 40, authorize: async () => ({ allowed: false }) }),
          entry('telescope', {
            order: 20,
            authorize: async () => ({ allowed: false, redirectTo: '/login' }),
          }),
          entry('slow', {
            order: 60,
            authorize: () =>
              new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 1000)),
          }),
          entry('boom', { order: 70, authorize: () => Promise.reject(new Error('x')) }),
        ],
      };
      const pending = listVisibleConsoles(registry, 'agent', ctx());
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      expect(result).toEqual({
        version: 1,
        current: 'agent',
        consoles: [
          { id: 'durable', title: 'durable', icon: 'generic', href: '/durable' },
          { id: 'media', title: 'media', icon: 'generic', href: '/media' },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks ctx.agoraProbe while the gates run', async () => {
    const seen: unknown[] = [];
    const c = ctx();
    await listVisibleConsoles(
      {
        version: 1,
        entries: [
          entry('durable', {
            authorize: async (inner) => {
              seen.push((inner as unknown as { agoraProbe?: boolean }).agoraProbe);
              return { allowed: true };
            },
          }),
        ],
      },
      'agent',
      c,
    );
    expect(seen).toEqual([true]);
    expect((c as unknown as { agoraProbe?: boolean }).agoraProbe).toBeUndefined();
  });
});

describe('searchConsoles', () => {
  it('searches self without its gate and others only when allowed; drops unsafe hits', async () => {
    const selfGate = vi.fn(async () => ({ allowed: false }));
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry('agent', {
          authorize: selfGate,
          search: async () => [{ title: 'Run r1', href: '/agent/dashboard#runs/r1' }],
        }),
        entry('durable', {
          search: async () => [
            { title: 'ok', href: '/durable#/runs/1' },
            { title: 'evil', href: 'javascript:alert(1)' },
          ],
        }),
        entry('payments', {
          authorize: async () => ({ allowed: false }),
          search: async () => [{ title: 'secret', href: '/payments' }],
        }),
      ],
    };
    const result = await searchConsoles(registry, 'agent', ctx(), 'r1');
    expect(selfGate).not.toHaveBeenCalled();
    expect(result.groups.map((g) => [g.id, g.hits.map((h) => h.title)])).toEqual([
      ['agent', ['Run r1']],
      ['durable', ['ok']],
    ]);
    expect((await searchConsoles(registry, 'agent', ctx(), '  ')).groups).toEqual([]);
  });
});

class Governance extends InMemoryGovernanceQueries {
  override async listRuns(filter?: { actor?: string; agent?: string }): Promise<ListRunsResult> {
    const rows =
      filter?.actor === 'user:7'
        ? [
            {
              runId: 'r9',
              agentName: 'support',
              status: 'failed',
              actorRef: 'user:7',
              startedAt: 'T',
            },
          ]
        : [];
    return {
      items: rows,
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    } as never;
  }
  override async runDetail(id: string): Promise<RunDetail | null> {
    if (id !== 'r1') return null;
    return {
      run: { runId: 'r1', agentName: 'support', status: 'completed', actorRef: 'user:1' },
    } as unknown as RunDetail;
  }
}

describe('the agent console in the switcher', () => {
  it('search: a run id opens it, an actor lists its runs', async () => {
    const gov = new Governance(new InMemoryAgentStore()) as unknown as AgentGovernanceQueries;
    expect(await searchAgentConsole(gov, '/agent/dashboard', 'r1', 5)).toEqual([
      {
        title: 'Run r1',
        subtitle: 'support · completed · user:1',
        href: '/agent/dashboard#runs/r1',
      },
    ]);
    expect(await searchAgentConsole(gov, '/agent/dashboard', 'user:7', 5)).toEqual([
      { title: 'support · failed', subtitle: 'user:7 · T', href: '/agent/dashboard#runs/r9' },
    ]);
    expect(await searchAgentConsole(gov, '/agent/dashboard', 'nothing', 5)).toEqual([]);
  });

  it('registers as Agents, order 30, gated by dashboard.authorize', async () => {
    const app = fakeApp();
    await registerAgentConsole(app, { mount: '/agent/dashboard', authorize: () => false });
    const registry = app.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    const agent = registry.entries[0] as AgoraConsoleEntry;
    expect(agent).toMatchObject({
      id: AGENT_CONSOLE_ID,
      title: 'Agents',
      package: '@adonis-agora/agent',
      icon: 'agent',
      path: '/agent/dashboard',
      order: 30,
    });
    expect(await agent.authorize(ctx())).toMatchObject({ allowed: false });
    expect(await agentConsoleDecision(ctx(), { inProduction: false }, {})).toEqual({
      allowed: true,
    });
    expect(await agentConsoleDecision(ctx(), { inProduction: true }, {})).toMatchObject({
      allowed: false,
    });
  });

  it('shell config: switcher only with other consoles, search when any is searchable', async () => {
    const app = fakeApp();
    expect(await switcherShellConfig(app, '/agent')).toEqual({});
    await registerAgentConsole(app, { mount: '/agent/dashboard' });
    expect(await switcherShellConfig(app, '/agent')).toEqual({
      search: { endpoint: '/agent/governance/consoles/search' },
    });
    await registerAgoraConsole(app, entry('durable'));
    expect(await switcherShellConfig(app, '/agent')).toEqual({
      switcher: { endpoint: '/agent/governance/consoles', others: 1 },
      search: { endpoint: '/agent/governance/consoles/search' },
    });
  });
});

describe('GET /agent/governance/consoles (HTTP)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function boot() {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [
            () => import('../providers/agent_provider.js'),
            () => import('../providers/dashboard_provider.js'),
          ],
        },
        config: {
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            actorResolver: { resolve: () => ({ id: 'admin', roles: ['ADMIN'] }) },
            governanceQueries: new Governance(new InMemoryAgentStore()),
            dashboard: { authorize: authorizeByToken({ token: 'console' }) },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    await registerAgoraConsole(
      app,
      entry('durable', { authorize: async () => ({ allowed: true }) }),
    );
    await registerAgoraConsole(
      app,
      entry('payments', { authorize: async () => ({ allowed: false }) }),
    );
    const server = await app.container.make('server');
    await server.boot();
    const node: Server = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => node.close(() => resolve()));
    return `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  }

  it('is behind the console gate and lists only the consoles the viewer may open', async () => {
    const url = await boot();
    const denied = await fetch(`${url}/agent/governance/consoles`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('durable');

    const ok = await fetch(`${url}/agent/governance/consoles`, {
      headers: { authorization: 'Bearer console' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(await ok.json()).toEqual({
      version: 1,
      current: 'agent',
      consoles: [{ id: 'durable', title: 'durable', icon: 'generic', href: '/durable' }],
    });

    const search = await fetch(`${url}/agent/governance/consoles/search?q=r1`, {
      headers: { authorization: 'Bearer console' },
    });
    expect(await search.json()).toEqual({
      version: 1,
      query: 'r1',
      groups: [
        {
          id: 'agent',
          title: 'Agents',
          icon: 'agent',
          hits: [
            {
              title: 'Run r1',
              subtitle: 'support · completed · user:1',
              href: '/agent/dashboard#runs/r1',
            },
          ],
        },
      ],
    });
  });
});
