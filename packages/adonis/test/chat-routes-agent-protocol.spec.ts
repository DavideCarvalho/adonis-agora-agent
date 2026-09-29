import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Actor, type AgentConfig, defineTool } from '../src/index.js';
import { FakeModelProvider, type FakeScript } from '../src/testing/fake-model-provider.js';

/**
 * The chat routes over real HTTP, as `@dudousxd/nestjs-agent-react` calls them: the agent stream
 * protocol on the wire, and HITL decisions that name the tool call alone.
 */

const headerActorResolver = {
  resolve(req: unknown): Actor {
    const ctx = req as HttpContext;
    const id = ctx.request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    return { id, roles: ['ADMIN'] };
  },
};

interface BootedApp {
  url: string;
  close(): Promise<void>;
}

async function bootApp(script: FakeScript, extra: Partial<AgentConfig> = {}): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
      config: {
        agent: {
          model: new FakeModelProvider(script),
          actorResolver: headerActorResolver,
          streamProtocol: 'agent',
          ...extra,
        },
      },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  // What every Adonis app registers in `start/kernel.ts`: JSON bodies are parsed by a router middleware.
  const router = await app.container.make('router');
  router.use([() => import('@adonisjs/core/bodyparser_middleware')]);
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

const json = { 'content-type': 'application/json', 'x-actor-id': 'u1' };

/** Read an SSE body frame by frame, handing each `data:` JSON (or named event) to `onFrame`. */
async function readFrames(
  response: Response,
  onFrame?: (frame: { event: string; data: Record<string, unknown> }) => Promise<void>,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf('\n\n');
    while (at !== -1) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      const frame = { event, data: JSON.parse(data) as Record<string, unknown> };
      frames.push(frame);
      await onFrame?.(frame);
      at = buffer.indexOf('\n\n');
    }
  }
  return frames;
}

describe('POST /agent/chat under streamProtocol: agent', () => {
  it('writes meta, the AgentStreamEvent frames and done', async () => {
    booted = await bootApp(() => ({ text: 'Hello there' }));
    const response = await fetch(`${booted.url}/agent/chat`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(response);
    expect(frames[0]?.event).toBe('meta');
    expect(frames.at(-1)).toEqual({ event: 'done', data: {} });
    const kinds = frames.filter((frame) => frame.event === 'message').map((frame) => frame.data);
    expect(kinds.map((event) => event.kind)).toEqual([
      'step-start',
      'text',
      'step-finish',
      'title',
    ]);
    expect(kinds[1]).toEqual({ kind: 'text', text: 'Hello there' });
  });

  it('approves a parked action named by its tool call alone', async () => {
    const refund = defineTool(
      {
        name: 'refund',
        kind: 'action',
        description: 'refund an order',
        input: z.object({ id: z.number() }),
        roles: ['ADMIN'],
      },
      () => ({ refunded: true }),
    );
    booted = await bootApp(
      (_args, turn) =>
        turn === 0
          ? { text: '', toolCall: { name: 'refund', input: { id: 7 } } }
          : { text: 'Done.' },
      { tools: [refund] },
    );
    const url = booted.url;
    const response = await fetch(`${url}/agent/chat`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message: 'refund 7' }),
    });
    const decisions: number[] = [];
    const frames = await readFrames(response, async (frame) => {
      if (frame.data.kind === 'approval-requested') {
        const decided = await fetch(`${url}/agent/tool-call/approve`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ toolCallId: frame.data.id }),
        });
        decisions.push(decided.status);
      }
    });
    expect(decisions).toEqual([200]);
    expect(frames.map((frame) => frame.data)).toContainEqual({
      kind: 'tool-output',
      id: 'call-0-refund',
      output: { refunded: true },
    });
  });

  it('answers 404 for a decision on a tool call nobody knows', async () => {
    booted = await bootApp(() => ({ text: 'hi' }));
    const response = await fetch(`${booted.url}/agent/tool-call/approve`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ toolCallId: 'nope' }),
    });
    expect(response.status).toBe(404);
  });
});
