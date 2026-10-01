import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Actor,
  type AiToolCtx,
  ClosedRolesPolicy,
  ClosedToolAuthorizer,
  DefaultRolesPolicy,
  DefaultToolAuthorizer,
  defineTool,
  registerFunctionalTool,
  ToolDisabledError,
  ToolForbiddenError,
  type ToolHandler,
  ToolInputInvalidError,
  ToolNotFoundError,
  ToolRegistry,
  type ToolSpec,
} from '../src/index.js';
import { createNoopEmitUi } from '../src/testing/index.js';

/** A hand-rolled Standard Schema (no Zod) — proves the registry is validation-library-agnostic. */
const upperCityValibotLike: StandardSchemaV1<{ city: string }, { city: string }> = {
  '~standard': {
    version: 1,
    vendor: 'handmade',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { city?: unknown }).city === 'string'
      ) {
        return { value: { city: (value as { city: string }).city.toUpperCase() } };
      }
      return { issues: [{ message: 'city must be a string' }] };
    },
  },
};

function ctxFor(actor: Actor): AiToolCtx {
  return {
    threadId: 't1',
    runId: 'r1',
    requestId: 'r1',
    emitUi: createNoopEmitUi(),
    actor,
  };
}

describe('ToolRegistry', () => {
  // Tools declare no roles here, so the policy's defaults decide: ADMIN-only, the posture these cases exercise.
  const policy = new DefaultRolesPolicy(['ADMIN']);

  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'getWeather',
        kind: 'read',
        description: 'weather',
        inputSchema: z.object({ city: z.string() }),
      },
      { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
    );
    reg.register(
      {
        name: 'purgeCache',
        kind: 'action',
        description: 'purge',
        inputSchema: z.object({ key: z.string() }),
      },
      { execute: async () => ({ purged: true }) },
    );
    return reg;
  }

  it('offers neutral definitions for an allowed actor (no execute leaks)', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy);
    expect(defs.map((d) => d.name).sort()).toEqual(['getWeather', 'purgeCache']);
    expect(defs.every((d) => !('execute' in d))).toBe(true);
  });

  it('leaves a tool without roles open to anyone under the default policy', async () => {
    const defs = await registry().definitionsFor(
      { id: 'anon:x', roles: ['anonymous'] },
      new DefaultRolesPolicy(),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['getWeather', 'purgeCache']);
  });

  it('filters out tools the role may not use', async () => {
    const defs = await registry().definitionsFor({ id: 'u2', roles: ['GUEST'] }, policy);
    expect(defs).toHaveLength(0);
  });

  it('applies the persona allow-list on top of role filtering', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy, [
      'getWeather',
    ]);
    expect(defs.map((d) => d.name)).toEqual(['getWeather']);
  });

  it('invokes a read tool, re-parsing input via Zod', async () => {
    const out = await registry().invoke(
      'getWeather',
      { city: 'Recife' },
      ctxFor({ id: 'u1', roles: ['ADMIN'] }),
      policy,
    );
    expect(out).toEqual({ tempC: 21, city: 'Recife' });
  });

  it('rejects invocation by a disallowed role (defense in depth)', async () => {
    await expect(
      registry().invoke(
        'getWeather',
        { city: 'Recife' },
        ctxFor({ id: 'u2', roles: ['GUEST'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('throws ToolInputInvalidError (with issues) on invalid input', async () => {
    await expect(
      registry().invoke(
        'getWeather',
        { city: 123 },
        ctxFor({ id: 'u1', roles: ['ADMIN'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolInputInvalidError);
  });

  it('validates via any Standard Schema (not just Zod) and passes the parsed value', async () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: 'echoCity', kind: 'read', description: 'echo', inputSchema: upperCityValibotLike },
      { execute: async (input: { city: string }) => input },
    );
    const out = await reg.invoke(
      'echoCity',
      { city: 'recife' },
      ctxFor({ id: 'u1', roles: ['ADMIN'] }),
      policy,
    );
    expect(out).toEqual({ city: 'RECIFE' });

    await expect(
      reg.invoke('echoCity', { city: 42 }, ctxFor({ id: 'u1', roles: ['ADMIN'] }), policy),
    ).rejects.toBeInstanceOf(ToolInputInvalidError);
  });

  it('unregisters a tool so it is neither offered nor invocable', async () => {
    const reg = new ToolRegistry();
    const policy = new DefaultRolesPolicy();
    const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
    reg.register(
      { name: 'voidInvoice', kind: 'action', description: 'v', inputSchema: z.object({}) },
      { execute: async () => ({ voided: true }) },
    );

    expect(reg.unregister('voidInvoice')).toBe(true);

    expect(reg.has('voidInvoice')).toBe(false);
    expect((await reg.definitionsFor(actor, policy)).map((tool) => tool.name)).toEqual([]);
    await expect(reg.invoke('voidInvoice', {}, ctxFor(actor), policy)).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
    // Says whether there was one, so a caller pruning a list can tell a no-op from a removal.
    expect(reg.unregister('voidInvoice')).toBe(false);
  });
});

describe('an empty roles list', () => {
  const tool = (roles?: string[]) => ({
    name: 'listInvoices',
    kind: 'read' as const,
    description: 'l',
    inputSchema: z.object({}),
    ...(roles !== undefined ? { roles } : {}),
  });
  const staff: Actor = { id: 'u1', roles: ['STAFF'] };
  const nobody: Actor = { id: 'u2' };

  it('is open by default — declared empty, or undeclared with empty defaults', () => {
    for (const policy of [new DefaultRolesPolicy(), new DefaultToolAuthorizer()]) {
      expect(policy.can(staff, tool([]))).toBe(true);
      expect(policy.can(staff, tool())).toBe(true);
      expect(policy.can(nobody, tool())).toBe(true);
    }
    expect(new DefaultRolesPolicy([], { emptyRoles: 'allow' }).can(nobody, tool([]))).toBe(true);
  });

  it("reaches nobody under emptyRoles: 'deny'", () => {
    const closed = [
      new ClosedRolesPolicy(),
      new ClosedToolAuthorizer(),
      new DefaultRolesPolicy([], { emptyRoles: 'deny' }),
      new DefaultToolAuthorizer([], { emptyRoles: 'deny' }),
    ];
    for (const policy of closed) {
      expect(policy.can(staff, tool([]))).toBe(false);
      expect(policy.can(staff, tool())).toBe(false);
      expect(policy.can(staff, tool(['STAFF']))).toBe(true);
      expect(policy.can(staff, tool(['ADMIN']))).toBe(false);
      expect(policy.can(nobody, tool(['STAFF']))).toBe(false);
      expect(policy.can({ id: 'u3', roles: [] }, tool(['STAFF']))).toBe(false);
    }
  });

  it('closed, a declared empty list is not rescued by the default roles', () => {
    const policy = new ClosedRolesPolicy(['STAFF']);
    expect(policy.can(staff, tool())).toBe(true);
    expect(policy.can(staff, tool([]))).toBe(false);
  });

  it('closed, a tool registered with empty default roles is neither offered nor invocable', async () => {
    const reg = new ToolRegistry();
    // registerFunctionalTool writes the defaults onto the spec: the tool carries `roles: []`.
    registerFunctionalTool(
      reg,
      defineTool(
        { name: 'listInvoices', kind: 'read', description: 'l', input: z.object({}) },
        async () => ({
          ok: true,
        }),
      ),
      [],
    );

    const open = new DefaultRolesPolicy();
    expect((await reg.definitionsFor(staff, open)).map((t) => t.name)).toEqual(['listInvoices']);

    const closed = new ClosedRolesPolicy();
    expect(await reg.definitionsFor(staff, closed)).toEqual([]);
    await expect(reg.invoke('listInvoices', {}, ctxFor(staff), closed)).rejects.toBeInstanceOf(
      ToolForbiddenError,
    );
  });
});

describe('ToolRegistry — disabled tools', () => {
  const policy = new DefaultRolesPolicy();
  const admin: Actor = { id: 'u1', roles: ['ADMIN'] };

  function withEnabled(
    enabled: ToolSpec['enabled'],
    handler: ToolHandler = { execute: async () => ({ ok: true }) },
  ): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'searchDocs',
        kind: 'read',
        description: 'search',
        inputSchema: z.object({ q: z.string() }),
        ...(enabled !== undefined ? { enabled } : {}),
      },
      handler,
    );
    return reg;
  }

  it('does not offer a tool disabled by its spec', async () => {
    expect(await withEnabled(false).definitionsFor(admin, policy)).toEqual([]);
  });

  it('offers a tool whose spec says nothing about being enabled', async () => {
    const defs = await withEnabled(undefined).definitionsFor(admin, policy);
    expect(defs.map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('re-reads a predicate every turn, so flipping the flag needs no re-registration', async () => {
    let on = false;
    const reg = withEnabled(() => on);
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
    on = true;
    expect((await reg.definitionsFor(admin, policy)).map((d) => d.name)).toEqual(['searchDocs']);
  });

  it("honours the handler's isEnabled() — the seam for a flag that lives in an injected service", async () => {
    const reg = withEnabled(undefined, {
      execute: async () => ({ ok: true }),
      isEnabled: () => false,
    });
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
  });

  it('needs BOTH the spec and the handler to agree before offering the tool', async () => {
    const reg = withEnabled(true, {
      execute: async () => ({ ok: true }),
      isEnabled: async () => false,
    });
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
  });

  it('keeps a disabled tool out of the catalog a person is shown, too (visibleSpecs)', async () => {
    expect(await withEnabled(false).visibleSpecs(admin, policy)).toEqual([]);
  });

  it('refuses to invoke a disabled tool — an approval granted before the flag moved must not run it', async () => {
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.toBeInstanceOf(ToolDisabledError);
  });

  it('reports a disabled tool as disabled, not as unregistered or forbidden', async () => {
    // The three failures are operationally different: flip the flag / add the role / fix the name.
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.not.toBeInstanceOf(ToolNotFoundError);
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.not.toBeInstanceOf(ToolForbiddenError);
  });

  it('checks enabled BEFORE the role, so a disabled tool never leaks its existence via a role error', async () => {
    await expect(
      withEnabled(false).invoke(
        'searchDocs',
        { q: 'x' },
        ctxFor({ id: 'u2', roles: ['GUEST'] }),
        new DefaultRolesPolicy(['ADMIN']),
      ),
    ).rejects.toBeInstanceOf(ToolDisabledError);
  });
});

describe('ToolRegistry — a tool that gates its own actors', () => {
  const policy = new DefaultRolesPolicy();
  const admin: Actor = { id: 'u1', roles: ['ADMIN'] };
  const otherAdmin: Actor = { id: 'u2', roles: ['ADMIN'] };

  function withCanUse(canUse: NonNullable<ToolHandler['canUse']>): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'searchDocs',
        kind: 'read',
        description: 'search',
        inputSchema: z.object({ q: z.string() }),
      },
      { execute: async () => ({ ok: true }), canUse },
    );
    return reg;
  }

  const onlyU1: NonNullable<ToolHandler['canUse']> = (actor) => actor.id === 'u1';

  it('offers the tool to the actor it allows', async () => {
    const defs = await withCanUse(onlyU1).definitionsFor(admin, policy);
    expect(defs.map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('hides it from an actor it refuses, even though the ROLE would allow it', async () => {
    // The role gate passes for both — this is the per-user layer the role gate can't express.
    expect(await withCanUse(onlyU1).definitionsFor(otherAdmin, policy)).toEqual([]);
  });

  it('re-decides per turn, so an entitlement granted mid-thread appears without a restart', async () => {
    const entitled = new Set<string>();
    const reg = withCanUse((actor) => entitled.has(actor.id));
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
    entitled.add('u1');
    expect((await reg.definitionsFor(admin, policy)).map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('rejects invocation by a refused actor (defense in depth)', async () => {
    await expect(
      withCanUse(onlyU1).invoke('searchDocs', { q: 'x' }, ctxFor(otherAdmin), policy),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('supports an async decision (a DB or entitlement lookup)', async () => {
    const reg = withCanUse(async (actor) => Promise.resolve(actor.tenantRef === 'base-1'));
    expect(await reg.definitionsFor({ ...admin, tenantRef: 'base-2' }, policy)).toEqual([]);
    expect(
      (await reg.definitionsFor({ ...admin, tenantRef: 'base-1' }, policy)).map((d) => d.name),
    ).toEqual(['searchDocs']);
  });

  it('cannot widen: a `canUse` that says yes does not survive a role gate that says no', async () => {
    const adminOnly = new DefaultRolesPolicy(['ADMIN']);
    await expect(
      withCanUse(() => true).invoke(
        'searchDocs',
        { q: 'x' },
        ctxFor({ id: 'u3', roles: ['GUEST'] }),
        adminOnly,
      ),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
    expect(
      await withCanUse(() => true).definitionsFor({ id: 'u3', roles: ['GUEST'] }, adminOnly),
    ).toEqual([]);
  });

  it('never asks a gate about a tool the agent did not pin', async () => {
    let asked = 0;
    const reg = withCanUse(() => {
      asked += 1;
      return true;
    });
    expect(await reg.definitionsFor(admin, policy, ['somethingElse'])).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe('defineTool — gates on a functional tool', () => {
  const policy = new DefaultRolesPolicy();

  it('carries `enabled` onto the spec and `canUse` onto the handler', async () => {
    let on = true;
    const reg = new ToolRegistry();
    registerFunctionalTool(
      reg,
      defineTool(
        {
          name: 'planOnly',
          description: 'paid plans only',
          input: z.object({}),
          enabled: () => on,
          canUse: (actor) => actor.tenantRef === 'paid',
        },
        async () => 'ok',
      ),
      [],
    );
    const paid: Actor = { id: 'u1', tenantRef: 'paid' };
    const free: Actor = { id: 'u2', tenantRef: 'free' };
    expect((await reg.definitionsFor(paid, policy)).map((d) => d.name)).toEqual(['planOnly']);
    expect(await reg.definitionsFor(free, policy)).toEqual([]);
    await expect(reg.invoke('planOnly', {}, ctxFor(free), policy)).rejects.toBeInstanceOf(
      ToolForbiddenError,
    );
    on = false;
    expect(await reg.definitionsFor(paid, policy)).toEqual([]);
    await expect(reg.invoke('planOnly', {}, ctxFor(paid), policy)).rejects.toBeInstanceOf(
      ToolDisabledError,
    );
  });
});
