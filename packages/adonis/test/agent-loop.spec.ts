import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type Decision,
  DefaultRolesPolicy,
  type ModelProvider,
  type Persona,
  type PromptBuilder,
  runAgentLoop,
  type StreamFrame,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryQuotaStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string() }),
    },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  reg.register(
    {
      name: 'show_card',
      kind: 'read',
      description: 'renders a card component',
      inputSchema: z.object({}),
    },
    {
      execute: async (_input, ctx) => {
        await ctx.emitComponent?.('Card', { hello: 'world' });
        return { shown: true };
      },
    },
  );
  reg.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string() }),
    },
    { execute: async (input: { key: string }) => ({ purged: input.key }) },
  );
  reg.register(
    {
      name: 'askSub',
      kind: 'agent',
      targetAgent: 'sub-agent',
      description: 'delegate to the sub-agent',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({ text: 'unused — agent-kind tools are loop-handled' }) },
  );
  return reg;
}

async function drain(sink: InMemoryTokenStreamSink, runId: string): Promise<string> {
  let out = '';
  for await (const frame of sink.subscribe(runId)) {
    if (frame.t === 'text') out += frame.v;
  }
  return out;
}

async function drainFrames(sink: InMemoryTokenStreamSink, runId: string): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  for await (const f of sink.subscribe(runId)) frames.push(f);
  return frames;
}

interface RunOverrides {
  systemPrompt?: string | PromptBuilder;
  persona?: Persona;
  model?: ModelProvider;
}

async function run(
  script: FakeScript,
  decide: (id: string) => Decision = () => ({ approved: true }),
  quota?: InMemoryQuotaStore,
  runAgent?: (agentName: string, task: string) => Promise<{ text: string }>,
  overrides: RunOverrides = {},
) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({
    actor: { id: 'u1', roles: ['ADMIN'] },
    persona: 'default',
  });
  const runId = 'run-1';

  const deps: AgentLoopDeps = {
    model: overrides.model ?? new FakeModelProvider(script),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: overrides.systemPrompt ?? 'You are a test agent.',
    ...(quota !== undefined ? { quota } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async (call) => decide(call.id),
    step: (_name, fn) => fn(),
    ...(runAgent !== undefined ? { runAgent } : {}),
  };

  const result = await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: { id: 'u1', roles: ['ADMIN'] },
      userText: 'hi',
      ...(overrides.persona !== undefined ? { persona: overrides.persona } : {}),
    },
    hooks,
  );
  const streamed = await drain(sink, runId);
  const detail = await store.getThread(thread.id);
  return { result, streamed, store, detail };
}

describe('runAgentLoop', () => {
  it('streams a no-tool turn and persists user + assistant messages', async () => {
    const { result, streamed, detail } = await run(() => ({ text: 'hello world' }));
    expect(result.text).toBe('hello world');
    expect(streamed).toBe('hello world');
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('auto-executes a read tool then loops to a final answer', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C in Recife' };

    const { result, store } = await run(script);
    expect(result.text).toBe('it is 21C in Recife');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: 'getWeather', status: 'executed' });
    expect(rows[0]?.output).toEqual({ tempC: 21, city: 'Recife' });
  });

  it('halts an action tool for approval, then executes on approve', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'done' };

    const { store } = await run(script, () => ({ approved: true }));
    const rows = store.toolCallRows();
    expect(rows[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
    expect(rows[0]?.output).toEqual({ purged: 'cfg' });
  });

  it('does not execute an action tool on reject', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'ok, skipped' };

    const { store } = await run(script, () => ({ approved: false, reason: 'nope' }));
    const rows = store.toolCallRows();
    expect(rows[0]).toMatchObject({ toolName: 'purgeCache', status: 'rejected' });
    expect(rows[0]?.output).toBeUndefined();
  });

  it('blocks when over quota', async () => {
    const quota = new InMemoryQuotaStore(0);
    await expect(
      run(
        () => ({ text: 'x' }),
        () => ({ approved: true }),
        quota,
      ),
    ).rejects.toThrow(/quota/i);
  });

  it('records the provider-reported modelId over the configured fallback', async () => {
    const reportingModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write({ t: 'text', v: 'done' });
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          modelId: 'claude-real-42',
        };
      },
    };
    const { store } = await run(() => ({ text: 'unused' }), undefined, undefined, undefined, {
      model: reportingModel,
    });
    expect(store.usageRows()[0]?.modelId).toBe('claude-real-42');
  });

  it('persists a provider-reported costUsd onto the usage row', async () => {
    const gatewayModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write({ t: 'text', v: 'done' });
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0.0042,
        };
      },
    };
    const { store } = await run(() => ({ text: 'unused' }), undefined, undefined, undefined, {
      model: gatewayModel,
    });
    expect(store.governanceUsage()[0]?.costUsd).toBeCloseTo(0.0042, 6);
  });

  it('leaves costUsd unset when the provider reports only tokens', async () => {
    const { store } = await run(() => ({ text: 'ok' }));
    expect(store.governanceUsage()[0]?.costUsd).toBeUndefined();
  });

  it('resolves an agent-level PromptBuilder from the turn context', async () => {
    const builder: PromptBuilder = (ctx) => `dynamic prompt for ${ctx.actor.id}`;
    const { result } = await run(
      (args) => ({ text: args.system }),
      undefined,
      undefined,
      undefined,
      {
        systemPrompt: builder,
      },
    );
    expect(result.text).toBe('dynamic prompt for u1');
  });

  it('lets a persona PromptBuilder wrap the agent base prompt', async () => {
    const persona: Persona = {
      id: 'analyst',
      label: 'Analyst',
      systemPrompt: (ctx) => `${ctx.basePrompt}\n\nActing as analyst for ${ctx.actor.id}.`,
    };
    const { result } = await run(
      (args) => ({ text: args.system }),
      undefined,
      undefined,
      undefined,
      {
        systemPrompt: 'Base agent prompt.',
        persona,
      },
    );
    expect(result.text).toBe('Base agent prompt.\n\nActing as analyst for u1.');
  });

  it('delegates to a sub-agent via ctx.runAgent and emits agent.delegated', async () => {
    const delegations: Array<{ toAgent?: string }> = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => {
      if (lib === 'agent' && event === 'delegated') {
        delegations.push(payload as { toAgent?: string });
      }
    };

    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'asking the sub-agent',
            toolCall: { name: 'askSub', input: { task: 'how many bases?' } },
          }
        : { text: 'the sub-agent said hi' };

    try {
      const { result, store } = await run(
        script,
        () => ({ approved: true }),
        undefined,
        async () => ({
          text: 'sub-agent answer: 42',
        }),
      );
      expect(result.text).toBe('the sub-agent said hi');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'askSub', status: 'executed' });
      expect(store.toolCallRows()[0]?.output).toEqual({ text: 'sub-agent answer: 42' });
      expect(delegations).toHaveLength(1);
      expect(delegations[0]).toMatchObject({ toAgent: 'sub-agent' });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    }
  });

  it('emits a component frame from a tool, in order with text', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'olha ', toolCall: { name: 'show_card', input: {} } }
        : { text: 'pronto' };

    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const runId = 'run-emit';
    const thread = await store.createThread({
      actor: { id: 'u1', roles: ['ADMIN'] },
      persona: 'default',
    });
    const deps: AgentLoopDeps = {
      model: new FakeModelProvider(script),
      store,
      registry: buildRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-06-30',
      systemPrompt: 'You are a test agent.',
    };
    const hooks: AgentLoopHooks = {
      runId,
      openSink: () => sink.open(runId),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };
    await runAgentLoop(
      deps,
      { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'oi' },
      hooks,
    );

    const frames = await drainFrames(sink, runId);
    const kinds = frames.map((f) => (f.t === 'component' ? `component:${f.name}` : `text:${f.v}`));
    expect(kinds).toContain('component:Card');
    expect(kinds.indexOf('text:olha ')).toBeLessThan(kinds.indexOf('component:Card'));
    const comp = frames.find((f) => f.t === 'component');
    expect(comp).toMatchObject({ t: 'component', name: 'Card', data: { hello: 'world' } });
  });
});
