import { afterEach, describe, expect, it } from 'vitest';
import type { ModelCatalogView, ModelProvider, ModelTurnArgs } from '../src/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

/**
 * `PATCH <path>/threads/:id { defaultAgent }` — the agent a thread's turns run as when a send names
 * none. Precedence, as in `@dudousxd/nestjs-agent`: the send's own `agent` > the thread's
 * `defaultAgent` > the configured default.
 */

/** Replies with the system prompt it was handed — which names the agent that ran the turn. */
function promptEcho(seen: string[]): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs) {
      const agent = /I am (\w+)/.exec(args.system)?.[1] ?? 'unknown';
      seen.push(agent);
      await args.sink.write({ t: 'text', v: agent });
      return { text: agent, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const catalog: ModelCatalogView = {
  default: 'mini',
  providers: [{ id: 'p', label: 'P', models: [{ id: 'mini', label: 'Mini', available: true }] }],
};

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});
const headers = (actor = 'u1') => ({ 'content-type': 'application/json', 'x-actor-id': actor });

async function boot(seen: string[], extra: Record<string, unknown> = {}) {
  booted = await bootAgentApp({
    model: promptEcho(seen),
    defaultAgent: { systemPrompt: 'I am default' },
    agents: [
      { name: 'support', description: 'Helps', systemPrompt: 'I am support' },
      { name: 'sales', description: 'Sells', systemPrompt: 'I am sales' },
    ],
    ...extra,
  } as never);
  const url = booted.url;
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: 'hi', ...body }),
    });
    const threadId = response.headers.get('x-agent-thread-id') as string;
    await readSse(response);
    return threadId;
  };
  const patch = (threadId: string, body: unknown, actor = 'u1') =>
    fetch(`${url}/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: headers(actor),
      body: JSON.stringify(body),
    });
  return { url, send, patch };
}

describe("a thread's default agent", { timeout: 30_000 }, () => {
  it('runs later turns as the thread’s agent, under a send’s own agent, and clears back to the default', async () => {
    const seen: string[] = [];
    const { url, send, patch } = await boot(seen);
    const threadId = await send({});
    expect(seen).toEqual(['default']);

    expect(await (await patch(threadId, { defaultAgent: 'support' })).json()).toEqual({ ok: true });
    await send({ threadId });
    await send({ threadId, agent: 'sales' });
    expect(seen).toEqual(['default', 'support', 'sales']);

    const listed = (await (await fetch(`${url}/agent/threads`, { headers: headers() })).json()) as {
      id: string;
      defaultAgent: string | null;
    }[];
    expect(listed.find((thread) => thread.id === threadId)?.defaultAgent).toBe('support');

    expect((await patch(threadId, { defaultAgent: null })).status).toBe(200);
    await send({ threadId });
    expect(seen.at(-1)).toBe('default');
  });

  it('refuses an agent the app does not register, a non-string, and another actor’s thread', async () => {
    const { send, patch } = await boot([]);
    const threadId = await send({});
    const unknown = await patch(threadId, { defaultAgent: 'ghost' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { message: string }).message).toContain('ghost');
    expect((await patch(threadId, { defaultAgent: 7 })).status).toBe(400);
    expect((await patch(threadId, { defaultAgent: 'support' }, 'intruder')).status).toBe(403);
  });

  it('sets the agent and pins a model in one patch, the model checked for that agent', async () => {
    const seen: string[] = [];
    const { send, patch } = await boot(seen, { models: catalog });
    const threadId = await send({});
    expect(
      (await patch(threadId, { defaultAgent: 'support', model: 'mini', title: 'Help' })).status,
    ).toBe(200);
    await send({ threadId });
    expect(seen.at(-1)).toBe('support');
  });
});
