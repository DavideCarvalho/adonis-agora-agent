import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, MemoryConfig, MemoryProvider, MemoryRecord } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';

/**
 * The read-back and the delete, over real HTTP.
 *
 * WHY THIS EXISTS WHERE SKILLS HAVE NO SUCH SIBLING. A skill is authored by a person who already
 * knows it exists; a memory is written by the agent, about someone who does not. So a belief nobody
 * can inspect is one nobody can correct, and a belief nobody can delete is one the deployment keeps
 * whether or not it is true.
 */

const headerActorResolver = {
  resolve(req: unknown): Actor {
    const ctx = req as HttpContext;
    const id = ctx.request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    return { id, roles: ['USER'] };
  },
};

function memoryOf(
  key: string,
  scope: string,
  text: string,
  author: 'agent' | 'human' = 'agent',
): MemoryRecord {
  return {
    id: `${scope}/${key}`,
    key,
    text,
    scope,
    origin: { author, threadId: 't0', runId: 'r0', actorRef: 'u1' },
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

function providerOf(records: MemoryRecord[]): MemoryProvider & { forgotten: string[] } {
  const forgotten: string[] = [];
  return {
    forgotten,
    list: ({ scopes }) => records.filter((entry) => scopes.includes(entry.scope)),
    forget: ({ id }) => {
      forgotten.push(id);
      return records.some((entry) => entry.id === id);
    },
  };
}

interface BootedApp {
  url: string;
  close(): Promise<void>;
}

async function bootApp(memory?: MemoryConfig): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: headerActorResolver,
          ...(memory !== undefined ? { memory } : {}),
        },
      },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  const server = await app.container.make('server');
  await server.boot();
  const node: Server = createServer(server.handle.bind(server));
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  const { port } = node.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => node.close(() => resolve()));
    },
  };
}

let booted: BootedApp | null = null;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

const asActor = (id: string) => ({ headers: { 'x-actor-id': id } });

describe('what the assistant believes about you, and how you take it back', () => {
  it('hands the caller every belief held about them, whatever a turn’s ceiling would carry', async () => {
    const records = [
      memoryOf('units', 'actor:u1', 'nautical miles'),
      memoryOf('fiscal-year', 'global', 'the calendar year', 'human'),
    ];
    // A ceiling far below what is on file. A person who could not SEE a belief could not delete it,
    // and the assistant is one write away from acting on it again.
    booted = await bootApp({ provider: providerOf(records), maxMemories: 1 });

    const response = await fetch(`${booted.url}/agent/memories`, asActor('u1'));
    expect(response.status).toBe(200);
    const entries = (await response.json()) as MemoryRecord[];
    expect(entries.map((entry) => entry.key).sort()).toEqual(['fiscal-year', 'units']);
  });

  it('never shows one actor what is held about another', async () => {
    booted = await bootApp({ provider: providerOf([memoryOf('units', 'actor:u1', 'nautical')]) });

    const response = await fetch(`${booted.url}/agent/memories`, asActor('u2'));
    expect(await response.json()).toEqual([]);
  });

  it('forgets one held at the caller’s own scope', async () => {
    const provider = providerOf([memoryOf('units', 'actor:u1', 'nautical miles')]);
    booted = await bootApp({ provider });

    const response = await fetch(`${booted.url}/agent/memories/actor:u1%2Funits`, {
      method: 'DELETE',
      ...asActor('u1'),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forgotten: true });
    expect(provider.forgotten).toEqual(['actor:u1/units']);
  });

  it('refuses to delete a wider belief, and says where that is done instead', async () => {
    const provider = providerOf([memoryOf('fiscal-year', 'global', 'the calendar year', 'human')]);
    booted = await bootApp({ provider });

    const response = await fetch(`${booted.url}/agent/memories/global%2Ffiscal-year`, {
      method: 'DELETE',
      ...asActor('u1'),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(String(body.error)).toContain('administrative action');
    expect(provider.forgotten).toEqual([]);
  });

  it('answers an id the caller cannot see as missing, so it cannot be used as a probe', async () => {
    const provider = providerOf([memoryOf('units', 'actor:u2', 'statute miles')]);
    booted = await bootApp({ provider });

    const response = await fetch(`${booted.url}/agent/memories/actor:u2%2Funits`, {
      method: 'DELETE',
      ...asActor('u1'),
    });
    expect(response.status).toBe(404);
    expect(provider.forgotten).toEqual([]);
  });

  it('answers as though nothing is on file where no memory is configured', async () => {
    booted = await bootApp();

    const list = await fetch(`${booted.url}/agent/memories`, asActor('u1'));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const forget = await fetch(`${booted.url}/agent/memories/whatever`, {
      method: 'DELETE',
      ...asActor('u1'),
    });
    expect(forget.status).toBe(404);
  });

  it('reads nothing to an unidentified caller', async () => {
    booted = await bootApp({ provider: providerOf([memoryOf('units', 'actor:u1', 'nautical')]) });

    const response = await fetch(`${booted.url}/agent/memories`);
    expect(response.status).toBe(401);
  });
});
