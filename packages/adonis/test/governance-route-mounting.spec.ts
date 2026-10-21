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
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
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
    return {
      items: [],
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    } as unknown as ListRunsResult;
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

async function bootApp(
  governanceAuthorize?: AgentGovernanceAuthorize,
  governanceQueries?: AgentGovernanceQueries,
): Promise<BootedApp> {
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
          governanceQueries: governanceQueries ?? governance,
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

  it('serves GET governance/reliability with turn latency, failures by code and tool percentiles', async () => {
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1' };
    const thread = await store.createThread({ actor, persona: 'default', title: 'T' });
    await store.recordRunStart({ runId: 'r1', threadId: thread.id, actor });
    await store.recordRunEnd({
      runId: 'r1',
      status: 'completed',
      ttftMs: 250,
      modelId: 'gpt-test',
    });
    await store.recordRunStart({ runId: 'r2', threadId: thread.id, actor });
    await store.recordRunEnd({
      runId: 'r2',
      status: 'failed',
      error: 'x',
      errorCode: 'run_failed',
    });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'a',
      runId: 'r1',
    });
    await store.recordToolCall({
      toolCallId: 'c1',
      messageId: message.id,
      toolName: 'lookup',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
      runId: 'r1',
    });
    await store.updateToolCall({ toolCallId: 'c1', status: 'executed', executionMs: 75 });
    booted = await bootApp(() => true, new InMemoryGovernanceQueries(store));

    const reliability = await (
      await fetch(`${booted.url}/agent/governance/reliability`, asActor('staff-1', 'ADMIN'))
    ).json();
    expect(reliability.latency.ttft).toEqual({ samples: 1, p50Ms: 250, p95Ms: 250 });
    expect(reliability.latency.duration.samples).toBe(1);
    expect(reliability.failuresByCode).toEqual([{ code: 'run_failed', count: 1 }]);

    const tools = await (
      await fetch(`${booted.url}/agent/governance/tools/stats`, asActor('staff-1', 'ADMIN'))
    ).json();
    expect(tools).toEqual([
      expect.objectContaining({ toolName: 'lookup', p50ExecutionMs: 75, p95ExecutionMs: 75 }),
    ]);
  });

  it('serves GET governance/genui from the governance queries over the requested range', async () => {
    const store = new InMemoryAgentStore();
    const base = {
      threadId: 't1',
      actorRef: 'u1',
      step: 0,
      channel: 'web',
      mode: 'tree' as const,
      modelId: 'gpt-test',
      inputTokens: 10,
      outputTokens: 5,
      payloadBytes: 100,
    };
    await store.recordGenuiCalls([
      {
        ...base,
        toolCallId: 'c1',
        runId: 'r1',
        toolName: 'ui__render',
        attempt: 1,
        outcome: 'error',
        validity: 'failed',
        errorCategory: 'shape',
        errorMessage: 'invalid UI tree: bad',
        costUsd: 0.01,
      },
      {
        ...base,
        toolCallId: 'c2',
        runId: 'r1',
        step: 1,
        toolName: 'ui__render',
        attempt: 2,
        outcome: 'ok',
        validity: 'retried',
        costUsd: 0.02,
        firstFrameMs: 300,
        completeFrameMs: 900,
      },
    ]);
    booted = await bootApp(() => true, new InMemoryGovernanceQueries(store));
    const today = new Date().toISOString().slice(0, 10);

    const response = await fetch(
      `${booted.url}/agent/governance/genui?from=${today}&to=${today}`,
      asActor('staff-1', 'ADMIN'),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totals).toEqual(
      expect.objectContaining({ calls: 2, turns: 1, firstAttempts: 1, retried: 1, failed: 1 }),
    );
    expect(body.byToolModel).toEqual([
      expect.objectContaining({ toolName: 'ui__render', modelId: 'gpt-test', calls: 2 }),
    ]);
    expect(body.errors).toEqual([
      expect.objectContaining({ category: 'shape', toolName: 'ui__render', count: 1 }),
    ]);
    expect(body.byDay).toEqual([expect.objectContaining({ day: today, calls: 2, turns: 1 })]);
    expect(body.latency.complete).toEqual({ samples: 1, p50Ms: 900, p95Ms: 900 });

    // Default range is today, like the spend routes; a range without the rows is empty.
    const defaulted = await (
      await fetch(`${booted.url}/agent/governance/genui`, asActor('staff-1', 'ADMIN'))
    ).json();
    expect(defaulted.totals.calls).toBe(2);
    const empty = await (
      await fetch(
        `${booted.url}/agent/governance/genui?from=2000-01-01&to=2000-01-02`,
        asActor('staff-1', 'ADMIN'),
      )
    ).json();
    expect(empty.totals.calls).toBe(0);
    expect(empty.byToolModel).toEqual([]);
  });

  it('answers 501 on GET governance/genui when the governance queries lack genuiStats', async () => {
    booted = await bootApp(() => true);

    const response = await fetch(
      `${booted.url}/agent/governance/genui`,
      asActor('staff-1', 'ADMIN'),
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ message: expect.stringContaining('generative UI') });
  });

  it('gates GET governance/genui like every governance route (404 unmounted, 403 denied)', async () => {
    booted = await bootApp();
    expect((await fetch(`${booted.url}/agent/governance/genui`, asActor('p1'))).status).toBe(404);
    await booted.close();
    booted = await bootApp((actor) => actor.roles?.includes('ADMIN') ?? false);
    expect((await fetch(`${booted.url}/agent/governance/genui`, asActor('p1'))).status).toBe(403);
  });
});
