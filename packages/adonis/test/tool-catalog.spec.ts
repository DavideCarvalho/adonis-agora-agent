import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolCatalogEntry } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

let booted: BootedApp | null = null;
afterEach(async () => {
  await booted?.close();
  booted = null;
});

const purge = defineTool(
  {
    name: 'purgeCache',
    kind: 'action',
    description: 'Purge a cache key',
    input: z.object({ key: z.string() }),
    roles: ['ADMIN'],
    presentation: {
      label: 'Cache purge',
      running: 'Purging {key}',
      done: 'Purged {key}',
      icon: 'cache',
      tone: 'destructive',
      confirm: { title: 'Purge {key}?', verb: 'Purge' },
    },
  },
  () => ({ purged: true }),
);
const lookup = defineTool(
  {
    name: 'lookup',
    kind: 'read',
    description: 'Look something up',
    input: z.object({ q: z.string() }),
    roles: ['ADMIN', 'USER'],
  },
  () => ({}),
);

const as = (id: string, roles: string) => ({
  headers: { 'x-actor-id': id, 'x-actor-roles': roles },
});

describe('GET /agent/tools', () => {
  it('lists what the caller can reach, with the declared presentation', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: '' })),
      tools: [purge, lookup],
    });
    const response = await fetch(`${booted.url}/agent/tools`, as('u1', 'ADMIN'));
    expect(response.status).toBe(200);
    const entries = (await response.json()) as ToolCatalogEntry[];
    expect(entries).toEqual([
      {
        name: 'purgeCache',
        kind: 'action',
        presentation: {
          label: 'Cache purge',
          running: 'Purging {key}',
          done: 'Purged {key}',
          icon: 'cache',
          tone: 'destructive',
          confirm: { title: 'Purge {key}?', verb: 'Purge' },
        },
      },
      { name: 'lookup', kind: 'read' },
    ]);
  });

  it('never lists a tool the model would not be offered for this actor', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: '' })),
      tools: [purge, lookup],
    });
    const entries = (await (
      await fetch(`${booted.url}/agent/tools`, as('u2', 'USER'))
    ).json()) as ToolCatalogEntry[];
    expect(entries.map((entry) => entry.name)).toEqual(['lookup']);
  });

  it('answers 404 for an agent that does not exist rather than the widest list', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: '' })),
      tools: [purge],
    });
    const response = await fetch(`${booted.url}/agent/tools?agent=nope`, as('u1', 'ADMIN'));
    expect(response.status).toBe(404);
  });

  it('401s an anonymous caller', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(() => ({ text: '' })),
      tools: [purge],
    });
    expect((await fetch(`${booted.url}/agent/tools`)).status).toBe(401);
  });
});
