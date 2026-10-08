import { InMemoryStateStore, runTick, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChannelWorkflowEngine,
  channels,
  InMemoryChannelStore,
} from '../src/channels/index.js';
import {
  DurableAgentRunner,
  registerAgentWorkflow,
  setDurableAgentContext,
} from '../src/durable/index.js';
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
import { fakeAdapter, inbound, makeCtx, texts } from './helpers/channels.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const actor = { id: 'u1', roles: ['ADMIN'] };

/**
 * The agent and its channel as `durable:work` runs them: an engine whose `start` only persists the
 * run (`pending`), and ONE worker that runs a tick at a time — a tick awaits every run it picked up
 * before the next one starts.
 */
function deployment(
  script: FakeScript,
  agentDefs: Parameters<AgentRegistry['register']>[0][] = [],
) {
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
  const engine = new WorkflowEngine({
    store: new InMemoryStateStore(),
    runDispatcher: { dispatch: () => {} },
  });
  setDurableAgentContext({ factory, store });
  registerAgentWorkflow(engine);
  const service = new AgentService(new DurableAgentRunner(engine, store), store, factory);
  let stopped = false;
  const worker = (async () => {
    while (!stopped) {
      await runTick(engine);
      await sleep(5);
    }
  })();
  return {
    engine,
    service,
    stop: async () => {
      stopped = true;
      await worker;
    },
  };
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('durable channels under a single serial worker', () => {
  it('answers a message whose turn is left pending for the worker the job is holding', async () => {
    const app = deployment(() => ({ text: 'Hello from the agent' }));
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: app.service,
      store: new InMemoryChannelStore(),
      durable: app.engine as unknown as ChannelWorkflowEngine,
      actor: () => actor,
      thread: () => null,
      timeoutMs: 3000,
    });
    try {
      const startedAt = Date.now();
      await handle(makeCtx(inbound('hi', { id: 'm-1' })).ctx);
      await app.engine.waitForRun('agora.channel:test:message:m-1', {
        terminal: true,
        timeoutMs: 5000,
      });
      expect(texts(outbox)).toEqual(['Hello from the agent']);
      // Answered by the job itself, not by the read giving up on the turn.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      const turns = await app.engine.listRuns({ workflow: 'agora.agent.run' });
      expect(turns.map((run) => run.status)).toEqual(['completed']);
    } finally {
      await app.stop();
    }
  });

  it('answers a turn that delegates to a sub-agent (a child run left pending as well)', async () => {
    const app = deployment(
      (args, turnIndex) => {
        const delegates = args.tools.some((tool) => tool.name === 'ask_helper');
        if (!delegates) return { text: 'helper answer' };
        if (turnIndex === 0)
          return { text: '', toolCall: { name: 'ask_helper', input: { task: 'help me' } } };
        return { text: 'All done.' };
      },
      [
        { name: 'orchestrator', delegatesTo: ['helper'] },
        { name: 'helper', systemPrompt: 'You are a helper.', tools: [] },
      ],
    );
    const { adapter, outbox } = fakeAdapter();
    const handle = channels.handle(adapter, {
      service: app.service,
      store: new InMemoryChannelStore(),
      durable: app.engine as unknown as ChannelWorkflowEngine,
      actor: () => actor,
      thread: () => null,
      agentName: 'orchestrator',
      timeoutMs: 4000,
    });
    try {
      const startedAt = Date.now();
      await handle(makeCtx(inbound('coordinate', { id: 'm-1' })).ctx);
      await app.engine.waitForRun('agora.channel:test:message:m-1', {
        terminal: true,
        timeoutMs: 6000,
      });
      expect(texts(outbox).join('')).toContain('All done.');
      expect(Date.now() - startedAt).toBeLessThan(3000);
      const turns = await app.engine.listRuns({ workflow: 'agora.agent.run' });
      expect(turns.map((run) => run.status)).toEqual(['completed', 'completed']);
    } finally {
      await app.stop();
    }
  });
});
