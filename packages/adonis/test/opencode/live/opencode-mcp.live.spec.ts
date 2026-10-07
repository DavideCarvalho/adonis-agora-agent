import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentService,
  type MemoryProvider,
  type StoreMemoryInput,
  ToolRegistry,
} from '../../../src/index.js';
import { openCode } from '../../../src/opencode/index.js';
import { InMemoryAgentStore } from '../../../src/testing/index.js';
import { type BootedApp, bootAgentApp } from '../../helpers/boot-agent-app.js';
import { actor, approve, frames, framesUntil } from '../../helpers/opencode-harness.js';
import { LiveHost } from './live-host.js';

/**
 * The app's tools reaching a real OpenCode 2 session over the engine's MCP endpoint — skipped
 * unless a server is configured (see `opencode.live.spec.ts`). The app listens on a local port;
 * OpenCode calls `POST /agent/opencode/mcp` with the token the engine registered and names its
 * session in each call's `_meta`, which ties the call to the turn: a component the tool pushes lands
 * in the turn's stream and message, `remember` writes at the actor's scope, and an action runs
 * after the person approved OpenCode's permission.
 */
const url = process.env.OPENCODE_LIVE_URL;
const live = describe.skipIf(url === undefined);
const TIMEOUT = 240_000;

live('openCode tools over MCP against a real OpenCode 2 server', () => {
  let app: BootedApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  }, 30_000);

  it(
    "pushes a tool's component into the turn, remembers a fact, and runs an approved action",
    async () => {
      const written: StoreMemoryInput[] = [];
      const memory: MemoryProvider = {
        list: () => [],
        forget: () => false,
        write: (input) => {
          written.push(input);
          return { id: `m${written.length}`, ...input, updatedAt: new Date().toISOString() };
        },
      };
      const endpoint = { url: '' };
      const store = new InMemoryAgentStore();
      const sent: unknown[] = [];
      // Code mode reaches MCP tools through `execute`; the engine adds the rules for its own tools.
      const host = new LiveHost(`live-mcp-${Date.now()}`, [
        { action: '*', effect: 'deny' },
        { action: 'execute', effect: 'allow' },
      ]);
      app = await bootAgentApp({
        engine: openCode({
          host,
          tools: {
            get url() {
              return endpoint.url;
            },
          },
        }),
        stores: { memory: async () => store },
        store: 'memory',
        memory: { provider: memory },
      });
      endpoint.url = `${app.url}/agent/opencode/mcp`;
      const registry = await app.app.container.make(ToolRegistry);
      registry.register(
        {
          name: 'show_chart',
          kind: 'read',
          description: 'Show the user a chart of their weekly numbers.',
          inputSchema: z.object({}),
        },
        {
          execute: async (_input, ctx) => {
            await ctx.emitUi('Chart', { series: [3, 5, 8] }, { id: 'weekly-chart' });
            return { shown: true };
          },
        },
      );
      registry.register(
        {
          name: 'send_note',
          kind: 'action',
          description: 'Send the user a short note.',
          inputSchema: z.object({ text: z.string() }),
        },
        {
          execute: async (input) => {
            sent.push(input);
            return { sent: true };
          },
        },
      );
      const service = await app.app.container.make(AgentService);
      const { runId, threadId } = await service.chat({
        actor,
        message:
          'First call the show_chart tool. Then call the remember tool with key "favorite-color" and fact "The user likes blue". Then call the send_note tool with text "hi". Then reply with the single word: done.',
      });
      const asked = await framesUntil(service, runId, (f) => f.kind === 'approval-requested');
      const card = asked.at(-1) as { id: string };
      await approve(service, card.id);
      const fs = await frames(service, runId);

      expect(fs).toContainEqual({
        kind: 'ui',
        id: 'weekly-chart',
        component: 'Chart',
        props: { series: [3, 5, 8] },
      });
      const messages = (await store.getThread(threadId))?.messages ?? [];
      expect(messages.flatMap((m) => m.ui ?? []).map((c) => c.id)).toContain('weekly-chart');
      expect(written).toEqual([
        expect.objectContaining({
          key: 'favorite-color',
          scope: 'actor:u1',
          origin: expect.objectContaining({ author: 'agent', threadId, runId }),
        }),
      ]);
      expect(sent).toEqual([{ text: 'hi' }]);
    },
    TIMEOUT,
  );
});
