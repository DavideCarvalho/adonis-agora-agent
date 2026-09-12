import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Actor, QuotaStore } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  AuthActorResolver,
  DefaultToolAuthorizer,
  HeaderActorResolver,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  registerDelegateTools,
  ToolRegistry,
  UnconfiguredActorResolver,
} from '../src/index.js';
import { FakeModelProvider, type FakeScript, InMemoryQuotaStore } from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => Promise<boolean>, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor: condition never became true');
}

interface Graph {
  service: AgentService;
  store: LucidAgentStore;
  sink: InProcessTokenStreamSink;
  registry: ToolRegistry;
  db: Database;
}

function buildGraph(
  script: FakeScript,
  quota?: QuotaStore,
  agentDefs: Parameters<AgentRegistry['register']>[0][] = [],
): Graph {
  const db = dbHandle;
  const store = new LucidAgentStore(asStoreDb(db));
  const sink = new InProcessTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  for (const def of agentDefs) agents.register(def);
  registerDelegateTools(registry, agents);
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink,
    rolesPolicy: new DefaultToolAuthorizer(),
    registry,
    agents,
    ...(quota !== undefined ? { quota } : {}),
  });
  const runner = new InlineAgentRunner(factory, store);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry, db };
}

/**
 * The first `approval` frame to arrive in `runId`'s stream, and the run+call it says to answer. For
 * a delegated child that is NOT `runId` — which is the whole point of the id being on the frame.
 */
async function waitForFrame(
  g: Graph,
  runId: string,
): Promise<{ runId: string; toolCallId: string }> {
  for await (const frame of g.service.subscribe(runId)) {
    if (frame.t === 'approval') {
      return { runId: frame.runId, toolCallId: frame.id };
    }
  }
  throw new Error('no approval frame arrived on the stream');
}

async function collectStream(g: Graph, runId: string): Promise<string> {
  let text = '';
  for await (const frame of g.service.subscribe(runId)) {
    if (frame.t === 'text') text += frame.v;
  }
  return text;
}

let dbHandle: Database;
beforeEach(async () => {
  dbHandle = await makeStoreDb();
});
afterEach(async () => {
  await dbHandle.manager.closeAll();
});

describe('InlineAgentRunner + AgentService over the Lucid store', () => {
  it('streams tokens and persists the user + assistant messages', async () => {
    const g = buildGraph(() => ({ text: 'Hello from the agent' }));
    const { runId, threadId } = await g.service.chat({ actor, message: 'hi' });

    const streamed = await collectStream(g, runId);
    expect(streamed).toContain('Hello from the agent');

    const detail = await g.store.getThread(threadId);
    expect(detail?.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello from the agent' },
    ]);
    // A usage row was recorded for the turn.
    const day = new Date().toISOString().slice(0, 10);
    const { usedTokens } = await g.store.quotaToday(actor.id, day);
    expect(usedTokens).toBeGreaterThan(0);
  });

  it('sets the active stream id on the thread when a chat starts', async () => {
    const g = buildGraph(() => ({ text: 'ok' }));
    const { runId, threadId } = await g.service.chat({ actor, message: 'hi' });
    await collectStream(g, runId);
    const row = await g.db.from('agent_thread').where('id', threadId).first();
    expect(row?.active_stream_id).toBe(runId);
  });

  it('flips a pending action tool call to executed on approve (recording executed_by_ref)', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'let me act', toolCall: { name: 'danger', input: { k: 'v' } } }
        : { text: 'done' };
    const g = buildGraph(script);
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({ k: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({ acted: true }) },
    );

    const { runId } = await g.service.chat({ actor, message: 'do it' });
    const toolCallId = 'call-0-danger';

    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'pending_approval';
    });
    await g.service.approve(runId, toolCallId);

    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'executed';
    });
    const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
    expect(row?.executed_by_ref).toBe('u1');
    expect(JSON.parse(String(row?.output))).toEqual({ acted: true });
  });

  it('flips a pending action tool call to rejected on reject (tool never runs)', async () => {
    let ran = false;
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'let me act', toolCall: { name: 'danger', input: { k: 'v' } } }
        : { text: 'done' };
    const g = buildGraph(script);
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({ k: z.string() }),
        roles: ['ADMIN'],
      },
      {
        execute: async () => {
          ran = true;
          return {};
        },
      },
    );

    const { runId } = await g.service.chat({ actor, message: 'do it' });
    const toolCallId = 'call-0-danger';
    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'pending_approval';
    });
    await g.service.reject(runId, toolCallId, 'nope');
    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'rejected';
    });
    const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
    expect(row?.error).toBe('nope');
    expect(ran).toBe(false);
  });

  it('never records an answers-shaped reply to a parked approval as a human rejection', async () => {
    // The bug this pins: an `ElicitationReply` carries no `approved`, and `!undefined` is true — so
    // a form submitted against the wrong tool call id used to persist as `rejected`, a decision the
    // operator never made and which nothing afterwards distinguishes from one they did.
    let ran = false;
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'let me act', toolCall: { name: 'danger', input: { k: 'v' } } }
        : { text: 'done' };
    const g = buildGraph(script);
    g.registry.register(
      {
        name: 'danger',
        kind: 'action',
        description: 'dangerous',
        inputSchema: z.object({ k: z.string() }),
        roles: ['ADMIN'],
      },
      {
        execute: async () => {
          ran = true;
          return { acted: true };
        },
      },
    );

    const { runId } = await g.service.chat({ actor, message: 'do it' });
    const toolCallId = 'call-0-danger';
    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'pending_approval';
    });

    // A misdirected answer. Refused at the door, because this runner knows which wait is parked.
    await expect(g.service.answer({ runId, toolCallId, answers: {} })).rejects.toThrow(
      /waiting for an approve\/reject/,
    );
    // And a skip, which would have landed as a rejection carrying "skipped by the user".
    await expect(g.service.skip({ runId, toolCallId })).rejects.toThrow(
      /waiting for an approve\/reject/,
    );

    // The approval is still there to make: nothing was decided, nothing ran.
    const parked = await g.db.from('agent_tool_call').where('id', toolCallId).first();
    expect(parked?.status).toBe('pending_approval');
    expect(ran).toBe(false);

    // ...and the real decision still settles it.
    await g.service.approve(runId, toolCallId);
    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', toolCallId).first();
      return row?.status === 'executed';
    });
    expect(ran).toBe(true);
  });

  it('lets a human answer a delegated child’s HITL wait through the run id on its frame', async () => {
    // The mirror of the durable runner's `sinkRunId`: the nested run writes into the ancestor's
    // stream (the only one anyone subscribed to) and parks under its OWN runId, which rides on the
    // frame. Before that, the nested run declined and the human never got to decide at all.
    let ran = false;
    const script: FakeScript = (args, turnIndex) => {
      const hasDelegate = args.tools.some((t) => t.name === 'ask_helper');
      if (hasDelegate) {
        return turnIndex === 0
          ? { text: 'delegating', toolCall: { name: 'ask_helper', input: { task: 'help me' } } }
          : { text: 'all done' };
      }
      return turnIndex === 0
        ? { text: 'let me act', toolCall: { name: 'voidInvoice', input: { id: 'i-1' } } }
        : { text: 'helper answer' };
    };
    const g = buildGraph(script, undefined, [
      { name: 'orchestrator', delegatesTo: ['helper'] },
      { name: 'helper', systemPrompt: 'You are a helper.', tools: ['voidInvoice'] },
    ]);
    g.registry.register(
      {
        name: 'voidInvoice',
        kind: 'action',
        description: 'Void an invoice.',
        inputSchema: z.object({ id: z.string() }),
        roles: ['ADMIN'],
      },
      {
        execute: async () => {
          ran = true;
          return { voided: true };
        },
      },
    );

    const { runId } = await g.service.chat({
      actor,
      message: 'coordinate',
      agentName: 'orchestrator',
    });

    const parked = await waitForFrame(g, runId);
    expect(parked.runId).not.toBe(runId);
    expect(parked.toolCallId).toBe('call-0-voidInvoice');

    await g.service.approve(parked.runId, parked.toolCallId);

    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', 'call-0-voidInvoice').first();
      return row?.status === 'executed';
    });
    expect(ran).toBe(true);
    await waitFor(async () => {
      const row = await g.db.from('agent_tool_call').where('id', 'call-0-ask_helper').first();
      return row?.status === 'executed';
    });
  });

  it('quotaToday via the service returns the day token total', async () => {
    const g = buildGraph(() => ({ text: 'answer' }), new InMemoryQuotaStore());
    const { runId } = await g.service.chat({ actor, message: 'hi' });
    await collectStream(g, runId);
    const { usedTokens } = await g.service.quotaToday(actor.id);
    expect(usedTokens).toBeGreaterThan(0);
  });

  it('fail-closes on an exceeded quota before the model runs (surfaced on the stream)', async () => {
    // Limit 0 → check() reports over-budget on the first turn, before any model call.
    const g = buildGraph(() => ({ text: 'should not stream' }), new InMemoryQuotaStore(0));
    const { runId } = await g.service.chat({ actor, message: 'hi' });
    const streamed = await collectStream(g, runId);
    expect(streamed).toContain('[error]');
    expect(streamed).toContain('quota');
  });
});

describe('actor resolvers', () => {
  it('UnconfiguredActorResolver throws — never fabricates an identity', () => {
    expect(() => new UnconfiguredActorResolver().resolve()).toThrow(/refuses to fabricate/);
  });

  it('HeaderActorResolver reads x-actor-id / x-actor-role and throws without an id', () => {
    const resolver = new HeaderActorResolver();
    const ctx = {
      request: {
        header: (n: string) => ({ 'x-actor-id': 'u9', 'x-actor-role': 'ADMIN, EDITOR' })[n],
      },
    };
    expect(resolver.resolve(ctx)).toEqual({ id: 'u9', roles: ['ADMIN', 'EDITOR'] });
    expect(() => resolver.resolve({ request: { header: () => undefined } })).toThrow(/x-actor-id/);
  });

  it('AuthActorResolver reads ctx.auth.user and fail-closes when unauthenticated', () => {
    const resolver = new AuthActorResolver();
    expect(resolver.resolve({ auth: { user: { id: 42, roles: ['ADMIN'] } } })).toEqual({
      id: '42',
      roles: ['ADMIN'],
    });
    expect(() => resolver.resolve({ auth: { user: undefined } })).toThrow(/no authenticated user/);
  });
});
