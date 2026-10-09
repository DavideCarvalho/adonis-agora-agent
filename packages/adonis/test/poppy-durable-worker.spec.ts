import { InMemoryStateStore, runTick, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { personalAgentGate } from '../src/a2a/gate.js';
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
  InMemoryPoppyStore,
  PoppyConversations,
  type PoppyEvent,
  type PoppyPrincipal,
} from '../src/poppy/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const principal: PoppyPrincipal = {
  userId: 'u1',
  clientId: 'https://pa.example',
  scopes: [],
  sessionId: 's1',
  signedIn: false,
};

/**
 * The agent as `durable:work` runs it: an engine whose `start` only persists the run (`pending`),
 * and — optionally — ONE worker that runs a tick at a time.
 */
function deployment(
  script: FakeScript,
  opts: { worker: boolean },
  agentDefs: Parameters<AgentRegistry['register']>[0][] = [],
) {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  const agents = new AgentRegistry();
  for (const def of agentDefs) agents.register(def);
  registerDelegateTools(registry, agents);
  const factory = new AgentDepsFactory({
    model: new FakeModelProvider(script),
    store,
    sink: new InMemoryTokenStreamSink(),
    rolesPolicy: personalAgentGate(new DefaultToolAuthorizer()),
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
  const worker = opts.worker
    ? (async () => {
        while (!stopped) {
          await runTick(engine);
          await sleep(5);
        }
      })()
    : Promise.resolve();
  return {
    engine,
    service,
    registry,
    stop: async () => {
      stopped = true;
      await worker;
    },
  };
}

async function replyOf(conversations: PoppyConversations, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let cursor: string | undefined;
  const events: PoppyEvent[] = [];
  while (Date.now() < deadline) {
    const read = await conversations.read(principal, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      waitMs: 200,
    });
    events.push(...read.events);
    cursor = read.cursor ?? cursor;
    const reply = events.find(
      (e) => e.type === 'message' && (e.message as { role: string }).role === 'company',
    );
    if (reply) return (reply.message as { text: string }).text;
  }
  return null;
}

afterEach(() => {
  setDurableAgentContext(undefined);
});

describe('Poppy over a durable runner', () => {
  for (const worker of [true, false]) {
    it(`answers a turn left pending (${worker ? 'single serial worker' : 'no worker: driven here'})`, async () => {
      const app = deployment(() => ({ text: 'Hello from the agent' }), { worker });
      const conversations = new PoppyConversations({
        store: new InMemoryPoppyStore(),
        service: app.service,
        toolRoles: (name) => app.registry.spec(name)?.roles,
        timeoutMs: 4000,
        pollMs: 50,
      });
      try {
        const startedAt = Date.now();
        const { conversationId } = await conversations.start(principal, {
          message: { id: 'msg_1', sender: 'agent', text: 'hi' },
        });
        expect(await replyOf(conversations, conversationId, 3000)).toBe('Hello from the agent');
        expect(Date.now() - startedAt).toBeLessThan(2000);
        const turns = await app.engine.listRuns({ workflow: 'agora.agent.run' });
        expect(turns.map((run) => run.status)).toEqual(['completed']);
      } finally {
        conversations.shutdown();
        await app.stop();
      }
    });
  }

  it('with drive off and no worker, the turn stays pending (what drive is for)', async () => {
    const app = deployment(() => ({ text: 'never' }), { worker: false });
    const conversations = new PoppyConversations({
      store: new InMemoryPoppyStore(),
      service: app.service,
      toolRoles: () => undefined,
      timeoutMs: 600,
      pollMs: 50,
      drive: false,
    });
    try {
      const { conversationId } = await conversations.start(principal, {
        message: { id: 'msg_1', sender: 'agent', text: 'hi' },
      });
      await sleep(300);
      const turns = await app.engine.listRuns({ workflow: 'agora.agent.run' });
      expect(turns.map((run) => run.status)).toEqual(['pending']);
      expect((await conversations.read(principal, conversationId, {})).status).toBe('working');
    } finally {
      conversations.shutdown();
      await app.stop();
    }
  });

  it('answers a turn that delegates to a sub-agent under a single serial worker', async () => {
    const app = deployment(
      (args, turnIndex) => {
        const delegates = args.tools.some((tool) => tool.name === 'ask_helper');
        if (!delegates) return { text: 'helper answer' };
        if (turnIndex === 0) {
          return { text: '', toolCall: { name: 'ask_helper', input: { task: 'help me' } } };
        }
        return { text: 'All done.' };
      },
      { worker: true },
      [
        // The edge is opened to personal agents (a bare edge is ADMIN-only).
        { name: 'orchestrator', delegatesTo: [{ agent: 'helper', roles: ['personal_agent'] }] },
        { name: 'helper', systemPrompt: 'You are a helper.', tools: [] },
      ],
    );
    const conversations = new PoppyConversations({
      store: new InMemoryPoppyStore(),
      service: app.service,
      toolRoles: () => undefined,
      agentName: 'orchestrator',
      timeoutMs: 4000,
      pollMs: 50,
    });
    try {
      const { conversationId } = await conversations.start(principal, {
        message: { id: 'msg_1', sender: 'agent', text: 'coordinate' },
      });
      expect(await replyOf(conversations, conversationId, 4000)).toContain('All done.');
    } finally {
      conversations.shutdown();
      await app.stop();
    }
  });
});
