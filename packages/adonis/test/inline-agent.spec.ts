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

function buildGraph(script: FakeScript, quota?: QuotaStore): Graph {
  const db = dbHandle;
  const store = new LucidAgentStore(asStoreDb(db));
  const sink = new InProcessTokenStreamSink();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
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
