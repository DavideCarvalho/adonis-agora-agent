import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/agent-service.js';
import { agentConsoleCommandHandler } from '../src/federation/console.js';
import { RedisConsoleChannel } from '../src/federation/redis_channel.js';
import type { AgentGovernanceQueries, ModelSpendRow } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryPricingStore } from '../src/testing/in-memory-pricing.js';
import type { Actor } from '../src/types.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * The federated agent console over HTTP: a real AdonisJS app (the console app) whose
 * `dashboard.apps` names another app. That app's governance read-model is read directly; its
 * approvals and prices go to it over a command channel (an in-memory Redis here, with `SET NX`).
 */

/** A governance read-model whose every rollup names the app it belongs to. */
function governanceOf(app: string): AgentGovernanceQueries {
  const empty = async () => [];
  return {
    spendByModel: async () =>
      [
        {
          model: `${app}-model`,
          runs: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cost: 0,
        },
      ] as unknown as ModelSpendRow[],
    spendByActor: empty,
    usageTrend: empty,
    recentToolCalls: empty,
    recentThreads: empty,
    listRuns: async () =>
      ({ items: [], nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false }) as never,
    runDetail: async () => null,
    pendingApprovals: empty,
    perToolStats: empty,
    runReliability: async () => ({
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      successRate: 0,
      failureRate: 0,
      cancelRate: 0,
      avgDurationMs: null,
    }),
  } as AgentGovernanceQueries;
}

/** The owning app's agent service, as far as settling a tool call goes. */
function owningService() {
  const calls = new Map([['call-1', { runId: 'run-1', owner: 'student-9' }]]);
  const approve = vi.fn(async () => {});
  const reject = vi.fn(async () => {});
  const service = {
    signalsReachOtherProcesses: true,
    toolCallRun: async (id: string) => calls.get(id)?.runId ?? null,
    toolCallApproval: async (id: string) =>
      calls.has(id) ? { status: 'pending_approval', approver: 'requester', expiresAt: null } : null,
    runOwner: async (runId: string) => (runId === 'run-1' ? 'student-9' : null),
    mayDecide: async () => false,
    approve,
    reject,
  } as unknown as AgentService;
  return { service, approve, reject };
}

const headerActorResolver = {
  resolve(req: unknown): Actor {
    const id = (req as HttpContext).request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    return { id, roles: ['ADMIN'] };
  },
};

interface Booted {
  url: string;
  close(): Promise<void>;
}

async function bootConsole(bus: RedisBus, dashboard: Record<string, unknown>): Promise<Booted> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: headerActorResolver,
          governanceQueries: governanceOf('hub'),
          dashboard: {
            appLabel: 'Hub',
            apps: {
              'entre-textos': {
                label: 'Entre Textos',
                governance: governanceOf('et'),
                pricing: etPricing,
                controlPlane: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
                timeoutMs: 2_000,
              },
            },
            ...dashboard,
          },
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
      await app.terminate();
    },
  };
}

let etPricing = new InMemoryPricingStore();
let booted: Booted | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
  etPricing = new InMemoryPricingStore();
});

const as = (id: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { 'x-actor-id': id, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

/** The owning app: `instances` web processes answering on the bus. */
async function owningApp(bus: RedisBus, instances = 1) {
  const owner = owningService();
  const lines: string[] = [];
  const runs: string[] = [];
  for (let i = 0; i < instances; i++) {
    const handler = agentConsoleCommandHandler({
      service: owner.service,
      pricing: etPricing,
      log: (line) => lines.push(line),
    });
    await new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }).answer(
      async (command) => {
        runs.push(command.verb);
        return handler(command);
      },
    );
  }
  return { ...owner, lines, runs };
}

describe('federated agent console', () => {
  it("lists the apps and reads the picked app's governance read-model", async () => {
    const bus = new RedisBus();
    booted = await bootConsole(bus, {});

    const apps = await fetch(`${booted.url}/agent/governance/apps`, as('ana'));
    expect(await apps.json()).toEqual({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: null,
    });

    const own = await fetch(`${booted.url}/agent/governance/spend/model`, as('ana'));
    expect((await own.json())[0].model).toBe('hub-model');
    const other = await fetch(
      `${booted.url}/agent/governance/spend/model?app=entre-textos`,
      as('ana'),
    );
    expect((await other.json())[0].model).toBe('et-model');

    const unknown = await fetch(`${booted.url}/agent/governance/spend/model?app=nope`, as('ana'));
    expect(unknown.status).toBe(404);

    const tenants = await fetch(
      `${booted.url}/agent/governance/tenants?app=entre-textos`,
      as('ana'),
    );
    expect(await tenants.json()).toMatchObject({ enabled: false });
  });

  it('hides the apps an authorize grant does not name', async () => {
    const bus = new RedisBus();
    booted = await bootConsole(bus, { authorize: () => ({ allowed: true, apps: [] }) });
    const apps = await fetch(`${booted.url}/agent/governance/apps`, as('ana'));
    expect((await apps.json()).apps).toEqual([]);
    const other = await fetch(
      `${booted.url}/agent/governance/spend/model?app=entre-textos`,
      as('ana'),
    );
    expect(other.status).toBe(404);
  });

  it('settles a pending call in the owning app, once, with the console viewer as the actor', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, 3);
    booted = await bootConsole(bus, {});

    const approved = await fetch(
      `${booted.url}/agent/tool-call/approve?app=entre-textos`,
      as('ana', { method: 'POST', body: JSON.stringify({ runId: 'run-1', toolCallId: 'call-1' }) }),
    );
    expect(approved.status).toBe(200);
    expect(owner.approve).toHaveBeenCalledTimes(1);
    expect(owner.approve).toHaveBeenCalledWith('run-1', 'call-1', {
      executedByRef: 'ana',
      remember: false,
      via: 'web',
    });
    expect(owner.runs.filter((verb) => verb === 'decide')).toHaveLength(1);
    expect(owner.lines).toContain('[agent] federated console: approve call-1 by ana');

    const rejected = await fetch(
      `${booted.url}/agent/tool-call/reject?app=entre-textos`,
      as('ana', {
        method: 'POST',
        body: JSON.stringify({ toolCallId: 'call-1', reason: 'not now' }),
      }),
    );
    expect(rejected.status).toBe(200);
    expect(owner.reject).toHaveBeenCalledWith('run-1', 'call-1', 'not now', {
      executedByRef: 'ana',
      via: 'web',
    });

    // The owning app's own refusal keeps its status.
    const unknown = await fetch(
      `${booted.url}/agent/tool-call/approve?app=entre-textos`,
      as('ana', { method: 'POST', body: JSON.stringify({ toolCallId: 'call-404' }) }),
    );
    expect(unknown.status).toBe(404);
  });

  it("reads and changes the owning app's model prices", async () => {
    const bus = new RedisBus();
    await owningApp(bus);
    booted = await bootConsole(bus, {});

    const saved = await fetch(
      `${booted.url}/agent/governance/pricing?app=entre-textos`,
      as('ana', {
        method: 'POST',
        body: JSON.stringify({ modelId: 'gpt-x', inputPricePer1m: 1, outputPricePer1m: 2 }),
      }),
    );
    expect(saved.status).toBe(200);
    const listed = await fetch(
      `${booted.url}/agent/governance/pricing?app=entre-textos`,
      as('ana'),
    );
    expect(await listed.json()).toMatchObject([{ modelId: 'gpt-x' }]);
  });

  it('answers 503 naming the app when it does not listen, and reads keep working', async () => {
    const bus = new RedisBus();
    booted = await bootConsole(bus, {});
    const started = Date.now();
    const approved = await fetch(
      `${booted.url}/agent/tool-call/approve?app=entre-textos`,
      as('ana', { method: 'POST', body: JSON.stringify({ toolCallId: 'call-1' }) }),
    );
    expect(approved.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect((await approved.json()).message).toContain('Entre Textos');
    const other = await fetch(
      `${booted.url}/agent/governance/spend/model?app=entre-textos`,
      as('ana'),
    );
    expect(other.status).toBe(200);
  });
});
