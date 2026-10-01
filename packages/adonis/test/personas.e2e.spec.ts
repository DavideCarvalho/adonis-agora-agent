// Personas over the routes, as `@dudousxd/nestjs-agent` 1.20 has them (its `agent-personas.e2e.spec`):
// the catalog lists each agent's personas, a send runs under its own persona → the thread's pin → the
// agent's default → none, a persona a send names is pinned on the thread, an undeclared one is a
// `400 persona_not_found`, a queued message keeps the persona its send resolved, and a persona's
// `aliases` keep old agent names answering.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agUiAdapter } from '../src/ag-ui/index.js';
import {
  type AgentConfig,
  AgentService,
  defineTool,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type Persona,
} from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

interface Turn {
  system: string;
  tools: string[];
  message: string;
}

/** Records what each turn was handed; a message can be held mid-turn. */
class RecordingModel implements ModelProvider {
  readonly turns: Turn[] = [];
  private readonly holds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private readonly entered = new Map<string, () => void>();
  private readonly enteredPromises = new Map<string, Promise<void>>();

  hold(message: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.holds.set(message, { promise, resolve });
    this.enteredPromises.set(
      message,
      new Promise<void>((done) => {
        this.entered.set(message, done);
      }),
    );
  }

  reached(message: string): Promise<void> {
    return this.enteredPromises.get(message) ?? Promise.resolve();
  }

  release(message: string): void {
    this.holds.get(message)?.resolve();
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages].reverse().find((message) => message.role === 'user');
    const message = typeof last?.content === 'string' ? last.content : '';
    this.turns.push({ system: args.system, tools: args.tools.map((tool) => tool.name), message });
    this.entered.get(message)?.();
    await this.holds.get(message)?.promise;
    await args.sink.write({ t: 'text', v: 'ok' });
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const tool = (name: string) =>
  defineTool({ name, kind: 'read', description: name, input: z.object({}) }, () => ({ ok: name }));

const ASSISTANT_PERSONAS: Persona[] = [
  { id: 'general', label: 'General', description: 'Anything goes' },
  {
    id: 'sql',
    label: 'SQL focused',
    systemPrompt: (ctx) => `${ctx.basePrompt} Query first.`,
    // The agent `sql-agent` was folded into this persona.
    aliases: ['sql-agent'],
  },
  { id: 'read-only', label: 'Read only', allowedTools: ['executeSql'] },
];

let booted: BootedApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const headers = (actor = 'u1') => ({ 'content-type': 'application/json', 'x-actor-id': actor });

async function boot(extra: Partial<AgentConfig> = {}) {
  const model = new RecordingModel();
  const store = new InMemoryAgentStore();
  booted = await bootAgentApp({
    model,
    store: 'memory',
    stores: { memory: async () => store },
    tools: [tool('executeSql'), tool('renderResult')],
    defaultAgent: { systemPrompt: 'I am default.' },
    agents: [
      {
        name: 'assistant',
        description: 'The assistant',
        systemPrompt: 'I am assistant.',
        personas: ASSISTANT_PERSONAS,
        defaultPersona: 'general',
      },
      { name: 'plain', description: 'No personas', systemPrompt: 'I am plain.' },
    ],
    adapters: [agUiAdapter({ quietMs: 50 })],
    ...extra,
  } as never);
  const url = booted.url;
  const send = async (body: Record<string, unknown>, actor = 'u1') => {
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers(actor),
      body: JSON.stringify({ message: 'hi', ...body }),
    });
    if (response.status !== 200) {
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    const threadId = response.headers.get('x-agent-thread-id') as string;
    await readSse(response);
    return { status: 200, threadId };
  };
  const patch = (threadId: string, body: unknown) =>
    fetch(`${url}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(body),
    });
  const thread = async (threadId: string) =>
    (await (await fetch(`${url}/agent/threads/${threadId}`, { headers: headers() })).json()) as {
      persona: string | null;
      messages: { role: string; persona?: string }[];
    };
  const service = await booted.app.container.make(AgentService);
  return { url, model, store, send, patch, thread, service };
}

describe('GET agents — the persona catalog', { timeout: 30_000 }, () => {
  it('lists each agent’s personas — id, label, description — and its default', async () => {
    const { url } = await boot();
    const agents = (await (await fetch(`${url}/agent/agents`, { headers: headers() })).json()) as {
      name: string;
    }[];
    expect(agents.find((agent) => agent.name === 'assistant')).toEqual({
      name: 'assistant',
      description: 'The assistant',
      personas: [
        { id: 'general', label: 'General', description: 'Anything goes' },
        { id: 'sql', label: 'SQL focused' },
        { id: 'read-only', label: 'Read only' },
      ],
      defaultPersona: 'general',
    });
    // An agent that declares none says nothing about personas.
    expect(agents.find((agent) => agent.name === 'plain')).toEqual({
      name: 'plain',
      description: 'No personas',
    });
  });
});

describe('POST chat { persona }', { timeout: 30_000 }, () => {
  it('runs under the agent’s default persona when the send names none, without pinning it', async () => {
    const { send, model, thread } = await boot();
    const sent = await send({ agent: 'assistant' });
    expect(model.turns[0]?.system).toBe('I am assistant.');
    const detail = await thread(sent.threadId as string);
    expect(detail.persona).toBeNull();
    expect(detail.messages.map((message) => message.persona)).toEqual(['general', 'general']);
  });

  it('runs under the named persona, records it, and pins it on the thread', async () => {
    const { send, model, thread } = await boot();
    const first = await send({ agent: 'assistant', persona: 'sql' });
    const threadId = first.threadId as string;
    expect(model.turns[0]?.system).toBe('I am assistant. Query first.');
    expect((await thread(threadId)).persona).toBe('sql');
    // The next send names none: the thread's pin answers, not the agent's default.
    await send({ agent: 'assistant', threadId });
    expect(model.turns[1]?.system).toBe('I am assistant. Query first.');
    expect((await thread(threadId)).messages.map((message) => message.persona)).toEqual([
      'sql',
      'sql',
      'sql',
      'sql',
    ]);
  });

  it('switching persona mid-thread re-pins it', async () => {
    const { send, thread } = await boot();
    const threadId = (await send({ agent: 'assistant', persona: 'sql' })).threadId as string;
    await send({ agent: 'assistant', threadId, persona: 'read-only' });
    expect((await thread(threadId)).persona).toBe('read-only');
  });

  it('refuses a persona the agent does not declare, before creating anything', async () => {
    const { send, store } = await boot();
    const refused = await send({ agent: 'assistant', persona: 'ghost' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'persona_not_found' });
    expect(await store.listThreads('u1')).toEqual([]);
  });

  it('refuses a persona sent to an agent that has none', async () => {
    const { send } = await boot();
    const refused = await send({ agent: 'plain', persona: 'sql' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'persona_not_found' });
  });

  it('ignores a thread persona the agent of this send does not declare', async () => {
    const { send, model } = await boot();
    const threadId = (await send({ agent: 'assistant', persona: 'sql' })).threadId as string;
    const next = await send({ agent: 'plain', threadId });
    expect(next.status).toBe(200);
    expect(model.turns[1]?.system).toBe('I am plain.');
  });

  it('narrows the offered tools to the persona allow-list', async () => {
    const { send, model } = await boot();
    await send({ agent: 'assistant', persona: 'read-only' });
    expect(model.turns[0]?.tools).toEqual(['executeSql']);
  });

  it('takes the persona from AG-UI forwardedProps', async () => {
    const { url, model } = await boot();
    const response = await fetch(`${url}/agent/ag-ui`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        forwardedProps: { agent: 'assistant', persona: 'sql' },
      }),
    });
    await response.text();
    expect(model.turns[0]?.system).toBe('I am assistant. Query first.');
    const refused = await fetch(`${url}/agent/ag-ui`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        forwardedProps: { agent: 'assistant', persona: 'ghost' },
      }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'persona_not_found' });
  });
});

describe('PATCH threads/:id { persona }', { timeout: 30_000 }, () => {
  it('pins, validates and clears the thread persona', async () => {
    const { send, patch, thread, model } = await boot();
    const threadId = (await send({ agent: 'assistant' })).threadId as string;
    expect((await patch(threadId, { defaultAgent: 'assistant', persona: 'sql' })).status).toBe(200);
    expect((await thread(threadId)).persona).toBe('sql');
    await send({ threadId });
    expect(model.turns.at(-1)?.system).toBe('I am assistant. Query first.');

    const unknown = await patch(threadId, { persona: 'ghost' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: 'persona_not_found' });
    expect((await patch(threadId, { persona: 7 })).status).toBe(400);

    expect((await patch(threadId, { persona: null })).status).toBe(200);
    expect((await thread(threadId)).persona).toBeNull();
    await send({ threadId });
    expect(model.turns.at(-1)?.system).toBe('I am assistant.');
  });
});

describe('a persona that replaced an agent (aliases)', { timeout: 30_000 }, () => {
  it('runs a send naming the old agent as the agent + persona that took it over', async () => {
    const { send, model, thread } = await boot();
    const sent = await send({ agent: 'sql-agent' });
    expect(sent.status).toBe(200);
    expect(model.turns[0]?.system).toBe('I am assistant. Query first.');
    expect((await thread(sent.threadId as string)).messages[0]?.persona).toBe('sql');
  });

  it('keeps a thread whose default agent is the old name answering, with no migration', async () => {
    const { send, model, store } = await boot();
    const threadId = (await send({ agent: 'assistant' })).threadId as string;
    // What a thread created before the fold holds: the old agent's name.
    await store.updateThread(threadId, { defaultAgent: 'sql-agent' });
    await send({ threadId });
    expect(model.turns.at(-1)?.system).toBe('I am assistant. Query first.');
  });

  it('accepts the old name as a thread default agent', async () => {
    const { send, patch, model } = await boot();
    const threadId = (await send({ agent: 'assistant' })).threadId as string;
    expect((await patch(threadId, { defaultAgent: 'sql-agent' })).status).toBe(200);
    await send({ threadId });
    expect(model.turns.at(-1)?.system).toBe('I am assistant. Query first.');
  });
});

describe('a queued message carries its persona', { timeout: 30_000 }, () => {
  it('persists the persona the send resolved, and starts under it', async () => {
    const { url, send, model, store } = await boot();
    const threadId = (await send({ agent: 'assistant', message: 'first' })).threadId as string;
    model.hold('busy');
    const running = fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agent: 'assistant', threadId, message: 'busy' }),
    });
    await model.reached('busy');
    const queued = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agent: 'assistant', threadId, message: 'later', persona: 'sql' }),
    });
    expect(queued.status).toBe(202);
    expect((await store.listQueue(threadId))[0]).toMatchObject({
      content: 'later',
      persona: 'sql',
    });
    model.release('busy');
    await (await running).text();
    const deadline = Date.now() + 3000;
    while (!model.turns.some((turn) => turn.message === 'later')) {
      if (Date.now() > deadline) throw new Error('the queued message never started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(model.turns.find((turn) => turn.message === 'later')?.system).toBe(
      'I am assistant. Query first.',
    );
  });

  it('starts a message queued with no persona (as before personas) under the resolved one', async () => {
    const { url, send, model, store, service } = await boot();
    const threadId = (await send({ agent: 'assistant', persona: 'sql', message: 'first' }))
      .threadId as string;
    model.hold('busy');
    const running = fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agent: 'assistant', threadId, message: 'busy' }),
    });
    await model.reached('busy');
    // Straight into the store, the way a release before personas queued it: no persona.
    await store.enqueueMessage({
      threadId,
      actor: { id: 'u1', roles: ['ADMIN'] },
      content: 'legacy',
      agentName: 'sql-agent',
    });
    expect(service).toBeDefined();
    model.release('busy');
    await (await running).text();
    const deadline = Date.now() + 3000;
    while (!model.turns.some((turn) => turn.message === 'legacy')) {
      if (Date.now() > deadline) throw new Error('the queued message never started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(model.turns.find((turn) => turn.message === 'legacy')?.system).toBe(
      'I am assistant. Query first.',
    );
  });
});
