import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiTool,
  AnonymousActorResolver,
  readAiToolMeta,
  type ThreadSummary,
  toolNameFromClass,
} from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

describe('AnonymousActorResolver', () => {
  function ctxWith(cookie?: string) {
    const set: string[] = [];
    return {
      set,
      ctx: {
        request: {
          header: (name: string) => (name === 'cookie' ? cookie : undefined),
          secure: () => false,
        },
        response: { append: (_key: string, value: string) => set.push(value) },
      },
    };
  }

  it('mints an HttpOnly token once per request and derives anon:<sha256> from it', () => {
    const resolver = new AnonymousActorResolver();
    const { ctx, set } = ctxWith();
    const first = resolver.resolve(ctx);
    const again = resolver.resolve(ctx);
    expect(first).toEqual(again);
    expect(first.id).toMatch(/^anon:[A-Za-z0-9_-]{32}$/);
    expect(first.roles).toEqual(['anonymous']);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(
      /^agent_anon=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/,
    );

    const token = set[0]?.split(';')[0]?.split('=')[1];
    const returning = ctxWith(`other=1; agent_anon=${token}`);
    expect(resolver.resolve(returning.ctx)).toEqual(first);
    expect(returning.set).toHaveLength(0);
  });

  it('re-mints a malformed token and marks the cookie Secure over HTTPS', () => {
    const set: string[] = [];
    const ctx = {
      request: { header: () => 'agent_anon=forged', secure: () => true },
      response: { append: (_key: string, value: string) => set.push(value) },
    };
    new AnonymousActorResolver().resolve(ctx);
    expect(set[0]).toMatch(/; Secure$/);
  });
});

describe('@AiTool defaults', () => {
  it('names a class after itself and makes it a read', () => {
    expect(toolNameFromClass('GetWeatherTool')).toBe('getWeather');
    expect(toolNameFromClass('SQLQueryTool')).toBe('sqlQuery');
    @AiTool({ description: 'Weather', input: z.object({}) })
    class GetWeatherTool {
      async execute() {
        return {};
      }
    }
    expect(readAiToolMeta(GetWeatherTool)).toMatchObject({ name: 'getWeather', kind: 'read' });
  });
});

describe('zero config over HTTP', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });

  it('serves each browser as its own anonymous actor', async () => {
    booted = await bootAgentApp(
      { model: new FakeModelProvider(() => ({ text: 'Hi.' })) },
      { anonymous: true },
    );
    const { url } = booted;
    const first = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const cookie = first.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^agent_anon=/);
    await readSse(first);

    const mine = (await (
      await fetch(`${url}/agent/threads`, { headers: { cookie: cookie as string } })
    ).json()) as ThreadSummary[];
    expect(mine).toHaveLength(1);
    const stranger = await fetch(`${url}/agent/threads`);
    expect(await stranger.json()).toEqual([]);
    expect(stranger.headers.get('set-cookie')).toMatch(/^agent_anon=/);
  });
});
