import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Actor,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  AgentSseEncoder,
  type AgentStreamEvent,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  ToolRegistry,
  unwrapToolStepOutput,
  wrapToolStepOutput,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript, InMemoryAgentStore } from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

function build(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink: new InProcessTokenStreamSink(),
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents: new AgentRegistry(),
  });
  return {
    store,
    registry,
    service: new AgentService(new InlineAgentRunner(factory, store), store, factory),
  };
}

async function run(g: ReturnType<typeof build>) {
  const { runId, threadId } = await g.service.chat({ actor, message: 'show me' });
  const encoder = new AgentSseEncoder();
  const events: AgentStreamEvent[] = [];
  for await (const frame of g.service.subscribe(runId)) {
    for (const chunk of encoder.encode(frame).split('\n\n')) {
      const data = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) events.push(JSON.parse(data.slice(6)) as AgentStreamEvent);
    }
  }
  return { events, thread: await g.store.getThread(threadId) };
}

describe('ctx.emitUi', () => {
  it('presents a completed prepare preflight in the actual agent loop', async () => {
    const g = build((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'orders', input: {} } }
        : { text: 'Already saved.' },
    );
    g.registry.register(
      {
        name: 'orders',
        kind: 'action',
        description: 'orders',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        execute: () => {
          throw new Error('must not execute');
        },
        preflight: () => ({ status: 'completed', output: { saved: true } }),
        present: () => ({
          component: 'History',
          props: { label: 'Saved' },
          version: 1,
          fallbackText: 'Saved',
        }),
      },
    );
    const { events, thread } = await run(g);
    expect(events.filter((event) => event.kind === 'ui')).toHaveLength(1);
    expect(thread?.messages.flatMap((message) => message.ui ?? [])).toMatchObject([
      { component: 'History', props: { label: 'Saved' } },
    ]);
  });
  it('streams and persists present() output while retaining the domain tool result', async () => {
    const g = build((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'orders', input: {} } }
        : { text: 'Here they are.' },
    );
    g.registry.register(
      {
        name: 'orders',
        kind: 'read',
        description: 'orders',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        execute: () => ({ count: 2 }),
        present: () => ({
          component: 'DataTable',
          props: { rows: [1, 2] },
          version: 1,
          fallbackText: 'Two orders',
        }),
      },
    );
    const { events, thread } = await run(g);
    expect(events.filter((event) => event.kind === 'ui')).toEqual([
      {
        kind: 'ui',
        id: 'call-0-orders:ui:0',
        component: 'DataTable',
        props: { rows: [1, 2] },
        version: 1,
        fallbackText: 'Two orders',
        toolCallId: 'call-0-orders',
      },
    ]);
    expect(events.find((event) => event.kind === 'tool-output')).toMatchObject({
      output: { count: 2 },
    });
    expect(
      thread?.messages.find((message) => message.toolCalls?.[0]?.name === 'orders')?.ui,
    ).toMatchObject([
      { component: 'DataTable', props: { rows: [1, 2] }, version: 1, fallbackText: 'Two orders' },
    ]);
  });

  it('streams each push, replaces a repeat id, and persists them on the message that called', async () => {
    const g = build((_args, turn) =>
      turn === 0
        ? { text: '', toolCall: { name: 'orders', input: {} } }
        : { text: 'Here they are.' },
    );
    g.registry.register(
      {
        name: 'orders',
        kind: 'read',
        description: 'orders',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        execute: async (_input, ctx) => {
          const { id } = await ctx.emitUi('DataTable', { rows: [] }, { version: 2 });
          await ctx.emitUi('DataTable', { rows: [1, 2] }, { id, version: 2 });
          await ctx.emitComponent?.('Legacy', 7);
          return { count: 2 };
        },
      },
    );
    const { events, thread } = await run(g);
    expect(events.filter((event) => event.kind === 'ui')).toEqual([
      {
        kind: 'ui',
        id: 'call-0-orders:ui:0',
        component: 'DataTable',
        props: { rows: [] },
        version: 2,
        toolCallId: 'call-0-orders',
      },
      {
        kind: 'ui',
        id: 'call-0-orders:ui:0',
        component: 'DataTable',
        props: { rows: [1, 2] },
        version: 2,
        toolCallId: 'call-0-orders',
      },
      {
        kind: 'ui',
        id: 'call-0-orders:ui:1',
        component: 'Legacy',
        props: { value: 7 },
        toolCallId: 'call-0-orders',
      },
    ]);
    const caller = thread?.messages.find((message) => message.toolCalls?.[0]?.name === 'orders');
    expect(caller?.ui).toEqual([
      {
        id: 'call-0-orders:ui:0',
        component: 'DataTable',
        props: { rows: [1, 2] },
        version: 2,
        toolCallId: 'call-0-orders',
      },
      {
        id: 'call-0-orders:ui:1',
        component: 'Legacy',
        props: { value: 7 },
        toolCallId: 'call-0-orders',
      },
    ]);
  });

  it('ends the turn after a terminal tool succeeds — no model call narrates it', async () => {
    let calls = 0;
    const g = build(() => {
      calls += 1;
      return { text: '', toolCall: { name: 'showChart', input: {} } };
    });
    g.registry.register(
      {
        name: 'showChart',
        kind: 'read',
        description: 'chart',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
        terminal: true,
      },
      { execute: async (_input, ctx) => ctx.emitUi('Chart', { points: [] }) },
    );
    const { events } = await run(g);
    expect(calls).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      'step-start',
      'tool-input-available',
      'ui',
      'tool-output',
      'step-finish',
      'title',
    ]);
  });

  it('keeps a step result that pushed nothing byte-identical, and reads an envelope back', () => {
    expect(wrapToolStepOutput({ a: 1 }, [])).toEqual({ a: 1 });
    const ui = [{ id: 'c:ui:0', component: 'X', props: {}, toolCallId: 'c' }];
    expect(unwrapToolStepOutput(wrapToolStepOutput({ a: 1 }, ui))).toEqual({
      output: { a: 1 },
      ui,
    });
    expect(unwrapToolStepOutput('raw')).toEqual({ output: 'raw', ui: [] });
  });
});
