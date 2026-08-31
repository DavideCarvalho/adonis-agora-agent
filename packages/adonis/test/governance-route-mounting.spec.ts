import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActorSpendRow,
  AgentGovernanceAuthorize,
  AgentGovernanceQueries,
  ListRunsResult,
  ModelSpendRow,
  PendingApprovalRow,
  PendingApprovalsFilter,
  PerToolStatRow,
  RunDetail,
  RunReliability,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import type { Actor } from '../src/types.js';

/**
 * Boots a real AdonisJS app with the agent provider and hits the mounted routes over HTTP, so a route
 * that is NOT mounted answers with the router's own 404 (rather than a stubbed assertion about
 * registration). That distinction is the whole point of this file: fail-closed by omission.
 */

/** Minimal governance read-model: every cross-actor query returns a recognizable sentinel. */
class StubGovernanceQueries implements AgentGovernanceQueries {
  seenApprovalFilters: PendingApprovalsFilter[] = [];

  async spendByModel(): Promise<ModelSpendRow[]> {
    return [
      {
        model: 'gpt-test',
        runs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cost: 0,
      } as unknown as ModelSpendRow,
    ];
  }
  async spendByActor(): Promise<ActorSpendRow[]> {
    return [];
  }
  async usageTrend(): Promise<UsageTrendPoint[]> {
    return [];
  }
  async recentToolCalls(): Promise<ToolCallActivityRow[]> {
    return [];
  }
  async recentThreads(): Promise<ThreadActivityRow[]> {
    return [];
  }
  async listRuns(): Promise<ListRunsResult> {
    return { runs: [], nextCursor: null } as unknown as ListRunsResult;
  }
  async runDetail(): Promise<RunDetail | null> {
    return null;
  }
  async pendingApprovals(filter?: PendingApprovalsFilter): Promise<PendingApprovalRow[]> {
    this.seenApprovalFilters.push(filter ?? {});
    return [
      {
        toolCallId: `call-for-${filter?.actor ?? 'everyone'}`,
        toolName: 'refund',
        input: {},
        threadId: 't1',
        runId: 'r1',
        actorRef: filter?.actor ?? 'u-other',
        createdAt: new Date().toISOString(),
      } as unknown as PendingApprovalRow,
    ];
  }
  async perToolStats(): Promise<PerToolStatRow[]> {
    return [];
  }
  async runReliability(): Promise<RunReliability> {
    return {
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      successRate: 0,
      failureRate: 0,
      cancelRate: 0,
      avgDurationMs: null,
    };
  }
}

/** Reads the caller from `x-actor-id` / `x-actor-roles`; throws (→ 401) when absent. */
const headerActorResolver = {
  resolve(req: unknown): Actor {
    const ctx = req as HttpContext;
    const id = ctx.request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    const roles = (ctx.request.header('x-actor-roles') ?? '').split(',').filter(Boolean);
    return { id, roles };
  },
};

interface BootedApp {
  url: string;
  governance: StubGovernanceQueries;
  close(): Promise<void>;
}

async function bootApp(governanceAuthorize?: AgentGovernanceAuthorize): Promise<BootedApp> {
  const governance = new StubGovernanceQueries();
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [() => import('../providers/agent_provider.js')],
      },
      config: {
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: headerActorResolver,
          governanceQueries: governance,
          ...(governanceAuthorize !== undefined ? { governanceAuthorize } : {}),
        },
      },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  // `app.boot()` only — `app.start()` notifies the parent process (`process.send`), which the vitest
  // forks pool rejects. Routes are registered by the provider's `boot()`, so booting is enough.
  await app.boot();

  const server = await app.container.make('server');
  await server.boot();
  const node: Server = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  const { port } = node.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    governance,
    async close() {
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

const asActor = (id: string, roles = 'PATIENT') => ({
  headers: { 'x-actor-id': id, 'x-actor-roles': roles },
});

describe('governance route mounting', () => {
  it('does not mount the cross-actor governance routes when no gate is configured', async () => {
    booted = await bootApp();

    // A representative sample across the cross-actor block: rollups, activity feeds, the run
    // read-model and the platform-wide approvals inbox.
    for (const route of [
      'governance/spend/model',
      'governance/spend/actor',
      'governance/usage/trend',
      'governance/tool-calls/recent',
      'governance/threads/recent',
      'governance/runs',
      'governance/runs/r1',
      'governance/approvals/pending',
      'governance/tools/stats',
      'governance/reliability',
    ]) {
      const response = await fetch(`${booted.url}/agent/${route}`, asActor('patient-1'));
      expect(response.status, `GET /agent/${route}`).toBe(404);
    }
  });

  it('still mounts /agent/approvals/mine when no gate is configured, scoped to the caller', async () => {
    booted = await bootApp();

    const response = await fetch(`${booted.url}/agent/approvals/mine`, asActor('patient-1'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ actorRef: 'patient-1' })]);
    // The route must always constrain the inbox to the CALLING actor, never the whole platform.
    expect(booted.governance.seenApprovalFilters).toEqual([
      expect.objectContaining({ actor: 'patient-1' }),
    ]);
  });

  it('mounts the cross-actor routes behind the gate when one is configured (403 on deny)', async () => {
    booted = await bootApp((actor) => actor.roles?.includes('ADMIN') ?? false);

    const denied = await fetch(`${booted.url}/agent/governance/spend/model`, asActor('patient-1'));
    expect(denied.status).toBe(403);

    const allowed = await fetch(
      `${booted.url}/agent/governance/spend/model`,
      asActor('staff-1', 'ADMIN'),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([expect.objectContaining({ model: 'gpt-test' })]);
  });
});
