import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Catalog,
  defineCatalog,
  defineComponent,
  GenuiCatalogResolver,
  type GenuiCatalogScope,
  genui,
} from '../src/genui/index.js';
import { DefaultToolAuthorizer, type ToolCatalogEntry, ToolRegistry } from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

const OrderCard = defineComponent({
  name: 'OrderCard',
  title: 'Order card',
  description: 'One order at a glance.',
  props: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
});
const catalog = defineCatalog([OrderCard]);

describe('ToolHandler.describe', () => {
  it('replaces what the model is shown for this turn, after the role gate', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'lookup',
        kind: 'read',
        description: 'static',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      {
        execute: async () => ({}),
        describe: ({ actor, threadId }) => ({ description: `for ${actor.id} in ${threadId}` }),
      },
    );
    const [definition] = await registry.definitionsFor(
      { id: 'u1', roles: ['ADMIN'] },
      new DefaultToolAuthorizer(),
      undefined,
      { threadId: 't1' },
    );
    expect(definition?.description).toBe('for u1 in t1');
  });
});

describe('genui in config/agent.ts', () => {
  let booted: BootedApp | null = null;
  afterEach(async () => {
    await booted?.close();
    booted = null;
  });
  const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };
  const showOrder: FakeScript = (_args, turn) =>
    turn === 0
      ? { text: '', toolCall: { name: 'ui__show_order_card', input: { id: 7 } } }
      : { text: 'There.' };

  it('registers a tool per component that pushes a validated ui frame', async () => {
    booted = await bootAgentApp({
      model: new FakeModelProvider(showOrder),
      genui: genui({ catalog, mode: 'per-component', showTool: true }),
    });
    const tools = (await (
      await fetch(`${booted.url}/agent/tools`, { headers })
    ).json()) as ToolCatalogEntry[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(['ui__show', 'ui__show_order_card']);

    const response = await fetch(`${booted.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'show order 7' }),
    });
    const frames = await readSse(response);
    expect(frames.map((frame) => frame.data)).toContainEqual({
      kind: 'ui',
      id: 'call-0-ui__show_order_card:ui:0',
      component: 'OrderCard',
      version: 1,
      props: { id: 7 },
      fallbackText: '```\n{\n  "id": 7\n}\n```',
      toolCallId: 'call-0-ui__show_order_card',
    });
  });

  it('validates against the catalog a resolver picks for the request, built through the container', async () => {
    class TenantCatalogs extends GenuiCatalogResolver {
      resolve(scope: GenuiCatalogScope): Catalog {
        // This tenant's OrderCard takes a string id.
        return scope.actor.id === 'u1'
          ? defineCatalog([
              defineComponent({
                ...OrderCard,
                props: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              }),
            ])
          : catalog;
      }
    }
    booted = await bootAgentApp({
      model: new FakeModelProvider(showOrder),
      genui: genui({ catalog, mode: 'per-component', resolver: TenantCatalogs }),
    });
    const frames = await readSse(
      await fetch(`${booted.url}/agent/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'show order 7' }),
      }),
    );
    const outcome = frames.find((frame) => String(frame.data.kind).startsWith('tool-output'));
    expect(outcome?.data.kind).toBe('tool-output-error');
    expect(String(outcome?.data.error)).toMatch(/invalid OrderCard props/);
  });
});
