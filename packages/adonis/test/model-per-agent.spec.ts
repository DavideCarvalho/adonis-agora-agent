import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentDefinition,
  AgentDepsFactory,
  type AgentLoopDeps,
  type AgentLoopHooks,
  AgentRegistry,
  type AgentRunInput,
  type AgentRunner,
  AgentService,
  DefaultRolesPolicy,
  type ModelCatalog,
  type ModelCatalogView,
  type ModelProvider,
  type ModelTurnArgs,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

const entry = (id: string, available = true, unavailableReason?: string) => ({
  id,
  label: id,
  available,
  ...(unavailableReason !== undefined ? { unavailableReason } : {}),
});

const catalog: ModelCatalogView = {
  default: 'anthropic/sonnet',
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      models: [
        entry('anthropic/sonnet'),
        entry('anthropic/haiku'),
        entry('anthropic/opus'),
        entry('anthropic/locked-out', false, 'Upgrade to Pro'),
      ],
    },
  ],
};

interface Seen {
  agent: string;
  model: string | undefined;
}

/**
 * Each agent's prompt is `agent:<name>`; the provider records which agent asked for which model,
 * delegates once when it is offered `ask_researcher`, and reports no model id of its own (so usage
 * is labelled with the turn's model).
 */
function recordingModel(seen: Seen[]): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs) {
      const agent = /agent:(\w+)/.exec(args.system)?.[1] ?? '?';
      seen.push({ agent, model: args.model });
      const usage = { inputTokens: 1, outputTokens: 1 };
      const delegated = args.messages.some((message) => (message.toolResults?.length ?? 0) > 0);
      if (args.tools.some((tool) => tool.name === 'ask_researcher') && !delegated) {
        return {
          text: '',
          toolCalls: [{ id: `c-${seen.length}`, name: 'ask_researcher', input: { task: 'dig' } }],
          usage,
        };
      }
      await args.sink.write({ t: 'text', v: 'ok' });
      return { text: 'ok', toolCalls: [], usage };
    },
  };
}

const agents: AgentDefinition[] = [
  {
    name: 'support',
    systemPrompt: 'agent:support',
    tools: [],
    model: 'anthropic/haiku',
    personas: [
      { id: 'default', label: 'Default' },
      { id: 'expert', label: 'Expert', model: 'anthropic/opus' },
    ],
  },
  { name: 'plain', systemPrompt: 'agent:plain', tools: [] },
  {
    name: 'orchestrator',
    systemPrompt: 'agent:orchestrator',
    delegatesTo: [{ agent: 'researcher', roles: ['ADMIN'] }],
  },
  { name: 'researcher', systemPrompt: 'agent:researcher', tools: [], model: 'anthropic/haiku' },
];

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});
const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
const send = (url: string, body: unknown) =>
  fetch(`${url}/agent/chat`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('model per agent and per persona', () => {
  it('resolves send > thread pin > persona > agent > catalog default', async () => {
    const seen: Seen[] = [];
    booted = await bootAgentApp({ model: recordingModel(seen), models: catalog, agents });
    const { url } = booted;

    // Agent model (the default persona declares none).
    const first = await send(url, { message: 'hi', agent: 'support' });
    const threadId = first.headers.get('x-agent-thread-id') as string;
    await readSse(first);
    // Persona model over the agent's.
    await readSse(await send(url, { message: 'hi', agent: 'support', persona: 'expert' }));
    // The send's own model over the persona's.
    await readSse(
      await send(url, {
        message: 'hi',
        agent: 'support',
        persona: 'expert',
        model: 'anthropic/sonnet',
      }),
    );
    // The thread pin over the persona's and the agent's.
    await fetch(`${url}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ model: 'anthropic/sonnet' }),
    });
    await readSse(await send(url, { message: 'hi', agent: 'support', threadId }));
    // No model anywhere → the provider's (catalog's) default.
    await readSse(await send(url, { message: 'hi', agent: 'plain' }));

    expect(seen.map((turn) => turn.model)).toEqual([
      'anthropic/haiku',
      'anthropic/opus',
      'anthropic/sonnet',
      'anthropic/sonnet',
      undefined,
    ]);
  });

  it('labels usage with the resolved model when the provider reports none', async () => {
    const store = new InMemoryAgentStore();
    booted = await bootAgentApp({
      model: recordingModel([]),
      models: catalog,
      agents,
      stores: { memory: async () => store },
      store: 'memory',
    });
    await readSse(await send(booted.url, { message: 'hi', agent: 'support', persona: 'expert' }));
    expect(store.usageRows().map((row) => row.modelId)).toEqual(['anthropic/opus']);
  });

  it('lets a catalog lock win over the agent and persona model', async () => {
    const seen: Seen[] = [];
    const locked: ModelCatalog = {
      list: () => ({ ...catalog, locked: { model: 'anthropic/sonnet', reason: 'Always Sonnet' } }),
    };
    booted = await bootAgentApp({ model: recordingModel(seen), models: locked, agents });
    await readSse(await send(booted.url, { message: 'hi', agent: 'support', persona: 'expert' }));
    expect(seen.map((turn) => turn.model)).toEqual(['anthropic/sonnet']);
    const models = (await (
      await fetch(`${booted.url}/agent/models?agent=support&persona=expert`, { headers })
    ).json()) as ModelCatalogView;
    expect(models.default).toBe('anthropic/sonnet');
  });

  it('refuses a send when the agent or persona model is not offered to this caller', async () => {
    const seen: Seen[] = [];
    // Per caller: the catalog no longer offers Opus (the persona's model) to anyone without Pro.
    const perCaller: ModelCatalog = {
      list: () => ({
        ...catalog,
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            models: [
              entry('anthropic/sonnet'),
              entry('anthropic/haiku'),
              entry('anthropic/opus', false, 'Upgrade to Pro'),
            ],
          },
        ],
      }),
    };
    booted = await bootAgentApp({ model: recordingModel(seen), models: perCaller, agents });
    const refused = await send(booted.url, { message: 'hi', agent: 'support', persona: 'expert' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      code: 'model_not_allowed',
      message:
        'persona "expert" of agent "support" runs on model "anthropic/opus", which is not available: Upgrade to Pro',
    });
    expect(seen).toEqual([]);
    // A send naming an offered model still goes through: the caller's pick wins over the persona's.
    await readSse(
      await send(booted.url, {
        message: 'hi',
        agent: 'support',
        persona: 'expert',
        model: 'anthropic/haiku',
      }),
    );
    expect(seen.map((turn) => turn.model)).toEqual(['anthropic/haiku']);
  });

  it('fails boot on an agent or persona model the catalog does not list', async () => {
    await expect(
      bootAgentApp({
        model: recordingModel([]),
        models: catalog,
        agents: [
          {
            name: 'support',
            model: 'openai/gpt-x',
            personas: [{ id: 'fast', label: 'Fast', model: 'anthropic/nope' }],
          },
        ],
      }),
    ).rejects.toThrow(
      'agent "support" sets model "openai/gpt-x"; persona "fast" of agent "support" sets model "anthropic/nope" — not in the model catalog',
    );
  });

  it('answers the agent’s and the persona’s model as the /models default', async () => {
    booted = await bootAgentApp({ model: recordingModel([]), models: catalog, agents });
    const read = async (query: string) =>
      (
        (await (
          await fetch(`${booted?.url}/agent/models${query}`, { headers })
        ).json()) as ModelCatalogView
      ).default;
    expect(await read('')).toBe('anthropic/sonnet');
    expect(await read('?agent=plain')).toBe('anthropic/sonnet');
    expect(await read('?agent=support')).toBe('anthropic/haiku');
    expect(await read('?agent=support&persona=expert')).toBe('anthropic/opus');
    // A persona the agent does not declare reads as its default persona.
    expect(await read('?agent=support&persona=ghost')).toBe('anthropic/haiku');
  });

  it('runs a delegate on its own model, not the caller’s pick', async () => {
    const seen: Seen[] = [];
    booted = await bootAgentApp({ model: recordingModel(seen), models: catalog, agents });
    await readSse(
      await send(booted.url, {
        message: 'hi',
        agent: 'orchestrator',
        model: 'anthropic/opus',
      }),
    );
    expect(seen).toEqual([
      { agent: 'orchestrator', model: 'anthropic/opus' },
      { agent: 'researcher', model: 'anthropic/haiku' },
      { agent: 'orchestrator', model: 'anthropic/opus' },
    ]);
  });
});

describe('model per agent — recorded on the run', () => {
  it('carries the agent’s model on the run input, so a replay or a queued start keeps it', async () => {
    const store = new InMemoryAgentStore();
    const registry = new AgentRegistry();
    for (const definition of agents) registry.register(definition);
    const factory = new AgentDepsFactory({
      model: recordingModel([]),
      store,
      sink: new InMemoryTokenStreamSink(),
      rolesPolicy: new DefaultRolesPolicy(['ADMIN']),
      registry: new ToolRegistry(),
      agents: registry,
    });
    const started: AgentRunInput[] = [];
    const runner: AgentRunner = {
      async start(input) {
        started.push(input);
        return { runId: 'r1' };
      },
    } as AgentRunner;
    const service = new AgentService(runner, store, factory, {
      models: { list: () => catalog },
    });
    await service.chat({ actor: { id: 'u1' }, message: 'hi', agentName: 'support' });
    await service.chat({
      actor: { id: 'u1' },
      message: 'hi',
      agentName: 'support',
      personaId: 'expert',
    });
    expect(started.map((input) => input.model)).toEqual(['anthropic/haiku', 'anthropic/opus']);
  });

  it('journals the delegate’s model with the delegation, so a replay starts it on the same one', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'ask_researcher',
        kind: 'agent',
        targetAgent: 'researcher',
        description: 'Delegate to researcher',
        inputSchema: z.object({ task: z.string() }),
        roles: ['ADMIN'],
      },
      { execute: async () => ({}) },
    );
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor, persona: 'default' });
    const journal = new Map<string, unknown>();
    const delegated: (string | undefined)[] = [];
    const run = async (delegateModel: string) => {
      const deps: AgentLoopDeps = {
        model: new FakeModelProvider((_args, turn) =>
          turn === 0
            ? { text: '', toolCall: { name: 'ask_researcher', input: { task: 'dig' } } }
            : { text: 'done' },
        ),
        store,
        registry,
        rolesPolicy: new DefaultRolesPolicy(['ADMIN']),
        day: '2026-11-12',
        systemPrompt: 'agent:orchestrator',
        resolveDelegateModel: async () => delegateModel,
      };
      const sink = new InMemoryTokenStreamSink();
      const hooks: AgentLoopHooks = {
        runId: 'run-1',
        openSink: () => sink.open('run-1'),
        awaitApproval: async () => ({ approved: true }),
        // A durable journal: a replay answers each checkpoint from the first attempt.
        step: async (name, fn) => {
          if (journal.has(name)) return journal.get(name) as never;
          const value = await fn();
          journal.set(name, value);
          return value;
        },
        runAgent: async (_agent, _task, options) => {
          delegated.push(options?.model);
          return { text: 'found it' };
        },
      };
      await runAgentLoop(deps, { threadId: thread.id, actor, userText: 'go' }, hooks);
    };
    await run('anthropic/haiku');
    // Replayed after the target's configured model changed: the journaled choice stands.
    await run('anthropic/opus');
    expect(delegated).toEqual(['anthropic/haiku', 'anthropic/haiku']);
  });

  it('refuses a delegation whose target model the catalog does not offer', async () => {
    const seen: Seen[] = [];
    const noHaiku: ModelCatalog = {
      list: () => ({
        ...catalog,
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            models: [entry('anthropic/sonnet'), entry('anthropic/haiku', false, 'Outage')],
          },
        ],
      }),
    };
    const store = new InMemoryAgentStore();
    booted = await bootAgentApp({
      model: recordingModel(seen),
      models: noHaiku,
      agents,
      stores: { memory: async () => store },
      store: 'memory',
    });
    await readSse(await send(booted.url, { message: 'hi', agent: 'orchestrator' }));
    // The researcher never ran; the orchestrator was told why, and answered.
    expect(seen.map((turn) => turn.agent)).toEqual(['orchestrator', 'orchestrator']);
  });
});
