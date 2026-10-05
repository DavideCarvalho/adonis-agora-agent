import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiTool, defineTool, readAiToolMeta } from '../src/ai-tool-ref.js';
import type { AiToolCtx, ToolHandler } from '../src/spi/tool.js';
import { registerToolExport } from '../src/tool-discovery.js';
import { DefaultRolesPolicy, ToolRegistry } from '../src/tool-registry.js';

const policy = new DefaultRolesPolicy();
const spec = {
  name: 'history',
  kind: 'read' as const,
  description: 'History',
  inputSchema: z.object({}),
};
const presentation = (label: string) => ({
  component: 'History',
  props: { label },
  version: 1,
  fallbackText: label,
});
function context(): AiToolCtx {
  return {
    actor: { id: 'u1' },
    runId: 'r1',
    threadId: 't1',
    requestId: 'r1',
    emitUi: vi.fn(async () => ({ id: 'ui1' })),
  };
}

describe('tool result presentation', () => {
  it('forwards present through class discovery', async () => {
    @AiTool({ name: 'history', description: 'History', input: z.object({}) })
    class History {
      readonly label = 'Discovered';
      execute() {
        return this.label;
      }
      present() {
        return presentation(this.label);
      }
    }
    const registry = new ToolRegistry();
    expect(registerToolExport(registry, History, [])).toEqual({ name: 'history', source: 'class' });
    const ctx = context();
    expect(await registry.invoke('history', {}, ctx, policy)).toBe('Discovered');
    expect(ctx.emitUi).toHaveBeenCalledWith('History', { label: 'Discovered' }, expect.anything());
  });

  it('calls an object-form canUse exactly once with its receiver', async () => {
    let gates = 0;
    const tool = defineTool({
      name: 'history',
      description: 'History',
      input: z.object({}),
      canUse() {
        gates += 1;
        return this.name === 'history';
      },
      execute: () => 1,
      present: () => presentation('One'),
    });
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    await registry.invoke('history', {}, context(), policy);
    expect(gates).toBe(1);
  });
  it('emits the presentation while preserving the raw domain output', async () => {
    const output = { count: 3 };
    const handler = {
      execute: () => output,
      present: (result: typeof output) => presentation(`${result.count} records`),
    };
    const registry = new ToolRegistry();
    registry.register(spec, handler);
    const ctx = context();
    expect(await registry.invoke('history', {}, ctx, policy)).toBe(output);
    expect(ctx.emitUi).toHaveBeenCalledWith(
      'History',
      { label: '3 records' },
      { version: 1, fallbackText: '3 records' },
    );
  });

  it('supports a decorated class and preserves its instance state', async () => {
    @AiTool({ name: 'history', description: 'History', input: z.object({}) })
    class History {
      readonly label = 'From class';
      execute() {
        return { count: 1 };
      }
      present() {
        return presentation(this.label);
      }
    }
    expect(readAiToolMeta(History)?.name).toBe('history');
    const registry = new ToolRegistry();
    registry.register(spec, new History());
    const ctx = context();
    await registry.invoke('history', {}, ctx, policy);
    expect(ctx.emitUi).toHaveBeenCalledWith('History', { label: 'From class' }, expect.anything());
  });

  it('presents every component in order', async () => {
    const registry = new ToolRegistry();
    registry.register(spec, {
      execute: () => 1,
      present: () => [presentation('First'), presentation('Second')],
    });
    const ctx = context();
    await registry.invoke('history', {}, ctx, policy);
    expect(vi.mocked(ctx.emitUi).mock.calls.map((call) => call[1])).toEqual([
      { label: 'First' },
      { label: 'Second' },
    ]);
  });

  it('does not present an unsuccessful execution', async () => {
    const present = vi.fn();
    const registry = new ToolRegistry();
    registry.register(spec, {
      execute: () => {
        throw new Error('domain failure');
      },
      present,
    });
    await expect(registry.invoke('history', {}, context(), policy)).rejects.toThrow(
      'domain failure',
    );
    expect(present).not.toHaveBeenCalled();
  });

  it('does not execute or present a forbidden tool', async () => {
    const execute = vi.fn();
    const present = vi.fn();
    const registry = new ToolRegistry();
    registry.register({ ...spec, roles: ['ADMIN'] }, { execute, present });
    await expect(registry.invoke('history', {}, context(), policy)).rejects.toThrow('not allowed');
    expect(execute).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });

  it('presents an already completed preflight without executing again', async () => {
    const execute = vi.fn();
    const output = { saved: true };
    const registry = new ToolRegistry();
    registry.register(
      { ...spec, kind: 'action' },
      {
        execute,
        preflight: () => ({ status: 'completed', output }),
        present: () => presentation('Saved'),
      },
    );
    const ctx = context();
    expect(await registry.invoke('history', {}, ctx, policy)).toBe(output);
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.emitUi).toHaveBeenCalledOnce();
  });

  it('reports failed presentation without converting a successful write into failure', async () => {
    const execute = vi.fn(() => ({ saved: true }));
    const failure = new Error('renderer failed');
    const report = vi.fn();
    const ctx = { ...context(), onPresentationError: report };
    const registry = new ToolRegistry();
    registry.register(
      { ...spec, kind: 'action' },
      {
        execute,
        present: () => {
          throw failure;
        },
      },
    );
    await expect(registry.invoke('history', {}, ctx, policy)).resolves.toEqual({ saved: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(failure, { toolName: 'history' });
  });

  it('reports failed emission while keeping the successful domain result', async () => {
    const failure = new Error('sink failed');
    const report = vi.fn();
    const ctx = {
      ...context(),
      emitUi: vi.fn(async () => {
        throw failure;
      }),
      onPresentationError: report,
    };
    const registry = new ToolRegistry();
    registry.register(spec, { execute: () => 5, present: () => presentation('Five') });
    expect(await registry.invoke('history', {}, ctx, policy)).toBe(5);
    expect(report).toHaveBeenCalledWith(failure, { toolName: 'history' });
  });

  it('validates the whole presentation batch before emitting any item', async () => {
    const ctx = { ...context(), onPresentationError: vi.fn() };
    const registry = new ToolRegistry();
    registry.register(spec, {
      execute: () => 5,
      present: () => [presentation('Valid'), { ...presentation('Invalid'), version: 0 }],
    });
    expect(await registry.invoke('history', {}, ctx, policy)).toBe(5);
    expect(ctx.emitUi).not.toHaveBeenCalled();
    expect(ctx.onPresentationError).toHaveBeenCalledOnce();
  });

  it('retains present and this binding in the existing functional handler form', async () => {
    const handler = {
      label: 'Instance',
      execute() {
        return this.label;
      },
      present() {
        return presentation(this.label);
      },
    };
    const tool = defineTool(
      { name: 'history', description: 'History', input: z.object({}) },
      handler,
    );
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    const ctx = context();
    expect(await registry.invoke('history', {}, ctx, policy)).toBe('Instance');
    expect(ctx.emitUi).toHaveBeenCalledWith('History', { label: 'Instance' }, expect.anything());
  });

  it('accepts an inferred functional object with execute and present', async () => {
    const tool = defineTool({
      name: 'history',
      description: 'History',
      input: z.object({ count: z.number() }),
      execute: ({ count }) => ({ label: `${count} records` }),
      present: (result) => presentation(result.label),
    });
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    const ctx = context();
    expect(await registry.invoke('history', { count: 4 }, ctx, policy)).toEqual({
      label: '4 records',
    });
    expect(ctx.emitUi).toHaveBeenCalledWith('History', { label: '4 records' }, expect.anything());
  });

  it('permits a presentation hook to choose no component', async () => {
    const handler: ToolHandler = { execute: () => 1, present: () => undefined };
    const registry = new ToolRegistry();
    registry.register(spec, handler);
    const ctx = context();
    expect(await registry.invoke('history', {}, ctx, policy)).toBe(1);
    expect(ctx.emitUi).not.toHaveBeenCalled();
  });
});
