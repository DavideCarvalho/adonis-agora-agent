import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { agUiAdapter } from '../src/ag-ui/index.js';
import { defineCatalog } from '../src/genui/index.js';
import { defineTool } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp, readSse } from './helpers/boot-agent-app.js';

let app: BootedApp | undefined;
afterEach(async () => {
  await app?.close();
});
it('carries explicit text-only renderer capabilities through actual AGUI HTTP without unsafe UI', async () => {
  const catalog = defineCatalog([
    {
      name: 'Card',
      title: 'Card',
      description: 'card',
      props: z.object({ title: z.string() }),
      fallbackText: ({ title }) => String(title),
    },
  ]);
  const tool = defineTool(
    { name: 'show', kind: 'read', description: 'show', terminal: true, input: z.object({}) },
    async (_, ctx) => {
      await ctx.emitUi('Card', { title: 'Complete result' });
      return 'shown';
    },
  );
  app = await bootAgentApp({
    model: new FakeModelProvider(() => ({ text: '', toolCall: { name: 'show', input: {} } })),
    tools: [tool],
    genui: async () => ({ catalog, tools: [] }),
    adapters: [agUiAdapter({ quietMs: 80 })],
  });
  const response = await fetch(`${app.url}/agent/ag-ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-id': 'u1' },
    body: JSON.stringify({
      threadId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      messages: [{ id: 'user', role: 'user', content: 'show' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { uiCapabilities: { components: [] } },
    }),
  });
  expect(response.status).toBe(200);
  const events = (await readSse(response)).map((frame) => frame.data);
  expect(
    events.some(
      (event) => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta === 'Complete result',
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain('agora.ui');
  expect(events.at(-1)?.type).toBe('RUN_FINISHED');
});
