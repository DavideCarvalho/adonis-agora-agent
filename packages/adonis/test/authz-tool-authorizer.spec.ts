import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AuthzServiceLike,
  type AuthzTenantScope,
  AuthzToolAuthorizer,
  authzToolAuthorizer,
} from '../src/authz/index.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { createNoopEmitUi } from '../src/testing/index.js';
import { ToolForbiddenError, ToolRegistry } from '../src/tool-registry.js';
import type { Actor, ToolSpec } from '../src/types.js';

/**
 * A fake `@adonis-agora/authz` `AuthzService`. Grants are keyed by `(userId, permission, tenantId)`,
 * so a grant made in one tenant does not satisfy a check scoped to another — exactly the isolation
 * `AuthzToolAuthorizer` relies on by passing `actor.tenantRef` as the scope. Records every call so a
 * test can assert the scope that was forwarded.
 */
class FakeAuthz implements AuthzServiceLike {
  readonly calls: Array<{
    user: unknown;
    permission: string;
    scope: AuthzTenantScope | undefined;
  }> = [];

  constructor(
    private readonly grants: Array<{ id: string; permission: string; tenantId?: string }>,
  ) {}

  async can(
    user: unknown,
    permission: string,
    options?: { scope?: AuthzTenantScope },
  ): Promise<boolean> {
    this.calls.push({ user, permission, scope: options?.scope });
    const id = (user as { id?: string }).id;
    const tenantId = options?.scope?.tenantId;
    return this.grants.some(
      (g) => g.id === id && g.permission === permission && (g.tenantId ?? undefined) === tenantId,
    );
  }
}

/** An authz whose check always throws — the adapter must fail closed. */
class ThrowingAuthz implements AuthzServiceLike {
  async can(): Promise<boolean> {
    throw new Error('authz backend unavailable');
  }
}

function tool(overrides: Partial<ToolSpec>): ToolSpec {
  return {
    name: 'purge',
    kind: 'action',
    description: 'Purge the cache',
    inputSchema: z.object({}),
    ...overrides,
  };
}

const actor = (overrides: Partial<Actor> = {}): Actor => ({ id: 'u1', ...overrides });

describe('AuthzToolAuthorizer.can', () => {
  it('authorizes a tool whose declared ability the actor HAS', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge' }]);
    const policy = authzToolAuthorizer({ authz });

    expect(await policy.can(actor(), tool({ ability: 'cache.purge' }))).toBe(true);
    expect(authz.calls[0]?.permission).toBe('cache.purge');
    expect(authz.calls[0]?.user).toEqual({ id: 'u1' });
  });

  it('denies a tool whose declared ability the actor LACKS', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.read' }]);
    const policy = new AuthzToolAuthorizer({ authz });

    expect(await policy.can(actor(), tool({ ability: 'cache.purge' }))).toBe(false);
  });

  it('fails closed when the tool declares no ability (no ADMIN fallback)', async () => {
    // A generous authz that grants everything — the adapter still denies, because there is no
    // ability to check against.
    const authz: AuthzServiceLike = { can: async () => true };
    const policy = new AuthzToolAuthorizer({ authz });

    expect(await policy.can(actor({ roles: ['ADMIN'] }), tool({}))).toBe(false);
    expect(await policy.can(actor({ roles: ['ADMIN'] }), tool({ roles: ['ADMIN'] }))).toBe(false);
  });

  it('passes actor.tenantRef as the authz scope (tenant isolation)', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge', tenantId: 't1' }]);
    const policy = new AuthzToolAuthorizer({ authz });
    const abilityTool = tool({ ability: 'cache.purge' });

    // Granted in t1 → allowed for the t1 actor, and the scope was forwarded.
    expect(await policy.can(actor({ tenantRef: 't1' }), abilityTool)).toBe(true);
    expect(authz.calls.at(-1)?.scope).toEqual({ tenantId: 't1' });

    // Same permission, different tenant → denied (grant is tenant-scoped).
    expect(await policy.can(actor({ tenantRef: 't2' }), abilityTool)).toBe(false);
    expect(authz.calls.at(-1)?.scope).toEqual({ tenantId: 't2' });
  });

  it('omits the scope entirely when the actor has no tenantRef (global scope)', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge' }]);
    const policy = new AuthzToolAuthorizer({ authz });

    expect(await policy.can(actor(), tool({ ability: 'cache.purge' }))).toBe(true);
    expect(authz.calls.at(-1)?.scope).toBeUndefined();
  });

  it('fails closed when the authz check throws', async () => {
    const policy = new AuthzToolAuthorizer({ authz: new ThrowingAuthz() });

    expect(await policy.can(actor(), tool({ ability: 'cache.purge' }))).toBe(false);
  });

  it('honors a custom userFromActor mapping', async () => {
    const authz = new FakeAuthz([{ id: 'staff:u1', permission: 'cache.purge' }]);
    const policy = new AuthzToolAuthorizer({
      authz,
      userFromActor: (a) => ({ id: `staff:${a.id}` }),
    });

    expect(await policy.can(actor(), tool({ ability: 'cache.purge' }))).toBe(true);
    expect(authz.calls[0]?.user).toEqual({ id: 'staff:u1' });
  });
});

describe('AuthzToolAuthorizer wired into ToolRegistry (offer filter + invoke re-check)', () => {
  const ctx = (a: Actor): AiToolCtx => ({
    actor: a,
    threadId: 't',
    runId: 'r',
    requestId: 'req',
    emitUi: createNoopEmitUi(),
  });

  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(tool({ name: 'purge', ability: 'cache.purge' }), {
      execute: async () => ({ ok: true }),
    });
    reg.register(tool({ name: 'read', ability: 'cache.read' }), {
      execute: async () => ({ ok: true }),
    });
    return reg;
  }

  it('offers only the tools whose ability the actor holds', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge', tenantId: 't1' }]);
    const policy = new AuthzToolAuthorizer({ authz });

    const defs = await registry().definitionsFor(actor({ tenantRef: 't1' }), policy);

    expect(defs.map((d) => d.name)).toEqual(['purge']);
  });

  it('invokes a tool the actor is authorized for', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge', tenantId: 't1' }]);
    const policy = new AuthzToolAuthorizer({ authz });
    const a = actor({ tenantRef: 't1' });

    await expect(registry().invoke('purge', {}, ctx(a), policy)).resolves.toEqual({ ok: true });
  });

  it('denies invoke of a tool the actor is NOT authorized for (double check)', async () => {
    const authz = new FakeAuthz([{ id: 'u1', permission: 'cache.purge', tenantId: 't1' }]);
    const policy = new AuthzToolAuthorizer({ authz });
    const a = actor({ tenantRef: 't1' });

    await expect(registry().invoke('read', {}, ctx(a), policy)).rejects.toBeInstanceOf(
      ToolForbiddenError,
    );
  });
});
