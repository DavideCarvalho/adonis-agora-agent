// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { isValidThreadId } from '../src/thread-id.js';

/** A thread id crosses into the `X-Agent-Thread-Id` header: its shape is checked before it does. */

describe('isValidThreadId', () => {
  it('accepts generated and usual caller-chosen ids', () => {
    for (const id of [
      't1',
      'thread-1',
      '0b9c3f0e-8f2e-4c1a-9d7e-3a1b2c4d5e6f',
      'conv:42',
      'a.b_c@d',
    ]) {
      expect(isValidThreadId(id)).toBe(true);
    }
  });

  it('refuses what a header must not carry', () => {
    for (const id of [
      '',
      'a\r\nSet-Cookie: x=1',
      'a b',
      '"quoted"',
      '-leading',
      'x'.repeat(201),
      'é',
    ]) {
      expect(isValidThreadId(id)).toBe(false);
    }
    expect(isValidThreadId(42)).toBe(false);
    expect(isValidThreadId(undefined)).toBe(false);
  });
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('POST /agent/chat', () => {
  it('answers 400 for a threadId a header cannot carry', async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
        config: {
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => ({ id: 'u' }) },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    const server = await app.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    const node: Server = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
    close = async () => {
      await new Promise<void>((resolve) => node.close(() => resolve()));
      await app.terminate();
    };
    const { port } = node.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', threadId: 'evil\r\nX-Injected: 1' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_thread_id' });
  });
});
