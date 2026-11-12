// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { describe, expect, it, vi } from 'vitest';
import type {
  AccountExtension,
  AccountExtensionContext,
  AccountPage,
} from '../src/account-console/contract.js';
import {
  ACCOUNT_CONSOLE_VIA,
  type AgentAccountDeps,
  agentAccountExtension,
} from '../src/account-console/extension.js';
import { ACCOUNT_MESSAGES } from '../src/account-console/messages.js';
import type { Actor, ThreadSummary } from '../src/index.js';
import { FakeModelProvider, InMemoryAgentStore } from '../src/testing/index.js';

function ctxFor(
  accountId: string,
  extra: Partial<AccountExtensionContext> = {},
): AccountExtensionContext {
  return {
    account: { id: accountId, email: null, name: null, roles: ['member'] },
    activeOrg: null,
    impersonatedBy: null,
    locale: 'en',
    query: {},
    url: (page) => `/account/${page}`,
    make: async () => undefined,
    now: () => new Date(),
    ...extra,
  };
}

const thread = (id: string, title = id): ThreadSummary =>
  ({
    id,
    title,
    persona: null,
    transient: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  }) as ThreadSummary;

/** A service fake: alice owns thread t1 (tenant a) and run r1 waiting on tc1; bob owns t2/r2/tc2. */
function fakeDeps(overrides: Partial<AgentAccountDeps> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const owners: Record<string, string> = { t1: 'alice', t2: 'bob', r1: 'alice', r2: 'bob' };
  const tenants: Record<string, string | null> = { t1: 'a', t2: 'b', r1: 'a', r2: 'b' };
  const deps: AgentAccountDeps = {
    tenancy: { enabled: false, nullRows: 'tenantless' },
    service: {
      quotaReport: async (actor: Actor) => {
        calls.push(['quotaReport', actor]);
        return {
          windows: [
            {
              period: 'day',
              usedTokens: 100,
              limitTokens: 1000,
              usedUsd: 0.5,
              resetsAt: '2026-11-13T00:00:00Z',
            },
            { period: 'month', usedTokens: 9000, usedUsd: 3, limitUsd: 10 },
          ],
          warning: { period: 'month', ratio: 0.9 },
        } as never;
      },
      listThreads: async (actorRef, options) => {
        calls.push(['listThreads', actorRef, options]);
        return actorRef === 'alice' ? [thread('t1', 'Refunds'), thread('t3')] : [];
      },
      threadOwner: async (id) => owners[id] ?? null,
      threadTenantRef: async (id) => (id in tenants ? { tenantRef: tenants[id] ?? null } : null),
      runTenantRef: async (id) => (id in tenants ? { tenantRef: tenants[id] ?? null } : null),
      deleteThread: async (id) => {
        calls.push(['deleteThread', id]);
      },
      toolCallRun: async (id) => ({ tc1: 'r1', tc2: 'r2', tcRole: 'r2', tcDone: 'r1' })[id] ?? null,
      toolCallApproval: async (id) =>
        id === 'tcRole'
          ? { status: 'pending_approval', approver: 'finance', expiresAt: null }
          : id === 'tcDone'
            ? { status: 'executed', approver: null, expiresAt: null }
            : { status: 'pending_approval', approver: null, expiresAt: null },
      runOwner: async (id) => owners[id] ?? null,
      mayDecide: async (actor, decision) => {
        calls.push(['mayDecide', actor.id, decision.approver]);
        return (actor.roles ?? []).includes('finance');
      },
      approve: async (runId, toolCallId, opts) => {
        calls.push(['approve', runId, toolCallId, opts]);
      },
      reject: async (runId, toolCallId, reason, opts) => {
        calls.push(['reject', runId, toolCallId, reason, opts]);
      },
    },
    governance: {
      pendingApprovals: async (filter: { actor?: string; approvers?: string[] }) => {
        calls.push(['pendingApprovals', filter]);
        if (filter.approvers?.includes('finance')) {
          return [
            {
              toolCallId: 'tcRole',
              toolName: 'pay_invoice',
              input: {},
              threadId: 't2',
              runId: 'r2',
              actorRef: 'bob',
              requestedAt: '2026-11-11T10:00:00.000Z',
            },
          ];
        }
        return filter.actor === 'alice'
          ? [
              {
                toolCallId: 'tc1',
                toolName: 'refund_payment',
                input: { amount: 1200, reason: 'x'.repeat(400) },
                threadId: 't1',
                runId: 'r1',
                actorRef: 'alice',
                requestedAt: '2026-11-11T10:00:00.000Z',
              },
            ]
          : [];
      },
      forTenants(scope: unknown) {
        calls.push(['forTenants', scope]);
        return this;
      },
    } as never,
    ...overrides,
  };
  return { deps, calls };
}

const page = (extension: AccountExtension, id: string) =>
  extension.pages.find((p) => p.id === id) as AccountPage;

describe('the agent account extension', () => {
  it('has a valid shape: id, contract, prefixed messages in en and pt-BR, flat segments', () => {
    const extension = agentAccountExtension(fakeDeps().deps);
    expect(extension.id).toBe('agent');
    expect(extension.contract).toBe(1);
    expect(extension.pages.map((p) => [p.id, p.segment])).toEqual([
      ['agent.usage', 'ai'],
      ['agent.conversations', 'conversations'],
      ['agent.approvals', 'approvals'],
    ]);
    for (const locale of ['en', 'pt-BR']) {
      const keys = Object.keys(ACCOUNT_MESSAGES[locale] ?? {});
      expect(keys.every((key) => key.startsWith('agent.'))).toBe(true);
    }
    expect(Object.keys(ACCOUNT_MESSAGES.en ?? {}).sort()).toEqual(
      Object.keys(ACCOUNT_MESSAGES['pt-BR'] ?? {}).sort(),
    );
    // every key a page or action uses exists
    const text = JSON.stringify(extension.pages, (_k, v) =>
      typeof v === 'function' ? undefined : v,
    );
    for (const [, key] of text.matchAll(/"key":"([^"]+)"/g)) {
      expect(ACCOUNT_MESSAGES.en).toHaveProperty([key as string]);
    }
  });

  it('usage: one meter per window ceiling, and a warning', async () => {
    const extension = agentAccountExtension(fakeDeps().deps);
    const view = await page(extension, 'agent.usage').load(ctxFor('alice'));
    expect(view.blocks.map((b) => b.kind)).toEqual(['notice', 'meter', 'meter', 'meter']);
    expect(view.blocks[1]).toMatchObject({ kind: 'meter', used: 100, limit: 1000 });
    expect(view.blocks[3]).toMatchObject({ kind: 'meter', used: 3, limit: 10 });
  });

  it("conversations: the account's own, paged; delete is owner-only (another's is not found)", async () => {
    const { deps, calls } = fakeDeps({ options: { threadUrl: (id) => `/chat/${id}` } });
    const extension = agentAccountExtension(deps);
    const conversations = page(extension, 'agent.conversations');
    const view = await conversations.load(ctxFor('alice'));
    expect(view.blocks[0]).toMatchObject({
      kind: 'list',
      items: [
        { title: 'Refunds', href: '/chat/t1' },
        { title: 't3', href: '/chat/t3' },
      ],
      nextCursor: null,
    });
    const del = conversations.actions?.delete;
    expect(await del?.handle(ctxFor('alice'), { target: 't2', fields: {} })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await del?.handle(ctxFor('alice'), { target: 't1', fields: {} })).toMatchObject({
      ok: true,
    });
    expect(calls.filter((c) => c[0] === 'deleteThread')).toEqual([['deleteThread', 't1']]);
  });

  it('the account maps through authkit subject, or the actor hook', async () => {
    const { deps, calls } = fakeDeps();
    await page(agentAccountExtension(deps), 'agent.usage').load(
      ctxFor('acct-1', { subject: { id: 'user-42' } }),
    );
    expect(calls[0]?.[1]).toMatchObject({ id: 'user-42' });
    const hooked = fakeDeps({ options: { actor: (account) => ({ id: `u:${account.id}` }) } });
    await page(agentAccountExtension(hooked.deps), 'agent.usage').load(ctxFor('acct-1'));
    expect(hooked.calls[0]?.[1]).toEqual({ id: 'u:acct-1' });
  });

  it('approvals: lists the account inbox; approve/reject follow the in-app rules', async () => {
    const { deps, calls } = fakeDeps();
    const approvals = page(agentAccountExtension(deps), 'agent.approvals');
    const view = await approvals.load(ctxFor('alice'));
    const item = (
      view.blocks[0] as unknown as { items: Array<{ title: string; subtitle: string }> }
    ).items[0];
    expect(item?.title).toBe('refund_payment');
    expect(item?.subtitle.length).toBeLessThanOrEqual(300);

    const approve = approvals.actions?.approve;
    const reject = approvals.actions?.reject;
    // another account's call: not found
    expect(await approve?.handle(ctxFor('alice'), { target: 'tc2', fields: {} })).toMatchObject({
      status: 404,
    });
    // unknown call
    expect(await approve?.handle(ctxFor('alice'), { target: 'nope', fields: {} })).toMatchObject({
      status: 404,
    });
    // already decided
    expect(await approve?.handle(ctxFor('alice'), { target: 'tcDone', fields: {} })).toMatchObject({
      status: 409,
    });
    // a role approver: only someone holding it
    expect(await approve?.handle(ctxFor('alice'), { target: 'tcRole', fields: {} })).toMatchObject({
      status: 404,
    });
    const finance = ctxFor('carol', {
      account: { id: 'carol', email: null, name: null, roles: ['finance'] },
    });
    expect(await approve?.handle(finance, { target: 'tcRole', fields: {} })).toMatchObject({
      ok: true,
    });

    expect(await approve?.handle(ctxFor('alice'), { target: 'tc1', fields: {} })).toMatchObject({
      ok: true,
    });
    expect(
      await reject?.handle(ctxFor('alice'), { target: 'tc1', fields: { reason: ' too much ' } }),
    ).toMatchObject({ ok: true });
    expect(calls.filter((c) => c[0] === 'approve' || c[0] === 'reject')).toEqual([
      ['approve', 'r2', 'tcRole', { executedByRef: 'carol', via: ACCOUNT_CONSOLE_VIA }],
      ['approve', 'r1', 'tc1', { executedByRef: 'alice', via: ACCOUNT_CONSOLE_VIA }],
      ['reject', 'r1', 'tc1', 'too much', { executedByRef: 'alice', via: ACCOUNT_CONSOLE_VIA }],
    ]);
  });

  it('approvals also lists calls put to a role the account may decide for', async () => {
    const { deps } = fakeDeps();
    const approvals = page(agentAccountExtension(deps), 'agent.approvals');
    const finance = ctxFor('carol', {
      account: { id: 'carol', email: null, name: null, roles: ['finance'] },
    });
    const view = await approvals.load(finance);
    const items = (view.blocks[0] as unknown as { items: Array<{ title: string }> }).items;
    expect(items.map((item) => item.title)).toEqual(['pay_invoice']);
    // alice holds no role: only her own runs' calls
    const own = await approvals.load(ctxFor('alice'));
    expect(
      (own.blocks[0] as unknown as { items: Array<{ title: string }> }).items.map((i) => i.title),
    ).toEqual(['refund_payment']);
  });

  it('with tenancy on, the active organization scopes every page and action', async () => {
    const { deps, calls } = fakeDeps({ tenancy: { enabled: true, nullRows: 'tenantless' } });
    const extension = agentAccountExtension(deps);
    const inB = ctxFor('alice', { activeOrg: { id: 'b', slug: 'b', role: 'member' } });
    await page(extension, 'agent.usage').load(inB);
    expect(calls.find((c) => c[0] === 'quotaReport')?.[1]).toMatchObject({ tenantRef: 'b' });
    await page(extension, 'agent.conversations').load(inB);
    expect(calls.find((c) => c[0] === 'listThreads')?.[2]).toMatchObject({
      tenantScope: { tenants: ['b'], includeNull: false },
    });
    await page(extension, 'agent.approvals').load(inB);
    expect(calls.find((c) => c[0] === 'forTenants')?.[1]).toEqual({
      tenants: ['b'],
      includeNull: false,
    });
    // alice's own thread/call in organization a: not found while b is active
    expect(
      await page(extension, 'agent.conversations').actions?.delete?.handle(inB, {
        target: 't1',
        fields: {},
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await page(extension, 'agent.approvals').actions?.approve?.handle(inB, {
        target: 'tc1',
        fields: {},
      }),
    ).toMatchObject({ status: 404 });
  });

  it('connected agents: only with Poppy connections; disconnect needs sudo and ownership', async () => {
    const disconnect = vi.fn(async () => true);
    const connections = {
      ownerOf: (actor: Actor) => actor.id,
      list: async (owner: string) =>
        owner === 'alice'
          ? [
              {
                domain: 'acme.com',
                organization: 'Acme',
                status: 'active' as const,
                scope: 'x',
                connectedSince: 1,
              },
            ]
          : [],
      disconnect,
    };
    const { deps } = fakeDeps({ connections: async () => connections });
    const page_ = page(agentAccountExtension(deps), 'agent.connections');
    expect(page_.actions?.disconnect?.sudo).toBe(true);
    expect(await page_.visible?.(ctxFor('alice'))).toBe(true);
    const view = await page_.load(ctxFor('alice'));
    expect(view.blocks[0]).toMatchObject({ items: [{ title: 'Acme', subtitle: 'acme.com' }] });
    expect(
      await page_.actions?.disconnect?.handle(ctxFor('bob'), { target: 'acme.com', fields: {} }),
    ).toMatchObject({ status: 404 });
    expect(
      await page_.actions?.disconnect?.handle(ctxFor('alice'), { target: 'acme.com', fields: {} }),
    ).toMatchObject({ ok: true });
    expect(disconnect).toHaveBeenCalledWith('alice', 'acme.com');

    const none = fakeDeps({ connections: async () => undefined });
    expect(
      await page(agentAccountExtension(none.deps), 'agent.connections').visible?.(ctxFor('alice')),
    ).toBe(false);
  });

  it('single pages turn off', () => {
    const { deps } = fakeDeps({ options: { pages: { approvals: false, usage: false } } });
    expect(agentAccountExtension(deps).pages.map((p) => p.id)).toEqual(['agent.conversations']);
  });
});

describe('registration from agent_provider', () => {
  async function boot(withRegistry: boolean, agent: Record<string, unknown> = {}) {
    const registered: AccountExtension[] = [];
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
        config: {
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => ({ id: 'u' }) },
            ...agent,
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    if (withRegistry) {
      app.container.bindValue(
        'authkit.accountExtensions' as never,
        {
          contract: 1,
          blockKinds: ['notice', 'list', 'meter'],
          register: (extension: AccountExtension) => registered.push(extension),
        } as never,
      );
    }
    await app.boot();
    await app.terminate();
    return registered;
  }

  it('registers into authkit.accountExtensions when bound, never otherwise, and honours false', {
    timeout: 60_000,
  }, async () => {
    expect((await boot(true)).map((e) => e.id)).toEqual(['agent']);
    expect(await boot(false)).toEqual([]);
    expect(await boot(true, { accountConsole: false })).toEqual([]);
  });

  it('the built package never imports authkit at runtime', async () => {
    const root = new URL('../src/account-console/', import.meta.url);
    for (const file of await readdir(root)) {
      const source = await readFile(join(root.pathname, file), 'utf8');
      expect(source).not.toMatch(/from '@adonis-agora\/authkit/);
    }
  });
});

describe('pendingApprovals({ approvers }) on the Lucid read-model', () => {
  it('keeps only the calls put to those approvers', async () => {
    const { asStoreDb, makeStoreDb } = await import('./helpers/make-db.js');
    const { LucidAgentStore, LucidGovernanceQueries } = await import('../src/index.js');
    const db = await makeStoreDb();
    try {
      const store = new LucidAgentStore(asStoreDb(db));
      const thread = await store.createThread({ actor: { id: 'bob' }, persona: 'default' });
      await store.recordRunStart({ runId: 'r', threadId: thread.id, actor: { id: 'bob' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'x',
        runId: 'r',
      });
      for (const [id, approver] of [
        ['tc-own', undefined],
        ['tc-fin', 'finance'],
        ['tc-ops', 'ops'],
      ] as const) {
        await store.recordToolCall({
          toolCallId: id,
          messageId: message.id,
          toolName: id,
          toolType: 'action',
          input: {},
          status: 'pending_approval',
          runId: 'r',
          ...(approver !== undefined ? { approver } : {}),
        });
      }
      const governance = new LucidGovernanceQueries(asStoreDb(db));
      expect(
        (await governance.pendingApprovals({ approvers: ['finance'] })).map((r) => r.toolCallId),
      ).toEqual(['tc-fin']);
      expect(await governance.pendingApprovals({ approvers: [] })).toEqual([]);
      expect((await governance.pendingApprovals({ actor: 'bob' })).length).toBe(3);
    } finally {
      await db.manager.closeAll();
    }
  });
});
