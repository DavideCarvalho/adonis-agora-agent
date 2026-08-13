import { describe, expect, it } from 'vitest';
import { agentDashboard } from '../../src/telescope/dashboard.js';
import {
  agentActiveRunsProvider,
  agentDelegationsOverTimeProvider,
  agentRecentApprovalsProvider,
  agentRecentDelegationsProvider,
  agentRecentRunsProvider,
  agentRecentToolCallsProvider,
  agentRunsOverTimeProvider,
  agentTokenUsageProvider,
  agentTokensOverTimeProvider,
  agentToolCallSuccessRateProvider,
  agentToolCallsOverTimeProvider,
} from '../../src/telescope/data-providers.js';
import { agentTelescopeExtension } from '../../src/telescope/extension.js';
import type {
  DataProvider,
  ExtensionContext,
  TelescopeEntryLike,
} from '../../src/telescope/telescope-sdk.js';

/**
 * A captured `agora:agent:<event>` diagnostic entry, exactly as `@adonis-agora/telescope`'s generic
 * diagnostics watcher records it: `content` is the `DiagnosticEntryContent` envelope with the agent
 * payload nested under `content.payload`, filed as `type: 'diagnostic'`, `tag: 'lib:agent'`.
 */
function entry(
  event: string,
  payload: Record<string, unknown> = {},
  createdAt = new Date(),
): TelescopeEntryLike {
  return { content: { v: 1, lib: 'agent', event, ts: +createdAt, payload }, createdAt };
}

/** An ExtensionContext over a fixed list of captured agent diagnostic entries. */
function makeCtx(entries: TelescopeEntryLike[] = []): ExtensionContext {
  return {
    store: {
      list: async (query) => {
        // Assert providers query the agent diagnostics slice, not everything.
        expect(query).toMatchObject({ type: 'diagnostic', tag: 'lib:agent' });
        return entries;
      },
    },
    container: { make: async () => undefined as never },
    config: {},
  };
}

describe('agentTelescopeExtension registration', () => {
  it('is a plain structural object (no @adonis-agora/telescope import needed)', () => {
    const ext = agentTelescopeExtension();
    expect(ext.name).toBe('agent');
    // Capture is handled by the generic diagnostics watcher, so no watcher/entryType is contributed.
    expect(ext.entryTypes).toBeUndefined();
    expect(typeof ext.dashboards).toBe('function');
    expect(typeof ext.dataProviders).toBe('function');
  });

  it('registers the "Agent" dashboard spec', () => {
    const ctx = makeCtx();
    const [dash] = agentTelescopeExtension().dashboards?.(ctx) ?? [];
    expect(dash?.id).toBe('agent.overview');
    expect(dash?.label).toBe('Agent');
    // Every panel binds to a provider the extension also registers.
    const providerNames = new Set(
      (agentTelescopeExtension().dataProviders?.(ctx) ?? []).map((p) => p.name),
    );
    const boundProviders = (dash?.sections ?? []).flatMap((s) =>
      s.panels.map((p) => p.data.provider),
    );
    for (const name of boundProviders) expect(providerNames.has(name)).toBe(true);
  });

  it('exposes the expected agent data-provider channels', () => {
    const names = (agentTelescopeExtension().dataProviders?.(makeCtx()) ?? []).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        // Entry-backed.
        'agent.activeRuns',
        'agent.tokenUsage',
        'agent.toolCallSuccessRate',
        'agent.runsOverTime',
        'agent.tokensOverTime',
        'agent.recentRuns',
        'agent.toolCallsOverTime',
        'agent.recentToolCalls',
        'agent.recentApprovals',
        'agent.delegationsOverTime',
        'agent.recentDelegations',
        // Governance-backed.
        'agent.spend.totalCost',
        'agent.spend.totalTokens',
        'agent.spend.byModel',
        'agent.spend.byModelTable',
        'agent.usage.trend',
        'agent.spend.byActor',
        'agent.spend.byActorShare',
        'agent.runs.total',
        'agent.runs.successRate',
        'agent.runs.failed',
        'agent.runs.duration',
        'agent.runs.byAgent',
        'agent.runs.trend',
        'agent.runs.recent',
        'agent.tools.recent',
        'agent.threads.recent',
        'agent.approvals.pending',
        'agent.approvals.recent',
        'agent.tools.stats',
        // RAG.
        'agent.rag.retrievals',
        'agent.rag.zeroHitRate',
        'agent.rag.chunks',
        'agent.rag.trend',
      ]),
    );
  });

  it('registers no duplicate provider names', () => {
    const names = (agentTelescopeExtension().dataProviders?.(makeCtx()) ?? []).map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('emits a LinkSpec on the run/thread columns when hrefs are configured', () => {
    const dash = agentDashboard({
      runHref: '/agent/runs/{runId}',
      threadHref: '/agent/threads/{thread}',
    });
    const columns = (dash.sections ?? []).flatMap((s) =>
      s.panels.flatMap((p) => (p.kind === 'table' ? p.columns : [])),
    );
    const runCol = columns.find((c) => c.key === 'runId');
    const threadCol = columns.find((c) => c.key === 'thread');
    expect(runCol?.link).toEqual({ href: '/agent/runs/{runId}' });
    expect(threadCol?.link).toEqual({ href: '/agent/threads/{thread}' });
  });

  it('omits the LinkSpec when no href is configured', () => {
    const dash = agentDashboard();
    const columns = (dash.sections ?? []).flatMap((s) =>
      s.panels.flatMap((p) => (p.kind === 'table' ? p.columns : [])),
    );
    expect(columns.find((c) => c.key === 'runId')?.link).toBeUndefined();
    expect(columns.find((c) => c.key === 'thread')?.link).toBeUndefined();
  });
});

describe('agent diagnostics events map to telescope entry shapes', () => {
  it('recentRuns maps a run.finished entry to a row (run/thread/steps/tokens from payload)', async () => {
    const ctx = makeCtx([
      entry('run.finished', {
        runId: 'r-1',
        threadId: 't-1',
        steps: 3,
        inputTokens: 100,
        outputTokens: 40,
      }),
      entry('run.started', { runId: 'r-2', threadId: 't-2', actorId: 'u-1' }),
    ]);
    const res = (await agentRecentRunsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ runId: string; thread: string; steps: number; tokens: number }>;
    };
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ runId: 'r-1', thread: 't-1', steps: 3, tokens: 140 });
  });

  it('activeRuns = run.started - run.finished, floored at 0', async () => {
    const ctx = makeCtx([
      entry('run.started', { runId: 'r-1' }),
      entry('run.started', { runId: 'r-2' }),
      entry('run.started', { runId: 'r-3' }),
      entry('run.finished', { runId: 'r-1' }),
    ]);
    const res = (await agentActiveRunsProvider().resolve(undefined, ctx)) as { value: number };
    expect(res.value).toBe(2);
  });

  it('tokenUsage sums input+output tokens from run.finished', async () => {
    const ctx = makeCtx([
      entry('run.finished', { runId: 'r-1', inputTokens: 100, outputTokens: 20 }),
      entry('run.finished', { runId: 'r-2', inputTokens: 30, outputTokens: 10 }),
    ]);
    const res = (await agentTokenUsageProvider().resolve(undefined, ctx)) as { value: number };
    expect(res.value).toBe(160);
  });

  it('toolCallSuccessRate = executed / (executed + rejected + failed)', async () => {
    const ctx = makeCtx([
      entry('tool-call', { toolName: 'a', toolType: 'read', status: 'executed' }),
      entry('tool-call', { toolName: 'b', toolType: 'read', status: 'executed' }),
      entry('tool-call', { toolName: 'c', toolType: 'action', status: 'rejected' }),
      entry('tool-call', { toolName: 'd', toolType: 'read', status: 'failed' }),
    ]);
    const res = (await agentToolCallSuccessRateProvider().resolve(undefined, ctx)) as {
      value: number;
    };
    expect(res.value).toBeCloseTo(0.5);
  });

  it('runsOverTime buckets started/finished', async () => {
    const ctx = makeCtx([entry('run.started'), entry('run.finished'), entry('run.finished')]);
    const res = (await agentRunsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ started: number; finished: number }>;
    };
    expect(res.rows[0]).toMatchObject({ started: 1, finished: 2 });
  });

  it('tokensOverTime buckets input/output tokens', async () => {
    const ctx = makeCtx([
      entry('run.finished', { inputTokens: 10, outputTokens: 5 }),
      entry('run.finished', { inputTokens: 20, outputTokens: 8 }),
    ]);
    const res = (await agentTokensOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ input: number; output: number }>;
    };
    expect(res.rows[0]).toMatchObject({ input: 30, output: 13 });
  });

  it('toolCallsOverTime buckets executed/rejected/failed', async () => {
    const ctx = makeCtx([
      entry('tool-call', { status: 'executed' }),
      entry('tool-call', { status: 'rejected' }),
      entry('tool-call', { status: 'failed' }),
      entry('tool-call', { status: 'executed' }),
    ]);
    const res = (await agentToolCallsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ executed: number; rejected: number; failed: number }>;
    };
    expect(res.rows[0]).toMatchObject({ executed: 2, rejected: 1, failed: 1 });
  });

  it('recentToolCalls maps a tool-call entry to a row (tool/type/status)', async () => {
    const ctx = makeCtx([
      entry('tool-call', {
        runId: 'r-1',
        toolName: 'search',
        toolType: 'read',
        status: 'executed',
      }),
    ]);
    const res = (await agentRecentToolCallsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ runId: string; tool: string; type: string; status: string }>;
    };
    expect(res.rows[0]).toMatchObject({
      runId: 'r-1',
      tool: 'search',
      type: 'read',
      status: 'executed',
    });
  });

  it('recentApprovals surfaces only action-type tool calls with their decision', async () => {
    const ctx = makeCtx([
      entry('tool-call', {
        runId: 'r-1',
        toolName: 'refund',
        toolType: 'action',
        status: 'rejected',
      }),
      entry('tool-call', {
        runId: 'r-2',
        toolName: 'ship',
        toolType: 'action',
        status: 'executed',
      }),
      entry('tool-call', {
        runId: 'r-3',
        toolName: 'search',
        toolType: 'read',
        status: 'executed',
      }),
    ]);
    const res = (await agentRecentApprovalsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ runId: string; tool: string; status: string }>;
    };
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.tool)).toEqual(expect.arrayContaining(['refund', 'ship']));
    expect(res.rows.some((r) => r.tool === 'search')).toBe(false);
  });

  it('delegation events surface in over-time and recent-delegations views', async () => {
    const ctx = makeCtx([
      entry('delegated', { runId: 'r-1', fromAgent: 'root', toAgent: 'researcher' }),
    ]);
    const overTime = (await agentDelegationsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ delegations: number }>;
    };
    expect(overTime.rows[0]?.delegations).toBe(1);

    const recent = (await agentRecentDelegationsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ runId: string; from: string; to: string }>;
    };
    expect(recent.rows[0]).toMatchObject({ runId: 'r-1', from: 'root', to: 'researcher' });
  });
});

describe('no-op when unconfigured / no telescope data', () => {
  it('providers degrade gracefully against an empty store', async () => {
    const ctx = makeCtx([]);
    expect(await agentToolCallSuccessRateProvider().resolve(undefined, ctx)).toMatchObject({
      value: 1,
    });
    expect(await agentActiveRunsProvider().resolve(undefined, ctx)).toMatchObject({ value: 0 });
    expect(await agentTokenUsageProvider().resolve(undefined, ctx)).toMatchObject({ value: 0 });
    expect(await agentRecentRunsProvider().resolve(undefined, ctx)).toMatchObject({ rows: [] });
    expect(await agentRecentToolCallsProvider().resolve(undefined, ctx)).toMatchObject({
      rows: [],
    });
    expect(await agentRecentApprovalsProvider().resolve(undefined, ctx)).toMatchObject({
      rows: [],
    });
    expect(await agentRecentDelegationsProvider().resolve(undefined, ctx)).toMatchObject({
      rows: [],
    });
  });
});

describe('host extensibility (providers / sections)', () => {
  it('appends host-contributed providers alongside the built-ins', () => {
    const hostProvider: DataProvider = {
      name: 'myapp.custom.stat',
      resolve: async () => ({ value: 1 }),
    };
    const names = (
      agentTelescopeExtension({ providers: [hostProvider] }).dataProviders?.(makeCtx()) ?? []
    ).map((p) => p.name);
    expect(names).toContain('myapp.custom.stat');
    // Built-ins are still all there — a host provider doesn't replace anything.
    expect(names).toContain('agent.activeRuns');
    expect(names).toContain('agent.spend.totalCost');
  });

  it('refuses a host provider under the reserved "agent." prefix', () => {
    const badProvider: DataProvider = {
      name: 'agent.notMine',
      resolve: async () => ({ value: 1 }),
    };
    expect(() => agentTelescopeExtension({ providers: [badProvider] })).toThrow(
      /reserved "agent\." /,
    );
  });

  it('appends host-contributed dashboard sections after the built-in ones', () => {
    const hostSection = {
      title: 'My section',
      cols: 2 as const,
      panels: [
        { kind: 'stat' as const, title: 'Custom', data: { provider: 'myapp.custom.stat' } },
        { kind: 'stat' as const, title: 'Custom 2', data: { provider: 'myapp.custom.stat' } },
      ],
    };
    const [dash] =
      agentTelescopeExtension({ sections: [hostSection] }).dashboards?.(makeCtx()) ?? [];
    expect(dash?.sections?.at(-1)?.title).toBe('My section');
    // Built-in sections are unaffected — the host section is appended, not spliced in.
    expect(dash?.sections?.[0]?.title).toBe('Runs');
  });

  it('every built-in panel binds to a provider the extension actually registers', () => {
    const ext = agentTelescopeExtension();
    const providerNames = new Set((ext.dataProviders?.(makeCtx()) ?? []).map((p) => p.name));
    const [dash] = ext.dashboards?.(makeCtx()) ?? [];
    const boundProviders = (dash?.sections ?? []).flatMap((s) =>
      s.panels.map((p) => p.data.provider),
    );
    expect(boundProviders.length).toBeGreaterThan(0);
    for (const name of boundProviders) expect(providerNames.has(name)).toBe(true);
  });

  it('applies runHref/threadHref to the governance-backed tables too (threadId key)', () => {
    const [dash] =
      agentTelescopeExtension({
        runHref: '/agent/runs/{runId}',
        threadHref: '/agent/threads/{threadId}',
      }).dashboards?.(makeCtx()) ?? [];
    const columns = (dash?.sections ?? []).flatMap((s) =>
      s.panels.flatMap((p) => (p.kind === 'table' ? p.columns : [])),
    );
    const threadIdCol = columns.find((c) => c.key === 'threadId');
    expect(threadIdCol?.link).toEqual({ href: '/agent/threads/{threadId}' });
  });

  it('still contributes no entryTypes with host options set (no SDK support for a custom entry type)', () => {
    const ext = agentTelescopeExtension({ providers: [], sections: [] });
    expect(ext.entryTypes).toBeUndefined();
  });
});
