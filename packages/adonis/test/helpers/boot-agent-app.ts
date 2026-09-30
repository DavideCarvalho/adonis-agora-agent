import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import type { Actor, AgentConfig } from '../../src/index.js';

export interface BootedApp {
  url: string;
  close(): Promise<void>;
}

/** Reads the caller from `x-actor-id` (and optional comma-separated `x-actor-roles`, default ADMIN). */
export const headerActorResolver = {
  resolve(req: unknown): Actor {
    const ctx = req as HttpContext;
    const id = ctx.request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    const roles = ctx.request.header('x-actor-roles');
    return { id, roles: roles === undefined ? ['ADMIN'] : roles.split(',').map((r) => r.trim()) };
  },
};

/**
 * A real AdonisJS app with the agent provider mounted, listening on a random port — the routes as a
 * browser reaches them. Registers the body parser the way every app's `start/kernel.ts` does.
 */
export async function bootAgentApp(
  agent: Partial<AgentConfig> & Pick<AgentConfig, 'model'>,
  options: { anonymous?: boolean } = {},
): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: { providers: [() => import('../../providers/agent_provider.js')] },
      config: {
        agent:
          options.anonymous === true ? agent : { actorResolver: headerActorResolver, ...agent },
      },
    })
    .create(new URL('../../', import.meta.url));

  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
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

/** One parsed SSE frame: the `event:` name (`message` when absent) and its JSON `data`. */
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Read an SSE body frame by frame, handing each to `onFrame` as it arrives. */
export async function readSse(
  response: Response,
  onFrame?: (frame: SseFrame) => Promise<void>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
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
      if (data.length > 0) {
        const frame = { event, data: JSON.parse(data) as Record<string, unknown> };
        frames.push(frame);
        await onFrame?.(frame);
      }
      at = buffer.indexOf('\n\n');
    }
  }
  return frames;
}
