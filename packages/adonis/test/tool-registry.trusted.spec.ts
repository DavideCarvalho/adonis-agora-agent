import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createNoopEmitUi,
  DefaultRolesPolicy,
  ToolInputDriftError,
  ToolRegistry,
} from '../src/index.js';

const ctx = {
  actor: { id: 'owner' },
  threadId: 'thread',
  runId: 'run',
  requestId: 'request',
  emitUi: createNoopEmitUi(),
};
const policy = new DefaultRolesPolicy();
const strict = { snapshotInput: true };
function firstRow(input: { rows: { amount: number }[] }) {
  const row = input.rows[0];
  if (row === undefined) throw new Error('Expected a row in this test input');
  return row;
}
function register(
  schema: z.ZodType,
  preflight = vi.fn((_input: unknown) => ({ status: 'ready' as const })),
) {
  const registry = new ToolRegistry();
  const execute = vi.fn(async (input: unknown) => input);
  registry.register(
    { name: 'write', kind: 'action', description: 'write', inputSchema: schema },
    { preflight, execute },
  );
  return { registry, preflight, execute };
}
describe('trusted normalized preparation', () => {
  it('exposes defaults and a nonidempotent transform with one validation and hook', async () => {
    const transform = vi.fn((amount: number) => amount + 1);
    const { registry, preflight, execute } = register(
      z.object({ amount: z.number().default(3).transform(transform) }),
    );
    const prepared = await registry.prepareValidated('write', {}, ctx, policy, strict);
    expect(prepared).toEqual({ input: { amount: 4 }, preflight: { status: 'ready' } });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await registry.invoke('write', {}, ctx, policy, { approvedInput: prepared.input }),
    ).toEqual({ amount: 4 });
    expect(transform).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith({ amount: 4 }, ctx);
  });
  it.each(['default', 'transform'])(
    'rejects a changed %s before execute preflight or effects',
    async (mode) => {
      let version = 3;
      const schema =
        mode === 'default'
          ? z.object({ amount: z.number().default(() => version) })
          : z.object({ amount: z.number().transform((value) => value + version) });
      const raw = mode === 'default' ? {} : { amount: 1 };
      const { registry, preflight, execute } = register(schema);
      const prepared = await registry.prepareValidated('write', raw, ctx, policy, strict);
      preflight.mockClear();
      version++;
      await expect(
        registry.invoke('write', raw, ctx, policy, { approvedInput: prepared.input }),
      ).rejects.toBeInstanceOf(ToolInputDriftError);
      expect(preflight).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('accepts canonical key order equality and distinguishes explicit undefined approval input', async () => {
    const { registry, preflight, execute } = register(z.object({ a: z.number(), b: z.number() }));
    expect(
      await registry.invoke('write', { a: 1, b: 2 }, ctx, policy, {
        approvedInput: { b: 2, a: 1 },
      }),
    ).toEqual({ a: 1, b: 2 });
    preflight.mockClear();
    execute.mockClear();
    await expect(
      registry.invoke('write', { a: 1, b: 2 }, ctx, policy, { approvedInput: undefined }),
    ).rejects.toBeInstanceOf(ToolInputDriftError);
    expect(preflight).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await registry.invoke('write', { a: 1, b: 2 }, ctx, policy)).toEqual({ a: 1, b: 2 });
  });
  it('isolates nested normalized snapshots from later source and handler references', async () => {
    let hookInput: unknown;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'write',
        kind: 'action',
        description: 'write',
        inputSchema: z.object({ rows: z.array(z.object({ amount: z.number() })) }),
      },
      {
        execute: async (input) => input,
        preflight: (input) => {
          hookInput = input;
          return { status: 'ready' };
        },
      },
    );
    const raw = { rows: [{ amount: 3 }] };
    const prepared = await registry.prepareValidated('write', raw, ctx, policy, strict);
    firstRow(raw).amount = 9;
    firstRow(hookInput as typeof raw).amount = 12;
    expect(prepared.input).toEqual({ rows: [{ amount: 3 }] });
  });
  it('rejects nested hook mutation after an asynchronous prepare hook settles', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn();
    registry.register(
      {
        name: 'write',
        kind: 'action',
        description: 'write',
        inputSchema: z.object({ rows: z.array(z.object({ amount: z.number() })) }),
      },
      {
        execute,
        preflight: async (input: { rows: { amount: number }[] }) => {
          await Promise.resolve();
          firstRow(input).amount = 8;
          return { status: 'ready', confirmation: { title: 'Write 8?', verb: 'Write' } };
        },
      },
    );
    await expect(
      registry.prepareValidated('write', { rows: [{ amount: 3 }] }, ctx, policy, strict),
    ).rejects.toBeInstanceOf(ToolInputDriftError);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['ready', 'completed'] as const)(
    'refuses mutation during trusted execute preflight even for %s',
    async (status) => {
      const registry = new ToolRegistry();
      const execute = vi.fn();
      registry.register(
        {
          name: 'write',
          kind: 'action',
          description: 'write',
          inputSchema: z.object({ rows: z.array(z.object({ amount: z.number() })) }),
        },
        {
          execute,
          preflight: async (input: { rows: { amount: number }[] }) => {
            await Promise.resolve();
            firstRow(input).amount = 8;
            return status === 'ready' ? { status } : { status, output: 'existing' };
          },
        },
      );
      await expect(
        registry.invoke('write', { rows: [{ amount: 3 }] }, ctx, policy, {
          approvedInput: { rows: [{ amount: 3 }] },
        }),
      ).rejects.toBeInstanceOf(ToolInputDriftError);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('isolates handler input from retained execute-preflight references', async () => {
    const registry = new ToolRegistry();
    let hookInput: { amount: number } | undefined;
    registry.register(
      {
        name: 'write',
        kind: 'action',
        description: 'write',
        inputSchema: z.object({ amount: z.number() }),
      },
      {
        preflight: (input: { amount: number }) => {
          hookInput = input;
          return { status: 'ready' };
        },
        execute: async (input: { amount: number }) => {
          if (hookInput) hookInput.amount = 8;
          return input.amount;
        },
      },
    );
    expect(
      await registry.invoke('write', { amount: 3 }, ctx, policy, { approvedInput: { amount: 3 } }),
    ).toBe(3);
  });
  it('retains nonJSON schema outputs for ordinary prepare and invoke', async () => {
    const schema = z.string().transform((value) => new Date(value));
    const { registry, preflight } = register(schema);
    expect(await registry.prepare('write', '2026-10-01', ctx, policy)).toEqual({ status: 'ready' });
    expect(preflight.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(
      (await registry.prepareValidated('write', '2026-10-01', ctx, policy)).input,
    ).toBeInstanceOf(Date);
    expect(await registry.invoke('write', '2026-10-01', ctx, policy)).toEqual(
      new Date('2026-10-01'),
    );
  });
  it('preserves authorization and allowlist precedence before parsing or trusted comparison', async () => {
    const transform = vi.fn((value: number) => value);
    const { registry, preflight, execute } = register(z.number().transform(transform));
    await expect(
      registry.prepareValidated('write', 3, ctx, policy, { ...strict, allowedTools: [] }),
    ).rejects.toThrow('not allowed');
    await expect(
      registry.invoke('write', 3, ctx, { can: () => false }, { approvedInput: undefined }),
    ).rejects.toThrow('not allowed');
    await expect(
      registry.invoke('write', 3, ctx, policy, { allowedTools: [], approvedInput: undefined }),
    ).rejects.toThrow('not allowed');
    await expect(registry.prepareValidated('write', 'bad', ctx, policy, strict)).rejects.toThrow(
      'Invalid input',
    );
    expect(transform).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
