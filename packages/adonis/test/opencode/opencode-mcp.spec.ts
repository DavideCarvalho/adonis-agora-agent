import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentService,
  type MemoryProvider,
  type StoreMemoryInput,
  ToolRegistry,
} from '../../src/index.js';
import { type OpenCodeEngine, openCode } from '../../src/opencode/index.js';
import { InMemoryAgentStore } from '../../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from '../helpers/boot-agent-app.js';
import { FakeOpenCode, type FakeTurn } from '../helpers/fake-opencode.js';
import {
  actor,
  approve,
  eventually,
  frames,
  framesUntil,
  TestHost,
} from '../helpers/opencode-harness.js';

const meta = (sessionId: string) => ({ 'ai.opencode/sessionID': sessionId });

interface Booted {
  app: BootedApp;
  engine: OpenCodeEngine;
  fake: FakeOpenCode;
  store: InMemoryAgentStore;
  service: AgentService;
  gate: { turn?: FakeTurn; release?: () => void };
  written: StoreMemoryInput[];
}

/** The app with the agent provider on an OpenCode engine, tools served, and no `model` at all. */
async function boot(): Promise<Booted> {
  const fake = new FakeOpenCode();
  const gate: Booted['gate'] = {};
  fake.script = async (t) => {
    gate.turn = t;
    t.emit('session.text.delta', { delta: 'Working.' });
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    t.succeed();
  };
  const endpoint = { url: '' };
  const engine = openCode({
    host: new TestHost(fake),
    tools: {
      get url() {
        return endpoint.url;
      },
    },
  });
  const store = new InMemoryAgentStore();
  const written: StoreMemoryInput[] = [];
  const memory: MemoryProvider = {
    list: () => [],
    forget: () => false,
    write: (input) => {
      written.push(input);
      return { id: `m${written.length}`, ...input, updatedAt: new Date().toISOString() };
    },
  };
  const app = await bootAgentApp({
    engine,
    stores: { memory: async () => store },
    store: 'memory',
    memory: { provider: memory },
  });
  endpoint.url = `${app.url}/agent/opencode/mcp`;
  const registry = await app.app.container.make(ToolRegistry);
  registry.register(
    {
      name: 'whoami',
      kind: 'read',
      description: 'Which conversation is this?',
      inputSchema: z.object({}),
    },
    {
      execute: async (_input, ctx) => {
        await ctx.emitUi('Card', { thread: ctx.threadId }, { id: 'card-1' });
        return `${ctx.threadId} ${ctx.runId}`;
      },
    },
  );
  registry.register(
    { name: 'send', kind: 'action', description: 'send it', inputSchema: z.object({}) },
    { execute: async () => 'sent' },
  );
  const service = await app.app.container.make(AgentService);
  return { app, engine, fake, store, service, gate, written };
}

async function mcpClient(url: string, authorization: string): Promise<Client> {
  const client = new Client({ name: 'opencode-as-a-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorization } },
    }) as Transport,
  );
  return client;
}

const textOfResult = (result: unknown) =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text).join('');

describe('the OpenCode engine behind the agent provider', () => {
  let b: Booted | undefined;
  afterEach(async () => {
    b?.gate.release?.();
    await b?.app.close();
    b = undefined;
  });

  it('runs a send through the chat route with no model configured', async () => {
    b = await boot();
    b.fake.script = async (t) => {
      t.emit('session.text.delta', { delta: `echo: ${t.text}` });
      t.succeed();
    };
    const response = await fetch(`${b.app.url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(response.status).toBe(200);
    const sse = await readSse(response);
    const text = sse
      .filter((f) => f.data.kind === 'text')
      .map((f) => f.data.text)
      .join('');
    expect(text).toBe('echo: hello');
    expect(sse.at(-1)?.event).toBe('done');
  });

  it('serves the tools to the turn a session is running, and to nothing else', async () => {
    b = await boot();
    const { runId, threadId } = await b.service.chat({ actor, message: 'go' });
    await framesUntil(b.service, runId, (f) => f.kind === 'text');
    const config = b.fake.callsOf('mcp.add')[0]?.args.config as
      | { headers?: Record<string, string> }
      | undefined;
    const authorization = config?.headers?.Authorization ?? '';
    const url = `${b.app.url}/agent/opencode/mcp`;

    // A token that is not the engine's is refused before anything runs.
    const refused = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer forged.token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(refused.status).toBe(401);

    const client = await mcpClient(url, authorization);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['remember', 'send', 'whoami']);

    // No session in `_meta`: the call belongs to no turn.
    const alone = await client.callTool({ name: 'whoami', arguments: {} });
    expect(alone.isError).toBe(true);
    expect(textOfResult(alone)).toMatch(/no turn of yours/);
    // A session that is not running a turn of this actor's.
    const stranger = await client.callTool({
      name: 'whoami',
      arguments: {},
      _meta: meta('ses_nope'),
    });
    expect(stranger.isError).toBe(true);

    // The session's turn: the tool runs in it, and its component lands on the turn's stream.
    const called = await client.callTool({ name: 'whoami', arguments: {}, _meta: meta('ses_1') });
    expect(textOfResult(called)).toBe(`${threadId} ${runId}`);

    // An action runs only against an approval the turn granted.
    const early = await client.callTool({ name: 'send', arguments: {}, _meta: meta('ses_1') });
    expect(early.isError).toBe(true);
    expect(textOfResult(early)).toMatch(/nobody approved/);
    b.gate.turn?.emit('permission.asked', { id: 'per_send', action: 'agora_send' });
    await framesUntil(b.service, runId, (f) => f.kind === 'approval-requested');
    await approve(b.service, 'per_send');
    await eventually(
      () => b?.fake.callsOf('permission.reply').length === 1,
      'the approval reached OpenCode',
    );
    const sent = await client.callTool({ name: 'send', arguments: {}, _meta: meta('ses_1') });
    expect(textOfResult(sent)).toBe('sent');
    const again = await client.callTool({ name: 'send', arguments: {}, _meta: meta('ses_1') });
    expect(again.isError).toBe(true);

    // `remember` writes one fact at the actor's own scope, with the turn's provenance.
    const remembered = await client.callTool({
      name: 'remember',
      arguments: { key: 'color', fact: 'Likes blue' },
      _meta: meta('ses_1'),
    });
    expect(textOfResult(remembered)).toBe('Recorded "color".');
    expect(b.written).toEqual([
      expect.objectContaining({
        key: 'color',
        scope: 'actor:u1',
        origin: expect.objectContaining({ author: 'agent', threadId, runId }),
      }),
    ]);
    await client.close();

    b.gate.release?.();
    const fs = await frames(b.service, runId);
    expect(fs).toContainEqual({
      kind: 'ui',
      id: 'card-1',
      component: 'Card',
      props: { thread: threadId },
    });
    const messages = (await b.store.getThread(threadId))?.messages ?? [];
    expect(messages.flatMap((m) => m.ui ?? []).map((c) => c.id)).toContain('card-1');
  });
});
