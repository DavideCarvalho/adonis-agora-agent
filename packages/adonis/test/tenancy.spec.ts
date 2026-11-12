import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentTenantFilter,
  inScope,
  resolveAgentTenancy,
  scopeOfFilter,
  type TenantFilter,
  tenantFillingResolver,
  tenantVisible,
  withTenantRef,
} from '../src/agora/tenancy.js';
import { normalizeConsoleAuthorizeResult } from '../src/console-authorize.js';
import { resolveConsoleTenantScope } from '../src/dashboard/tenant-scope.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  ToolRegistry,
} from '../src/index.js';
import { LedgerQuotaProvider } from '../src/stores/ledger-quota-provider.js';
import { FakeModelProvider, InMemoryAgentStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const ACCESSOR = Symbol.for('@agora/context:accessor');
const TENANCY = Symbol.for('@agora/context:tenancy');
const slots = globalThis as Record<symbol, unknown>;

/** Install a fake `@adonis-agora/context` accessor publishing `filter` with tenancy `enabled`. */
function fakeContext(state: { enabled: boolean; kinds?: string[]; filter: TenantFilter }) {
  slots[ACCESSOR] = {
    tenancy: () => ({ enabled: state.enabled, ...(state.kinds ? { kinds: state.kinds } : {}) }),
    tenantFilter: () => state.filter,
  };
  slots[TENANCY] = {
    version: 1,
    tenancy: () => ({ enabled: state.enabled, ...(state.kinds ? { kinds: state.kinds } : {}) }),
    tenantFilter: () => state.filter,
    tenantLabels: async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, `Org ${id.toUpperCase()}`])),
  };
  return state;
}

const orgA: TenantFilter = {
  mode: 'tenant',
  tenant: { id: 'a', kind: 'organization', source: 'authkit' },
};

let previous: { accessor: unknown; tenancy: unknown };
beforeEach(() => {
  previous = { accessor: slots[ACCESSOR], tenancy: slots[TENANCY] };
});
afterEach(() => {
  slots[ACCESSOR] = previous.accessor;
  slots[TENANCY] = previous.tenancy;
});

describe('tenancy reader', () => {
  it('reads the accessor slot of an earlier context when there is no :tenancy slot', () => {
    delete slots[TENANCY];
    slots[ACCESSOR] = { tenancy: () => ({ enabled: true }), tenantFilter: () => orgA };
    expect(currentTenantFilter(resolveAgentTenancy('inherit'))).toEqual(orgA);
  });

  it('is off without context, with `false`, or when context has it off', () => {
    delete slots[ACCESSOR];
    delete slots[TENANCY];
    expect(resolveAgentTenancy('inherit').enabled).toBe(false);
    fakeContext({ enabled: true, filter: orgA });
    expect(resolveAgentTenancy(false).enabled).toBe(false);
    expect(resolveAgentTenancy(undefined).enabled).toBe(true);
    expect(resolveAgentTenancy({ enabled: false }).enabled).toBe(false);
    fakeContext({ enabled: false, filter: orgA });
    expect(resolveAgentTenancy('inherit').enabled).toBe(false);
    expect(resolveAgentTenancy({ enabled: true }).enabled).toBe(true);
  });

  it('a tenant of another kind reads as tenantless; off reads as system', () => {
    fakeContext({ enabled: true, filter: orgA });
    expect(currentTenantFilter(resolveAgentTenancy({ kinds: ['clinic'] }))).toEqual({
      mode: 'tenantless',
    });
    expect(currentTenantFilter(resolveAgentTenancy('inherit'))).toEqual(orgA);
    expect(currentTenantFilter({ enabled: false, nullRows: 'tenantless' })).toEqual({
      mode: 'system',
    });
  });

  it('applies the matching rule: own tenant, other tenant, no tenant', () => {
    expect(tenantVisible(orgA, 'a')).toBe(true);
    expect(tenantVisible(orgA, 'b')).toBe(false);
    expect(tenantVisible(orgA, null)).toBe(false);
    expect(tenantVisible(orgA, null, 'shared')).toBe(true);
    expect(tenantVisible({ mode: 'tenantless' }, null)).toBe(true);
    expect(tenantVisible({ mode: 'tenantless' }, 'a')).toBe(false);
    expect(tenantVisible({ mode: 'all' }, 'b')).toBe(true);
    expect(tenantVisible({ mode: 'system' }, null)).toBe(true);
    expect(scopeOfFilter({ mode: 'all' })).toBeUndefined();
    expect(inScope({ tenants: ['a'], includeNull: false }, 'a')).toBe(true);
    expect(inScope({ tenants: ['a'], includeNull: false }, null)).toBe(false);
  });

  it('fills the actor tenant, never overriding a resolver that set one', async () => {
    fakeContext({ enabled: true, filter: orgA });
    const tenancy = resolveAgentTenancy('inherit');
    expect(withTenantRef({ id: 'u1' }, tenancy)).toEqual({ id: 'u1', tenantRef: 'a' });
    expect(withTenantRef({ id: 'u1', tenantRef: 'clinic-9' }, tenancy)).toEqual({
      id: 'u1',
      tenantRef: 'clinic-9',
    });
    const resolver = tenantFillingResolver({ resolve: () => ({ id: 'u2' }) }, tenancy);
    expect(await resolver.resolve({})).toEqual({ id: 'u2', tenantRef: 'a' });
    const off = resolveAgentTenancy(false);
    expect(withTenantRef({ id: 'u1' }, off)).toEqual({ id: 'u1' });
  });
});

describe('console tenant scope', () => {
  it('own tenant by default; nothing without one; granted lists and all', () => {
    expect(resolveConsoleTenantScope({ granted: undefined, own: orgA })).toMatchObject({
      allowed: ['a'],
      scope: { tenants: ['a'], includeNull: false },
    });
    expect(
      resolveConsoleTenantScope({ granted: undefined, own: { mode: 'tenantless' } }),
    ).toMatchObject({
      allowed: [],
      scope: { tenants: [], includeNull: false },
    });
    expect(resolveConsoleTenantScope({ granted: '*', own: orgA })).toMatchObject({
      allowed: '*',
      scope: undefined,
    });
    expect(resolveConsoleTenantScope({ granted: ['a', 'b'], own: orgA })).toMatchObject({
      scope: { tenants: ['a', 'b'] },
    });
  });

  it('?tenant= narrows inside the grant; outside it is empty and flagged', () => {
    expect(resolveConsoleTenantScope({ granted: ['a', 'b'], own: orgA, selected: 'b' })).toEqual({
      allowed: ['a', 'b'],
      scope: { tenants: ['b'], includeNull: false },
      selected: 'b',
      forged: false,
    });
    expect(resolveConsoleTenantScope({ granted: ['a'], own: orgA, selected: 'z' })).toEqual({
      allowed: ['a'],
      scope: { tenants: [], includeNull: false },
      selected: null,
      forged: true,
    });
    expect(resolveConsoleTenantScope({ granted: '*', own: orgA, selected: 'z' }).scope).toEqual({
      tenants: ['z'],
      includeNull: false,
    });
    expect(
      resolveConsoleTenantScope({ granted: ['a'], own: orgA, selected: 'a', nullRows: 'shared' })
        .scope,
    ).toEqual({ tenants: ['a'], includeNull: true });
  });

  it('keeps `tenants` from an allowing authorize result', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: ['a', '', 3] })).toEqual({
      allowed: true,
      tenants: ['a'],
    });
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
  });
});

describe('quota per tenant', () => {
  it("'tenant' sums the organization, 'actor-in-tenant' the caller inside it", async () => {
    const store = new InMemoryAgentStore();
    const row = (actorRef: string, tenantRef: string, tokens: number) =>
      store.recordUsage({
        actorRef,
        tenantRef,
        modelId: 'm',
        purpose: 'chat',
        usage: { inputTokens: tokens, outputTokens: 0 },
      });
    await row('alice', 'a', 100);
    await row('bob', 'a', 300);
    await row('carol', 'b', 50);
    const limits = { day: { tokens: 350 } };
    const perTenant = new LedgerQuotaProvider(store, undefined, limits, { per: 'tenant' });
    const report = await perTenant.report({ actor: { id: 'alice', tenantRef: 'a' } });
    expect(report.windows[0]?.usedTokens).toBe(400);
    expect(report.blocked?.period).toBe('day');

    const inTenant = new LedgerQuotaProvider(store, undefined, limits, { per: 'actor-in-tenant' });
    expect(
      (await inTenant.report({ actor: { id: 'alice', tenantRef: 'a' } })).windows[0]?.usedTokens,
    ).toBe(100);

    // No tenant on the actor: its own usage.
    expect((await perTenant.report({ actor: { id: 'carol' } })).windows[0]?.usedTokens).toBe(50);
  });
});

describe('governance read-model scoped by tenant (Lucid)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await makeStoreDb();
  });
  afterEach(async () => {
    await db?.manager.closeAll();
  });

  async function seed() {
    const store = new LucidAgentStore(asStoreDb(db));
    const a = { id: 'alice', tenantRef: 'a' };
    const b = { id: 'bob', tenantRef: 'b' };
    const none = { id: 'nora' };
    for (const [actor, runId] of [
      [a, 'run-a'],
      [b, 'run-b'],
      [none, 'run-n'],
    ] as const) {
      const thread = await store.createThread({ actor, persona: 'default', title: runId });
      await store.recordRunStart({ runId, threadId: thread.id, actor, agentName: 'default' });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'x',
        runId,
      });
      await store.recordToolCall({
        toolCallId: `tc-${runId}`,
        messageId: message.id,
        toolName: 'deploy',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId,
      });
      await store.recordUsage({
        threadId: thread.id,
        actorRef: actor.id,
        ...('tenantRef' in actor ? { tenantRef: actor.tenantRef } : {}),
        runId,
        modelId: 'gpt-x',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 0 },
      });
    }
    return { store, governance: new LucidGovernanceQueries(asStoreDb(db)) };
  }

  it('lists, rolls up and opens only the scope; untenanted rows only when included', async () => {
    const { store, governance } = await seed();
    const onlyA = governance.forTenants({ tenants: ['a'], includeNull: false });
    expect((await onlyA.listRuns()).items.map((run) => run.runId)).toEqual(['run-a']);
    expect((await onlyA.pendingApprovals()).map((call) => call.toolCallId)).toEqual(['tc-run-a']);
    expect(await onlyA.countPendingApprovals()).toBe(1);
    expect(
      (await onlyA.spendByActor({ fromDay: '2000-01-01', toDay: '2999-01-01' })).map(
        (r) => r.actorRef,
      ),
    ).toEqual(['alice']);
    expect((await onlyA.recentThreads(10)).map((t) => t.actorRef)).toEqual(['alice']);
    expect((await onlyA.recentToolCalls(10)).length).toBe(1);
    expect((await onlyA.perToolStats()).reduce((sum, row) => sum + row.calls, 0)).toBe(1);
    expect((await onlyA.runReliability()).runs).toBe(1);
    expect(await onlyA.runDetail('run-b')).toBeNull();
    expect(await onlyA.runDetail('run-a')).not.toBeNull();

    const tenantless = governance.forTenants({ tenants: [], includeNull: true });
    expect((await tenantless.listRuns()).items.map((run) => run.runId)).toEqual(['run-n']);
    const nothing = governance.forTenants({ tenants: [], includeNull: false });
    expect((await nothing.listRuns()).items).toEqual([]);
    expect((await governance.listRuns()).items).toHaveLength(3);
    expect(await governance.listTenants()).toEqual(['a', 'b']);
    expect(await onlyA.listTenants()).toEqual(['a']);

    expect(await store.getThreadTenantRef('nope')).toBeNull();
    const threads = await store.listThreadsInScope('alice', { tenants: ['b'], includeNull: true });
    expect(threads).toEqual([]);
    expect(
      await store.listThreadsInScope('alice', { tenants: ['a'], includeNull: false }),
    ).toHaveLength(1);
    expect((await store.usageBetweenForTenant('a', '2000-01-01', '2999-01-01')).usedTokens).toBe(
      10,
    );
  });
});

describe('AgentService under tenancy', () => {
  function service(store: InMemoryAgentStore, enabled = true) {
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(() => ({ text: 'hello' })),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents: new AgentRegistry(),
    });
    return new AgentService(new InlineAgentRunner(factory, store), store, factory, {
      tenancy: resolveAgentTenancy(enabled ? 'inherit' : false),
    });
  }

  it("another tenant's thread is not found; the list keeps the request's tenant", async () => {
    const state = fakeContext({ enabled: true, filter: orgA });
    const store = new InMemoryAgentStore();
    const inA = await store.createThread({
      actor: { id: 'alice', tenantRef: 'a' },
      persona: 'default',
    });
    const inB = await store.createThread({
      actor: { id: 'alice', tenantRef: 'b' },
      persona: 'default',
    });
    const svc = service(store);
    expect(await svc.threadOwner(inA.id)).toBe('alice');
    expect(await svc.threadOwner(inB.id)).toBeNull();
    expect((await svc.listThreads('alice')).map((t) => t.id)).toEqual([inA.id]);

    state.filter = { mode: 'system' };
    expect(await svc.threadOwner(inB.id)).toBe('alice');

    // tenancy off: unchanged behaviour
    state.filter = orgA;
    const off = service(store, false);
    expect(await off.threadOwner(inB.id)).toBe('alice');
    expect(await off.listThreads('alice')).toHaveLength(2);
  });

  it('recordUsage stamps the active tenant unless the caller names one', async () => {
    fakeContext({ enabled: true, filter: orgA });
    const store = new InMemoryAgentStore();
    const svc = service(store);
    await svc.recordUsage({ actorRef: 'alice', feature: 'tts', characters: 10 });
    await svc.recordUsage({ actorRef: 'alice', feature: 'tts', characters: 10, tenantRef: 'z' });
    expect((await store.usageBetweenForTenant('a', '2000-01-01', '2999-01-01')).usedTokens).toBe(0);
    const tenants = (store as unknown as { usage: Array<{ tenantRef?: string }> }).usage.map(
      (row) => row.tenantRef,
    );
    expect(tenants).toEqual(['a', 'z']);
    expect(svc.withTenant({ id: 'alice' })).toEqual({ id: 'alice', tenantRef: 'a' });
  });
});

describe('console under tenancy (HTTP)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function boot(authorize: (ctx: unknown) => unknown) {
    const { IgnitorFactory } = await import('@adonisjs/core/factories/core/ignitor');
    const { createServer } = await import('node:http');
    const { InMemoryGovernanceQueries } = await import('../src/testing/index.js');
    const scopes: unknown[] = [];
    class Governance extends InMemoryGovernanceQueries {
      forTenants(scope: unknown) {
        scopes.push(scope);
        return this;
      }
      async listTenants() {
        return ['a', 'b'];
      }
    }
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
        config: {
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            actorResolver: { resolve: () => ({ id: 'admin' }) },
            governanceQueries: new Governance(new InMemoryAgentStore()),
            dashboard: { authorize },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    const server = await app.container.make('server');
    await server.boot();
    const node = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => node.close(() => resolve()));
    const { port } = node.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, scopes };
  }

  it('scopes reads to the granted tenants, narrows by ?tenant=, empties a forged one', async () => {
    fakeContext({ enabled: true, filter: orgA });
    const { url, scopes } = await boot(() => ({ allowed: true, tenants: ['a', 'b'] }));
    const picker = await (await fetch(`${url}/agent/governance/tenants`)).json();
    expect(picker).toEqual({
      enabled: true,
      all: false,
      own: 'a',
      tenants: [
        { id: 'a', label: 'Org A' },
        { id: 'b', label: 'Org B' },
      ],
      selected: null,
    });
    await fetch(`${url}/agent/governance/runs`);
    await fetch(`${url}/agent/governance/runs?tenant=b`);
    await fetch(`${url}/agent/governance/runs?tenant=zzz`);
    expect(scopes).toEqual([
      { tenants: ['a', 'b'], includeNull: false },
      { tenants: ['b'], includeNull: false },
      { tenants: [], includeNull: false },
    ]);
  });

  it("'*' reads everything; tenancy off is today's behaviour", async () => {
    const state = fakeContext({ enabled: true, filter: orgA });
    let booted = await boot(() => ({ allowed: true, tenants: '*' }));
    await fetch(`${booted.url}/agent/governance/runs`);
    expect(booted.scopes).toEqual([]);
    expect((await (await fetch(`${booted.url}/agent/governance/tenants`)).json()).all).toBe(true);
    await close?.();
    state.enabled = false;
    booted = await boot(() => true);
    await fetch(`${booted.url}/agent/governance/runs`);
    expect(booted.scopes).toEqual([]);
    expect((await (await fetch(`${booted.url}/agent/governance/tenants`)).json()).enabled).toBe(
      false,
    );
  });
});

describe('quota per tenant with a QuotaStore', () => {
  it("the day window takes the QuotaStore's token ceiling when limits set none", async () => {
    const { InMemoryQuotaStore } = await import('../src/testing/index.js');
    const store = new InMemoryAgentStore();
    await store.recordUsage({
      actorRef: 'alice',
      tenantRef: 'a',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const provider = new LedgerQuotaProvider(
      store,
      new InMemoryQuotaStore(5),
      {},
      { per: 'tenant' },
    );
    const report = await provider.report({ actor: { id: 'alice', tenantRef: 'a' } });
    expect(report.windows[0]).toMatchObject({ usedTokens: 10, limitTokens: 5 });
    expect(report.blocked?.period).toBe('day');
  });
});
