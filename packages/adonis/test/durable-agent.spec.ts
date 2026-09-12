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
  DELEGATED_RUN_DECLINE_REASON,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Did `work` settle inside `ms`? Bounded so a test that fails does so with an assertion. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  const deadline = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), ms).unref?.();
  });
  return Promise.race([work.then(() => true), deadline]);
}

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

/** Every tool-result error the store holds, across the main thread and each delegate's subthread. */
async function refusalsAcrossThreads(store: InMemoryAgentStore): Promise<string[]> {
  const threadIds = [...new Set(store.governanceMessages().map((message) => message.threadId))];
  const errors: string[] = [];
  for (const threadId of threadIds) {
    const detail = await store.getThread(threadId);
    for (const message of detail?.messages ?? []) {
      for (const result of message.toolResults ?? []) {
        if (result.error !== undefined) errors.push(result.error);
      }
    }
  }
  return errors;
}

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

  it('discards an answers-shaped signal delivered to a parked approval, rather than recording a rejection', async () => {
    // A durable signal carries no clue about which wait it lands on, so the refusal has to happen in
    // the loop. An `ElicitationReply` has no `approved`, and `!undefined` is true — this is the wait
    // that used to read it as a human rejection.
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
    await waitFor(() =>
      g.store
        .toolCallRows()
        .some((r) => r.toolName === 'danger' && r.status === 'pending_approval'),
    );
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'suspended');

    await g.service.answer({ runId, toolCallId, answers: { scope: ['narrow'] } });
    await g.service.skip({ runId, toolCallId });
    // Long enough that a run which was going to settle on either of those would have done so.
    await sleep(50);

    expect(g.store.toolCallRows().find((r) => r.toolName === 'danger')?.status).toBe(
      'pending_approval',
    );
    expect(ran).toBe(false);
    expect((await g.engine.getRun(runId))?.status).toBe('suspended');

    // The approval it was always waiting on still settles it, from the position the journal holds.
    await g.service.approve(runId, toolCallId);
    await waitFor(() =>
      g.store.toolCallRows().some((r) => r.toolName === 'danger' && r.status === 'executed'),
    );
    expect(ran).toBe(true);
  });

  it("overlaps a turn's read tools on the real engine", async () => {
    // Each tool blocks until the OTHER has started. Under sequential execution the first one waits
    // out its deadline and reports `overlapped: false` — a readable failure rather than a hang.
    const alphaStarted = deferred();
    const betaStarted = deferred();
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'looking',
            toolCalls: [
              { name: 'alpha', input: {} },
              { name: 'beta', input: {} },
            ],
          }
        : { text: 'done' };
    const g = buildGraph(script);
    const waitForSibling = async (
      mine: { resolve: () => void },
      theirs: { promise: Promise<void> },
    ) => {
      mine.resolve();
      return { overlapped: await settledWithin(theirs.promise, 500) };
    };
    g.registry.register(
      { name: 'alpha', kind: 'read', description: 'a', inputSchema: z.object({}) },
      { execute: () => waitForSibling(alphaStarted, betaStarted) },
    );
    g.registry.register(
      { name: 'beta', kind: 'read', description: 'b', inputSchema: z.object({}) },
      { execute: () => waitForSibling(betaStarted, alphaStarted) },
    );

    const { runId } = await g.service.chat({ actor, message: 'look it up' });
    await collectStream(g, runId);

    const outputs = g.store
      .toolCallRows()
      .filter((row) => row.toolName === 'alpha' || row.toolName === 'beta')
      .map((row) => row.output);
    expect(outputs).toEqual([{ overlapped: true }, { overlapped: true }]);
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

  it('settles a delegated child\u2019s own HITL wait instead of suspending it where nobody can answer', async () => {
    // The helper reaches for an action tool. A person is watching the ORCHESTRATOR's stream; the
    // child's frames arrive there under the orchestrator's turn, and the id they carry is the
    // child's tool call, not a run the watcher knows how to address. Suspending here parked the
    // whole delegation on a signal nothing would ever send. It is declined instead — the same
    // answer the inline runner's nested loop has always given.
    let ran = false;
    const script: FakeScript = (args, turnIndex) => {
      const hasDelegate = args.tools.some((t) => t.name === 'ask_helper');
      if (hasDelegate) {
        return turnIndex === 0
          ? { text: 'delegating', toolCall: { name: 'ask_helper', input: { task: 'help me' } } }
          : { text: 'all done' };
      }
      return turnIndex === 0
        ? { text: 'let me act', toolCall: { name: 'danger', input: { k: 'v' } } }
        : { text: 'helper answer' };
    };
    const g = buildGraph(script, [
      { name: 'orchestrator', delegatesTo: ['helper'] },
      { name: 'helper', systemPrompt: 'You are a helper.', tools: ['danger'] },
    ]);
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

    const { runId } = await g.service.chat({
      actor,
      message: 'coordinate',
      agentName: 'orchestrator',
    });
    // Bounded, so a child that parks on a signal nobody sends fails with an assertion rather than
    // hanging the suite on a stream that never ends.
    await waitFor(() =>
      g.store.toolCallRows().some((r) => r.toolName === 'ask_helper' && r.status === 'executed'),
    );
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    // The delegation came back with the helper's answer rather than hanging on a human.
    const delegateCall = g.store.toolCallRows().find((r) => r.toolName === 'ask_helper');
    expect(delegateCall?.status).toBe('executed');
    expect(delegateCall?.output).toEqual({ text: 'helper answer' });
    // And the action the sub-agent reached for is recorded as declined, and never ran.
    const declined = g.store.governanceToolCalls().find((r) => r.toolName === 'danger');
    expect(declined?.status).toBe('rejected');
    expect(declined?.error).toBe(DELEGATED_RUN_DECLINE_REASON);
    expect(ran).toBe(false);
  });

  it('cuts a mutual handoff where the chain repeats, not at the depth ceiling', async () => {
    // Two agents that hand off to each other, each with no other tool to reach for — so nothing but
    // the loop ends the chain. The guard is in the loop, but it can only SEE a cycle if this runner
    // hands the chain down through `ctx.child`; without that threading every hop reads an empty
    // ancestry, finds no repeat, and the run walks to the depth ceiling instead.
    const script: FakeScript = (args, turnIndex) => {
      const target = args.system.includes('You are alpha.') ? 'ask_beta' : 'ask_alpha';
      return turnIndex === 0
        ? { text: 'passing it on', toolCall: { name: target, input: { task: 'keep going' } } }
        : { text: 'all done' };
    };
    const g = buildGraph(script, [
      { name: 'alpha', systemPrompt: 'You are alpha.', delegatesTo: ['beta'] },
      { name: 'beta', systemPrompt: 'You are beta.', delegatesTo: ['alpha'] },
    ]);

    const { runId } = await g.service.chat({ actor, message: 'go', agentName: 'alpha' });
    await collectStream(g, runId);
    await waitFor(async () => (await g.engine.getRun(runId))?.status === 'completed');

    const delegations = g.store.toolCallRows().filter((row) => row.toolName.startsWith('ask_'));
    // alpha → beta, then beta's hop back is refused. One each way, and the third is the repeat.
    expect(delegations).toHaveLength(2);
    expect(delegations.at(-1)?.status).toBe('failed');
    // And the refusal names the chain, including the hop that closed it.
    expect(await refusalsAcrossThreads(g.store)).toEqual([
      'delegation cycle: alpha → beta → alpha — alpha 2 times on one chain',
    ]);
  });
});
