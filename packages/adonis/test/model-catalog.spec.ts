import { afterEach, describe, expect, it } from 'vitest';
import type { ModelCatalogView, ModelProvider, ModelTurnArgs } from '../src/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

const catalog: ModelCatalogView = {
  default: 'mini',
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      models: [
        { id: 'mini', label: 'Mini', badges: ['fast'], available: true },
        { id: 'big', label: 'Big', available: false, unavailableReason: 'Upgrade to Pro' },
      ],
    },
  ],
};

/** Replies with the model each turn was asked to run on. */
function echoModel(seen: (string | undefined)[]): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs) {
      seen.push(args.model);
      const text = `on ${args.model ?? 'default'}`;
      await args.sink.write({ t: 'text', v: text });
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});
const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
const send = (url: string, body: unknown) =>
  fetch(`${url}/agent/chat`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('model catalog', () => {
  it('serves the catalog, runs a send on its picked model, and refuses what it does not offer', async () => {
    const seen: (string | undefined)[] = [];
    booted = await bootAgentApp({ model: echoModel(seen), models: catalog });
    const { url } = booted;

    expect(await (await fetch(`${url}/agent/models`, { headers })).json()).toEqual(catalog);

    await readSse(await send(url, { message: 'hi', model: 'mini' }));
    await readSse(await send(url, { message: 'hi' }));
    expect(seen).toEqual(['mini', undefined]);

    const unavailable = await send(url, { message: 'hi', model: 'big' });
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toEqual({
      error: 'model "big" is not available: Upgrade to Pro',
    });
    expect((await send(url, { message: 'hi', model: 'nope' })).status).toBe(400);
  });

  it('pins a model on a thread, runs later turns on it, and unpins it', async () => {
    const seen: (string | undefined)[] = [];
    booted = await bootAgentApp({ model: echoModel(seen), models: catalog });
    const { url } = booted;
    const first = await send(url, { message: 'hi' });
    const threadId = first.headers.get('x-agent-thread-id') as string;
    await readSse(first);

    const patch = (model: unknown) =>
      fetch(`${url}/agent/threads/${threadId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ model }),
      });
    expect((await patch('big')).status).toBe(400);
    expect(await (await patch('mini')).json()).toEqual({ ok: true });
    const listed = (await (await fetch(`${url}/agent/threads`, { headers })).json()) as {
      model: string | null;
    }[];
    expect(listed[0]?.model).toBe('mini');

    await readSse(await send(url, { message: 'again', threadId }));
    await patch(null);
    await readSse(await send(url, { message: 'and again', threadId }));
    expect(seen).toEqual([undefined, 'mini', undefined]);
  });

  it('answers an empty catalog and refuses any model when none is configured', async () => {
    booted = await bootAgentApp({ model: echoModel([]) });
    const { url } = booted;
    expect(await (await fetch(`${url}/agent/models`, { headers })).json()).toEqual({
      providers: [],
      default: null,
    });
    expect((await send(url, { message: 'hi', model: 'mini' })).status).toBe(400);
  });

  it('lists the agents, the default flagged', async () => {
    booted = await bootAgentApp({
      model: echoModel([]),
      agents: [{ name: 'researcher', description: 'Digs things up' }],
    });
    expect(await (await fetch(`${booted.url}/agent/agents`, { headers })).json()).toEqual([
      { name: 'default', description: '', isDefault: true },
      { name: 'researcher', description: 'Digs things up' },
    ]);
  });
});
