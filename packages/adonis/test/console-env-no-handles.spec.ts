// @vitest-environment node
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { InMemoryGovernanceQueries } from '../src/testing/in-memory-governance-queries.js';
import { InMemoryAgentStore } from '../src/testing/in-memory-store.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * An ace command (the `console` environment) boots the agent with everything federated configured
 * and exits: the agent opens no long-lived connection or timer there (spec §12).
 */

/** Live timers, sockets and the like, by kind (what keeps a process from exiting). */
function handles(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

describe('a console-environment app opens nothing that keeps the process alive', () => {
  it('boots and terminates with no handle left from the agent', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new RedisBus();
    const subscribe = vi.fn();
    const before = handles();
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          providers: [
            () => import('../providers/agent_provider.js'),
            () => import('../providers/mcp_provider.js'),
          ],
        },
        config: {
          redis: { connection: 'main', connections: { main: {} } },
          mcp: { name: 'test', version: '0.0.0', actor: { id: 'dev', roles: ['ADMIN'] } },
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => ({ id: 'u' }) },
            governanceQueries: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
            consoleCommands: { prefix: 'hub', actions: true },
            dashboard: {
              apps: {
                et: {
                  governance: new InMemoryGovernanceQueries(new InMemoryAgentStore()),
                  controlPlane: { prefix: 'et' },
                },
              },
            },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    // Every interval started while the app runs (an unref'd one is not a handle, but still a timer).
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const app = ignitor.createApp('console');
    await app.init();
    app.container.bindValue(
      'redis' as never,
      {
        connection: () => ({ ...bus.connection(), subscribe }),
      } as never,
    );
    await app.boot();
    await app.start(async () => {});
    // No channel in an ace process: nothing subscribed to Redis.
    expect(subscribe).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    intervals.mockRestore();
    // Nothing started while it runs (not only closed at the end): no timer, no socket.
    const running = handles();
    await app.terminate();
    const after = handles();
    for (const kind of ['Timeout', 'TCPSocketWrap', 'TCPWRAP', 'Immediate']) {
      expect(running[kind] ?? 0, `${kind} while running`).toBeLessThanOrEqual(before[kind] ?? 0);
      expect(after[kind] ?? 0, kind).toBeLessThanOrEqual(before[kind] ?? 0);
    }
  });
});
