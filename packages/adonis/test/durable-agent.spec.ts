import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
import type { Actor } from '../src/index.js';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  registerDelegateTools,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

interface Graph {
  service: AgentService;
  store: InMemoryAgentStore;
  sink: InMemoryTokenStreamSink;
  registry: ToolRegistry;
  agents: AgentRegistry;
  engine: WorkflowEngine;
}

function buildGraph(
  script: FakeScript,
  agentDefs: Parameters<AgentRegistry['register']>[0][] = [],
): Graph {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
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
  });
  // A self-contained engine over an in-memory store — the default in-process dispatcher runs the
  // workflow body on a microtask, so `start` returns immediately and the loop streams to the sink.
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const runner = new DurableAgentRunner(engine);
  const service = new AgentService(runner, store, factory);
  return { service, store, sink, registry, agents, engine };
}

async function collectStream(g: Graph, runId: string): Promise<string> {
  let text = '';
  for await (const frame of g.service.subscribe(runId)) {
    if (frame.t === 'text') text += frame.v;
  }
  return text;
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('DurableAgentRunner + AgentService (durable workflow)', () => {
  it('streams tokens and persists the user + assistant messages', async () => {
    const g = buildGraph(() => ({ text: 'Hello from the durable agent' }));
    const { runId, threadId } = await g.service.chat({ actor, message: 'hi' });
    // `start` hands back the run id even though the body runs asynchronously on the engine.
    expect(typeof runId).toBe('string');

    const streamed = await collectStream(g, runId);
    expect(streamed).toContain('Hello from the durable agent');

    const detail = await g.store.getThread(threadId);
    expect(detail?.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello from the durable agent' },
    ]);
  });

  it('records the run as completed on the durable engine', async () => {
    const g = buildGraph(() => ({ text: 'done' }));
    const { runId } = await g.service.chat({ actor, message: 'hi' });
    await collectStream(g, runId);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');
    expect((await g.engine.getRun(runId))?.status).toBe('completed');
  });

  it('suspends on an action tool and executes it after approve (HITL via waitForSignal)', async () => {
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

    // The run suspends on the pending action: the durable run is `suspended`, the tool call pending.
    await waitFor(() =>
      g.store
        .toolCallRows()
        .some((r) => r.status === 'pending_approval' && r.toolName === 'danger'),
    );
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    // Approve → the run resumes from the checkpoint, the tool runs, the run completes.
    await g.service.approve(runId, toolCallId);
    await waitFor(() =>
      g.store.toolCallRows().some((r) => r.toolName === 'danger' && r.status === 'executed'),
    );
    const row = g.store.toolCallRows().find((r) => r.toolName === 'danger');
    expect(row?.status).toBe('executed');
    expect(row?.output).toEqual({ acted: true });
  });

  it('rejects an action tool on reject — the tool never runs', async () => {
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
    await waitFor(() => g.store.toolCallRows().some((r) => r.status === 'pending_approval'));
    await g.service.reject(runId, toolCallId, 'nope');
    await waitFor(() =>
      g.store.toolCallRows().some((r) => r.toolName === 'danger' && r.status === 'rejected'),
    );
    expect(ran).toBe(false);
  });

  it('delegates to a sub-agent as a child workflow (ctx.child)', async () => {
    // Orchestrator (turn 0) calls the synthesized `ask_helper` delegate tool; the helper agent, run
    // as a child workflow, answers; the orchestrator (turn 1) finishes.
    const script: FakeScript = (args, turnIndex) => {
      const hasDelegate = args.tools.some((t) => t.name === 'ask_helper');
      if (hasDelegate && turnIndex === 0) {
        return { text: 'delegating', toolCall: { name: 'ask_helper', input: { task: 'help me' } } };
      }
      if (!hasDelegate) {
        return { text: 'helper answer' };
      }
      return { text: 'all done' };
    };
    const g = buildGraph(script, [
      { name: 'orchestrator', delegatesTo: ['helper'] },
      // `tools: []` so the helper is offered NO tools — without it the (unrestricted) helper would
      // also see the `ask_helper` delegate and recurse into itself forever.
      { name: 'helper', systemPrompt: 'You are a helper.', tools: [] },
    ]);

    const { runId, threadId } = await g.service.chat({
      actor,
      message: 'coordinate',
      agentName: 'orchestrator',
    });
    await collectStream(g, runId);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    const detail = await g.store.getThread(threadId);
    const assistant = detail?.messages.filter((m) => m.role === 'assistant') ?? [];
    // The orchestrator's final turn ran after the delegate tool result came back from the child.
    expect(assistant.at(-1)?.content).toBe('all done');
    // A delegate tool call was recorded and executed (its output is the child's answer).
    const delegateCall = g.store.toolCallRows().find((r) => r.toolName === 'ask_helper');
    expect(delegateCall?.status).toBe('executed');
    expect(delegateCall?.output).toEqual({ text: 'helper answer' });
  });
});
