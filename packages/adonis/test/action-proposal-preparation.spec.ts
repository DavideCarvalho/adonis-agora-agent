import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prepareActionProposal } from '../src/action-proposal-preparation.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/tool-registry.js';
import { createNoopEmitUi } from '../src/tool-ui.js';

const ctx: AiToolCtx = {
  actor: { id: 'requester' },
  threadId: 'thread',
  runId: 'run',
  requestId: 'request',
  emitUi: createNoopEmitUi('call'),
};

describe('trusted action proposal preparation', () => {
  it('retains raw input separately from the transformed approved snapshot', async () => {
    const registry = new ToolRegistry();
    const transform = vi.fn((value: number) => value + 1);
    const execute = vi.fn(async (input: unknown) => input);
    const preflight = vi.fn((input: unknown) => ({
      status: 'ready' as const,
      confirmation: { title: JSON.stringify(input), verb: 'Apply' },
    }));
    registry.register(
      {
        name: 'change',
        kind: 'action',
        description: '',
        inputSchema: z.object({ count: z.number().transform(transform) }),
      },
      { execute, preflight },
    );
    const prepared = await prepareActionProposal(
      registry,
      'change',
      { count: 1 },
      ctx,
      new DefaultRolesPolicy(),
    );
    expect(prepared.preparationInput).toEqual({ count: 1 });
    expect(prepared.input).toEqual({ count: 2 });
    expect(prepared.preflight).toEqual({
      status: 'ready',
      confirmation: { title: '{"count":2}', verb: 'Apply' },
    });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      registry.invoke('change', prepared.preparationInput, ctx, new DefaultRolesPolicy(), {
        approvedInput: prepared.input,
      }),
    ).resolves.toEqual({ count: 2 });
  });

  it('isolates raw input and confirmation from later producer mutations', async () => {
    const registry = new ToolRegistry();
    const raw = { nested: { value: 'before' } };
    const confirmation = { title: 'Before', verb: 'Apply' };
    registry.register(
      {
        name: 'change',
        kind: 'action',
        description: '',
        inputSchema: z.object({ nested: z.object({ value: z.string() }) }),
      },
      {
        execute: async () => null,
        preflight: () => ({ status: 'ready', confirmation }),
      },
    );
    const prepared = await prepareActionProposal(
      registry,
      'change',
      raw,
      ctx,
      new DefaultRolesPolicy(),
    );
    raw.nested.value = 'after';
    confirmation.title = 'After';
    expect(prepared.preparationInput).toEqual({ nested: { value: 'before' } });
    expect(prepared.input).toEqual({ nested: { value: 'before' } });
    expect(prepared.preflight).toEqual({
      status: 'ready',
      confirmation: { title: 'Before', verb: 'Apply' },
    });
  });

  it('preserves raw null so it is not replaced with the normalized input', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'change',
        kind: 'action',
        description: '',
        inputSchema: z.null().transform(() => ({ value: 1 })),
      },
      { execute: async () => null },
    );
    const prepared = await prepareActionProposal(
      registry,
      'change',
      null,
      ctx,
      new DefaultRolesPolicy(),
    );
    expect(prepared.preparationInput).toBeNull();
    expect(prepared.input).toEqual({ value: 1 });
  });
});
