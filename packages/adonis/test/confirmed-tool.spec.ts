import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AiToolCtx,
  ConfirmTokenError,
  type ConfirmTokenStore,
  DefaultRolesPolicy,
  defineConfirmedTool,
  InMemoryConfirmTokenStore,
  registerFunctionalTool,
  ToolInputInvalidError,
  ToolRegistry,
  withConfirmFields,
} from '../src/index.js';
import { createNoopEmitUi } from '../src/testing/index.js';

const SECRET = 'a-secret-only-the-server-knows';

interface Args {
  orderId: string;
  amount: number;
}

function ctxFor(actor: AiToolCtx['actor']): AiToolCtx {
  return { actor, threadId: 't', runId: 'r', requestId: 'q', emitUi: createNoopEmitUi('q') };
}

const ALICE = ctxFor({ id: 'alice', roles: ['ADMIN'], tenantRef: 'acme' });

/** A confirmed refund over a fake ledger, reached the way every caller reaches it: the registry. */
function setup(options: { store?: ConfirmTokenStore | null; ttlMs?: number } = {}) {
  const written: Args[] = [];
  const state = { refuse: undefined as string | undefined, failCommit: false, prepared: 0 };
  const store =
    options.store === null ? undefined : (options.store ?? new InMemoryConfirmTokenStore());
  const tool = defineConfirmedTool<Args, Args>(
    {
      name: 'refund_order',
      description: 'Refund an order.',
      // Strict on purpose: the app schema must never be shown the two confirmation fields.
      input: z.object({ orderId: z.string(), amount: z.number().positive() }).strict(),
      secret: SECRET,
      ...(store !== undefined ? { store } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    },
    {
      prepare: (args) => {
        state.prepared += 1;
        if (state.refuse !== undefined) throw new Error(state.refuse);
        return args;
      },
      preview: (args) => ({ summary: `Refund ${args.amount} on ${args.orderId}?`, data: args }),
      commit: async (args) => {
        // A real commit awaits the database; yielding here is what lets two confirmations overlap.
        await Promise.resolve();
        if (state.failCommit) throw new Error('ledger is down');
        written.push(args);
        return { summary: 'Refunded.', data: { refundId: `rf-${written.length}` } };
      },
    },
  );
  const registry = new ToolRegistry();
  registerFunctionalTool(registry, tool, []);
  const policy = new DefaultRolesPolicy();
  const call = (input: Record<string, unknown>, ctx = ALICE) =>
    registry.invoke('refund_order', input, ctx, policy) as Promise<Record<string, any>>;
  return { tool, call, written, state, store };
}

const ARGS = { orderId: 'o-1', amount: 10 };

describe('defineConfirmedTool', () => {
  it('is a read tool: the gate is inside it, not in the loop', () => {
    expect(setup().tool.spec.kind).toBe('read');
  });

  it('previews without writing, and says how to confirm', async () => {
    const { call, written } = setup();
    const preview = await call(ARGS);
    expect(preview).toMatchObject({
      status: 'preview',
      summary: 'Refund 10 on o-1?',
      data: ARGS,
    });
    expect(preview.confirmToken).toMatch(/^\d+\..+/);
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
    expect(preview.confirm).toContain('15 minutes');
    expect(written).toEqual([]);
  });

  it('commits on the same arguments plus confirm and the token', async () => {
    const { call, written } = setup();
    const { confirmToken } = await call(ARGS);
    // Key order is not part of "the same arguments".
    const done = await call({ confirmToken, amount: 10, confirm: true, orderId: 'o-1' });
    expect(done).toEqual({ status: 'done', summary: 'Refunded.', data: { refundId: 'rf-1' } });
    expect(written).toEqual([ARGS]);
  });

  it('treats confirm: false, and confirm without a token, as not a confirmation', async () => {
    const { call, written } = setup();
    const { confirmToken } = await call(ARGS);
    expect((await call({ ...ARGS, confirm: false, confirmToken })).status).toBe('preview');
    await expect(call({ ...ARGS, confirm: true })).rejects.toThrow(ConfirmTokenError);
    expect(written).toEqual([]);
  });

  it('refuses a confirmation whose arguments changed', async () => {
    const { call, written, state } = setup();
    const { confirmToken } = await call(ARGS);
    state.prepared = 0;
    await expect(
      call({ ...ARGS, amount: 1000, confirm: true, confirmToken }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(written).toEqual([]);
    // Refused before anything app-side ran.
    expect(state.prepared).toBe(0);
  });

  it('refuses another actor, and the same actor in another tenant', async () => {
    const { call, written } = setup();
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    const bob = ctxFor({ id: 'bob', roles: ['ADMIN'], tenantRef: 'acme' });
    const elsewhere = ctxFor({ id: 'alice', roles: ['ADMIN'], tenantRef: 'globex' });
    await expect(call(confirm, bob)).rejects.toMatchObject({ reason: 'invalid' });
    await expect(call(confirm, elsewhere)).rejects.toMatchObject({ reason: 'invalid' });
    expect(written).toEqual([]);
  });

  it('refuses the second confirmation with the same token', async () => {
    const { call, written } = setup();
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    await call(confirm);
    await expect(call(confirm)).rejects.toMatchObject({
      reason: 'used',
      message: expect.stringContaining('already confirmed'),
    });
    expect(written).toHaveLength(1);
  });

  it('commits exactly once when two confirmations race', async () => {
    const { call, written } = setup();
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    const results = await Promise.allSettled([call(confirm), call(confirm)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(written).toHaveLength(1);
  });

  it('does not spend the token when prepare refuses the confirmation', async () => {
    const { call, written, state } = setup();
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    state.refuse = 'the period is closed';
    await expect(call(confirm)).rejects.toThrow('the period is closed');
    expect(written).toEqual([]);
    state.refuse = undefined;
    expect((await call(confirm)).status).toBe('done');
    expect(written).toHaveLength(1);
  });

  it('gives the token back when commit fails', async () => {
    const { call, written, state } = setup();
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    state.failCommit = true;
    await expect(call(confirm)).rejects.toThrow('ledger is down');
    state.failCommit = false;
    expect((await call(confirm)).status).toBe('done');
    expect(written).toHaveLength(1);
  });

  it('without a store the token is NOT single use', async () => {
    const { call, written } = setup({ store: null });
    const { confirmToken } = await call(ARGS);
    const confirm = { ...ARGS, confirm: true, confirmToken };
    await call(confirm);
    await call(confirm);
    expect(written).toHaveLength(2);
  });

  it('takes overridden messages and a secret read per call', async () => {
    const written: unknown[] = [];
    let secret = 'first';
    const tool = defineConfirmedTool<{ id: string }, { id: string }>(
      {
        name: 'archive',
        description: 'Archive.',
        input: z.object({ id: z.string() }),
        secret: () => secret,
        ttlMs: 120_000,
        messages: { confirm: 'Confirme em {minutes} min.', invalid: 'Inválido.' },
      },
      {
        prepare: (args) => args,
        preview: () => ({ summary: 'Archive?' }),
        commit: (args) => {
          written.push(args);
          return { summary: 'Archived.' };
        },
      },
    );
    const preview = (await tool.handler.execute({ id: 'a' }, ALICE)) as Record<string, any>;
    expect(preview.confirm).toBe('Confirme em 2 min.');
    expect(preview).not.toHaveProperty('data');
    // The key was rotated between the preview and the confirmation: the old token is dead.
    secret = 'second';
    await expect(
      tool.handler.execute({ id: 'a', confirm: true, confirmToken: preview.confirmToken }, ALICE),
    ).rejects.toThrow('Inválido.');
    expect(written).toEqual([]);
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('refuses a token past its lifetime', async () => {
      const { call, written } = setup({ ttlMs: 60_000 });
      const { confirmToken } = await call(ARGS);
      const confirm = { ...ARGS, confirm: true, confirmToken };
      vi.advanceTimersByTime(60_001);
      await expect(call(confirm)).rejects.toMatchObject({ reason: 'invalid' });
      expect(written).toEqual([]);
    });
  });
});

describe('withConfirmFields', () => {
  const schema = withConfirmFields(z.object({ orderId: z.string() }).strict());

  it('validates the app schema without the two fields, and puts them back', async () => {
    const result = await schema['~standard'].validate({
      orderId: 'o-1',
      confirm: true,
      confirmToken: 'x',
    });
    expect(result).toEqual({ value: { orderId: 'o-1', confirm: true, confirmToken: 'x' } });
  });

  it('reports the app schema issues and its own', async () => {
    const result = await schema['~standard'].validate({ orderId: 1, confirm: 'yes' });
    expect(result.issues?.map((issue) => issue.path?.[0])).toEqual(['confirm', 'orderId']);
    expect((await schema['~standard'].validate('nope')).issues).toHaveLength(1);
  });

  it('reads a null field as absent', async () => {
    const result = await schema['~standard'].validate({ orderId: 'o-1', confirmToken: null });
    expect(result).toEqual({ value: { orderId: 'o-1' } });
  });

  it('advertises the app schema plus the two fields', () => {
    const standard = schema['~standard'] as unknown as {
      jsonSchema: { input(): Record<string, any> };
    };
    const json = standard.jsonSchema.input();
    expect(Object.keys(json.properties)).toEqual(['orderId', 'confirm', 'confirmToken']);
    expect(json.required).toEqual(['orderId']);
    expect(json.properties.confirm.type).toBe('boolean');
  });

  it('still declares the two fields over a schema that exposes no JSON Schema', () => {
    const bare = withConfirmFields({
      '~standard': { version: 1, vendor: 'bare', validate: (value: unknown) => ({ value }) },
    });
    const standard = bare['~standard'] as unknown as {
      jsonSchema: { input(): Record<string, any> };
    };
    expect(standard.jsonSchema.input()).toMatchObject({
      type: 'object',
      additionalProperties: true,
      properties: { confirm: { type: 'boolean' }, confirmToken: { type: 'string' } },
    });
  });

  it('a registry rejects a malformed confirmation as invalid input', async () => {
    const { call } = setup();
    await expect(call({ ...ARGS, confirm: 'yes' })).rejects.toThrow(ToolInputInvalidError);
  });
});
