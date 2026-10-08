import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineCatalog, defineComponent } from '../src/genui/catalog.js';
import { genuiTools } from '../src/genui/tools.js';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ModelTurnArgs,
  runAgentLoop,
  ToolNotFoundError,
  ToolRegistry,
} from '../src/index.js';
import type { AiToolCtx } from '../src/spi/tool.js';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '../src/testing/index.js';
import type { UiCapabilities } from '../src/ui-capabilities.js';

/**
 * A tool whose `describe()` answers `available: false` for a turn is left out of what the model is
 * offered. A model that names it anyway must be refused the way an unknown tool is, not run.
 */

const actor = { id: 'u1', roles: ['ADMIN'] };
const catalog = defineCatalog([
  defineComponent({
    name: 'Text',
    title: 'Text',
    description: 'A line of text.',
    props: { type: 'object', properties: { text: { type: 'string' } } },
  }),
]);
const tree = { type: 'Text', props: { text: 'Dashboard' } };

function ctx(uiCapabilities?: UiCapabilities): {
  ctx: AiToolCtx;
  emitUi: ReturnType<typeof vi.fn>;
} {
  const emitUi = vi.fn(async () => ({ id: 'call-1:ui:0' }));
  return {
    ctx: {
      actor,
      threadId: 't1',
      runId: 'r1',
      requestId: 'r1',
      emitUi,
      ...(uiCapabilities !== undefined ? { uiCapabilities } : {}),
    },
    emitUi,
  };
}

describe('ToolRegistry.invoke refuses a tool describe() hid for this scope', () => {
  it('refuses ui__render when the renderer declares no components', async () => {
    const registry = new ToolRegistry();
    for (const tool of genuiTools(catalog, { mode: 'tree', roles: ['ADMIN'] })) {
      registry.register(tool.spec, tool.handler);
    }
    const { ctx: hidden, emitUi } = ctx({ components: [] });
    await expect(
      registry.invoke('ui__render', tree, hidden, new DefaultRolesPolicy()),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
    expect(emitUi).not.toHaveBeenCalled();

    // The same call with no capability narrowing still renders.
    const { ctx: open, emitUi: openEmit } = ctx();
    await registry.invoke('ui__render', tree, open, new DefaultRolesPolicy());
    expect(openEmit).toHaveBeenCalledTimes(1);
  });

  it('refuses a ui__show_* tool whose component the renderer does not declare', async () => {
    const registry = new ToolRegistry();
    for (const tool of genuiTools(catalog, { roles: ['ADMIN'] })) {
      registry.register(tool.spec, tool.handler);
    }
    const { ctx: hidden, emitUi } = ctx({ components: [{ name: 'Other', version: 1 }] });
    await expect(
      registry.invoke('ui__show_text', { text: 'x' }, hidden, new DefaultRolesPolicy()),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
    expect(emitUi).not.toHaveBeenCalled();
  });

  it('refuses any tool whose describe() answers available: false, with the scope of the call', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ ok: true }));
    const describe = vi.fn(async (scope: { agentName?: string }) =>
      scope.agentName === 'blocked' ? { available: false } : undefined,
    );
    registry.register(
      {
        name: 'gated',
        kind: 'read',
        description: 'g',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      { execute, describe },
    );
    const { ctx: base } = ctx();
    await expect(
      registry.invoke('gated', {}, { ...base, agentName: 'blocked' }, new DefaultRolesPolicy()),
    ).rejects.toThrow('Tool "gated" is not registered');
    expect(execute).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({ actor, threadId: 't1', agentName: 'blocked' }),
    );

    await expect(
      registry.invoke('gated', {}, { ...base, agentName: 'open' }, new DefaultRolesPolicy()),
    ).resolves.toEqual({ ok: true });
  });
});

describe('the agent loop refuses a call to a tool it did not offer this turn', () => {
  async function run(uiCapabilities?: UiCapabilities) {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor, persona: 'default' });
    const registry = new ToolRegistry();
    for (const tool of genuiTools(catalog, { mode: 'tree', roles: ['ADMIN'] })) {
      registry.register(tool.spec, tool.handler);
    }
    const offered: string[][] = [];
    const seenByTurn: ModelTurnArgs['messages'][] = [];
    const deps: AgentLoopDeps = {
      model: {
        async runTurn(args) {
          offered.push(args.tools.map((tool) => tool.name));
          seenByTurn.push(args.messages);
          const first = seenByTurn.length === 1;
          await args.sink.write({ t: 'text', v: first ? '' : 'done' });
          return {
            text: first ? '' : 'done',
            // The model calls ui__render whether or not it was offered.
            toolCalls: first ? [{ id: 'call-render', name: 'ui__render', input: tree }] : [],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      store,
      registry,
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-06-30',
      systemPrompt: 'test',
    };
    const hooks: AgentLoopHooks = {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };
    await runAgentLoop(
      deps,
      {
        threadId: thread.id,
        actor,
        userText: 'Show a dashboard',
        ...(uiCapabilities !== undefined ? { uiCapabilities } : {}),
      },
      hooks,
    );
    const saved = await store.getThread(thread.id);
    return {
      offered,
      seenByTurn,
      ui: saved?.messages.flatMap((message) => message.ui ?? []) ?? [],
    };
  }

  it('refuses ui__render like an unknown tool when uiCapabilities has no components', async () => {
    const { offered, seenByTurn, ui } = await run({ components: [] });
    expect(offered[0]).not.toContain('ui__render');
    expect(ui).toEqual([]);
    // The model is told the tool does not exist, and gets a second step to answer in text.
    expect(JSON.stringify(seenByTurn[1])).toContain('Tool \\"ui__render\\" is not registered');
  });

  it('still renders when the renderer supports the catalog', async () => {
    const { offered, ui } = await run();
    expect(offered[0]).toContain('ui__render');
    expect(ui).toHaveLength(1);
  });
});
