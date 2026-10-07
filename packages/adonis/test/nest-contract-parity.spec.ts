import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_AGENTS,
  type ElicitationRequest,
  exhaustedWindow,
  LedgerQuotaProvider,
  type ModelCatalogView,
  type ModelProvider,
  type ModelTurnArgs,
  quotaWarning,
  settleElicitation,
} from '../src/index.js';
import { InMemoryAgentStore } from '../src/testing/index.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

/**
 * The chat contract `@dudousxd/nestjs-agent` settled (docs/stream-protocol.md): refusal bodies,
 * a send's model is that turn's only, model lock, regenerate, quota soft limit, who answered a
 * question, and the tool catalog across every agent.
 */

const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
const send = (url: string, body: unknown, extra: Record<string, string> = headers) =>
  fetch(`${url}/agent/chat`, { method: 'POST', headers: extra, body: JSON.stringify(body) });

/** Replies with the model each turn was asked to run on, and records what the turn was shown. */
function echoModel(seen: (string | undefined)[], shown: string[][] = []): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs) {
      seen.push(args.model);
      shown.push(args.messages.map((message) => `${message.role}:${message.content}`));
      const text = `on ${args.model ?? 'default'}`;
      await args.sink.write({ t: 'text', v: text });
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const catalog: ModelCatalogView = {
  default: 'mini',
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      models: [
        { id: 'mini', label: 'Mini', available: true },
        { id: 'big', label: 'Big', available: true },
      ],
    },
  ],
};

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

describe('refusals answer { message, code? }', () => {
  it('names the reason in words and in a code', async () => {
    booted = await bootAgentApp({ model: echoModel([]) });
    const unauthenticated = await send(
      booted.url,
      { message: 'hi' },
      {
        'content-type': 'application/json',
      },
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: 'unauthorized' });

    const noCatalog = await send(booted.url, { message: 'hi', model: 'big' });
    expect(noCatalog.status).toBe(400);
    const body = (await noCatalog.json()) as Record<string, unknown>;
    expect(body.code).toBe('model_not_allowed');
    expect(typeof body.message).toBe('string');
    expect(body).not.toHaveProperty('error');
  });
  it('refuses malformed uiCapabilities with a 400, not a 500', async () => {
    booted = await bootAgentApp({ model: echoModel([]) });
    for (const uiCapabilities of [{ components: 'nope' }, { components: [{ name: '1x' }] }]) {
      const refused = await send(booted.url, { message: 'hi', uiCapabilities });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'invalid_ui_capabilities' });
    }
  });
});

describe("a send's model is that turn's only", () => {
  it('never pins it on the thread', async () => {
    const seen: (string | undefined)[] = [];
    booted = await bootAgentApp({ model: echoModel(seen), models: catalog });
    const first = await send(booted.url, { message: 'hi', model: 'big' });
    const threadId = first.headers.get('x-agent-thread-id');
    await readSse(first);
    await readSse(await send(booted.url, { message: 'again', threadId }));
    expect(seen).toEqual(['big', undefined]);
    const thread = (await (
      await fetch(`${booted.url}/agent/threads/${threadId}`, { headers })
    ).json()) as { model?: string | null };
    expect(thread.model ?? null).toBeNull();
  });
});

describe('model lock', () => {
  it('runs every turn on the locked model and refuses another', async () => {
    const seen: (string | undefined)[] = [];
    const locked: ModelCatalogView = {
      ...catalog,
      locked: { model: 'mini', reason: 'Always Mini' },
    };
    booted = await bootAgentApp({ model: echoModel(seen), models: locked });

    const refused = await send(booted.url, { message: 'hi', model: 'big' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      message: 'model "big" cannot be selected: Always Mini',
      code: 'model_not_allowed',
    });

    await readSse(await send(booted.url, { message: 'hi' }));
    await readSse(await send(booted.url, { message: 'hi', model: 'mini' }));
    expect(seen).toEqual(['mini', 'mini']);

    const models = (await (await fetch(`${booted.url}/agent/models`, { headers })).json()) as {
      locked?: unknown;
    };
    expect(models.locked).toEqual({ model: 'mini', reason: 'Always Mini' });
    const agents = (await (await fetch(`${booted.url}/agent/agents`, { headers })).json()) as {
      name: string;
      lockedModel?: string;
    }[];
    expect(agents.every((agent) => agent.lockedModel === 'mini')).toBe(true);
  });
});

describe('regenerate', () => {
  it('re-answers the last user message without storing it again', async () => {
    const seen: (string | undefined)[] = [];
    const shown: string[][] = [];
    booted = await bootAgentApp({ model: echoModel(seen, shown), models: catalog });
    const first = await send(booted.url, { message: 'what is 2+2?' });
    const threadId = first.headers.get('x-agent-thread-id');
    await readSse(first);

    const again = await send(booted.url, {
      threadId,
      regenerate: true,
      message: 'ignored',
      model: 'big',
    });
    expect(again.status).toBe(200);
    expect(again.headers.get('x-agent-run-id')).not.toBe(first.headers.get('x-agent-run-id'));
    await readSse(again);

    // The replaced answer is gone before the model is asked again, and nothing new was typed.
    expect(shown[1]?.filter((line) => line.startsWith('assistant:'))).toEqual([]);
    expect(shown[1]?.some((line) => line.includes('ignored'))).toBe(false);
    const thread = (await (
      await fetch(`${booted.url}/agent/threads/${threadId}`, { headers })
    ).json()) as { messages: { role: string; content: string }[] };
    expect(thread.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'what is 2+2?'],
      ['assistant', 'on big'],
    ]);
  });

  it('requires a thread', async () => {
    booted = await bootAgentApp({ model: echoModel([]) });
    const refused = await send(booted.url, { regenerate: true, message: '' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'thread_required' });
  });
});

describe('quota soft limit and USD-only windows', () => {
  it('warns past warnAt, never while blocked', () => {
    const at = (usedTokens: number) => [
      { period: 'day' as const, usedTokens, limitTokens: 100, usedUsd: 0, warnAt: 0.8 },
    ];
    expect(quotaWarning(at(50))).toBeUndefined();
    expect(quotaWarning(at(85))).toEqual({ period: 'day', ratio: 0.85 });
    expect(quotaWarning(at(100))).toBeUndefined();
    expect(exhaustedWindow(at(100))).toMatchObject({ period: 'day' });
  });

  it('reads a window without usedTokens as a spend-only budget', () => {
    const spendOnly = [{ period: 'month' as const, usedUsd: 9, limitUsd: 10, warnAt: 0.5 }];
    expect(exhaustedWindow(spendOnly)).toBeUndefined();
    expect(quotaWarning(spendOnly)).toEqual({ period: 'month', ratio: 0.9 });
    expect(exhaustedWindow([{ period: 'day', limitTokens: 0, usedUsd: 0 }])).toMatchObject({
      period: 'day',
    });
  });

  it('stamps warnAt on the ledger windows that have a ceiling', async () => {
    const store = new InMemoryAgentStore();
    const provider = new LedgerQuotaProvider(
      store,
      undefined,
      { day: { tokens: 10 } },
      { warnAt: 0.5 },
    );
    const report = await provider.report({ actor: { id: 'u1' } });
    expect(report.windows.find((window) => window.period === 'day')?.warnAt).toBe(0.5);
    expect(report.warning).toBeUndefined();
  });

  it('serves warnAt through GET quota', async () => {
    booted = await bootAgentApp({
      model: echoModel([]),
      quota: { limits: { day: { tokens: 1_000 } }, warnAt: 0.8 },
    });
    const report = (await (await fetch(`${booted.url}/agent/quota`, { headers })).json()) as {
      windows: { period: string; warnAt?: number }[];
    };
    expect(report.windows.find((window) => window.period === 'day')?.warnAt).toBe(0.8);
  });
});

describe('who answered a question', () => {
  const request: ElicitationRequest = {
    id: 'req-1',
    source: 'ask',
    questions: [
      {
        id: 'scope',
        prompt: 'How wide?',
        options: [{ value: 'a', label: 'A' }],
        defaults: ['a'],
      },
    ],
  };

  it('carries answeredBy / answeredVia onto the settled outcome', () => {
    expect(
      settleElicitation({
        request,
        reply: { answers: { scope: ['a'] }, answeredByRef: 'u9', answeredVia: 'slack' },
      }),
    ).toMatchObject({ answeredBy: 'u9', answeredVia: 'slack', skipped: false });
    // A yes/no channel's decision says who and through what just the same.
    expect(
      settleElicitation({
        request,
        reply: { approved: false, executedByRef: 'u2', decidedVia: 'console' },
      }),
    ).toMatchObject({ answeredBy: 'u2', answeredVia: 'console', skipped: true });
  });

  it('refuses a via that is not 1-64 characters', async () => {
    booted = await bootAgentApp({ model: echoModel([]) });
    for (const route of ['answer', 'skip']) {
      const refused = await fetch(`${booted.url}/agent/tool-call/${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ toolCallId: 'call-1', via: 'x'.repeat(65) }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ message: expect.stringContaining('via') });
    }
  });
});

describe('GET tools?agent=*', () => {
  it('answers the union across every agent, each tool once', async () => {
    const { defineTool } = await import('../src/index.js');
    const { z } = await import('zod');
    const tool = (name: string) =>
      defineTool({ name, kind: 'read', description: name, input: z.object({}) }, async () => ({}));
    booted = await bootAgentApp({
      model: echoModel([]),
      tools: [tool('alpha'), tool('beta'), tool('gamma')],
      defaultAgent: { tools: ['alpha'] },
      agents: [
        { name: 'one', description: 'one', systemPrompt: 'one', tools: ['alpha', 'beta'] },
        { name: 'two', description: 'two', systemPrompt: 'two', tools: ['gamma'] },
      ],
    });
    const all = (await (
      await fetch(`${booted.url}/agent/tools?agent=${encodeURIComponent(ALL_AGENTS)}`, { headers })
    ).json()) as { name: string }[];
    expect(all.map((entry) => entry.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect((await fetch(`${booted.url}/agent/tools?agent=nope`, { headers })).status).toBe(404);
  });
});
