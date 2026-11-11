// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentDashboardAuthorize } from '@adonis-agora/agent/dashboard';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

/**
 * Boots a real AdonisJS app with ONLY the dashboard provider and hits the mount over HTTP, so a
 * console that was not mounted answers the router's own `404` rather than a stubbed assertion about
 * registration. The agent provider is deliberately absent: the dashboard reads `config('agent')`
 * directly and never touches the agent provider at runtime, so leaving it out keeps this spec off the
 * agent package's build output.
 *
 * Mounted vs. unmounted is told apart by status: the router answers `404` for an unmounted console,
 * while a mounted one runs `dashboard.authorize` first. That discriminator needs no built SPA (`dist/spa` only exists after `vite build`), which is what
 * makes it usable in a plain test run.
 */

/** Reads the caller from `x-actor-id` / `x-actor-roles`; throws (→ 401) when absent. */
const headerActorResolver = {
  resolve(req: unknown) {
    const ctx = req as HttpContext;
    const id = ctx.request.header('x-actor-id');
    if (id === undefined) throw new Error('unauthorized');
    const roles = (ctx.request.header('x-actor-roles') ?? '').split(',').filter(Boolean);
    return { id, roles };
  },
};

interface BootedApp {
  url: string;
  close(): Promise<void>;
}

async function bootApp(options: {
  inProduction?: boolean;
  dashboardAuthorize?: AgentDashboardAuthorize;
  dashboardEnabled?: boolean;
  governanceQueries?: false;
}): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [() => import('../providers/agent_dashboard_provider.js')],
      },
      config: {
        agent: {
          actorResolver: headerActorResolver,
          ...(options.governanceQueries === false ? { governanceQueries: false as const } : {}),
          dashboard: {
            ...(options.dashboardEnabled !== undefined
              ? { enabled: options.dashboardEnabled }
              : {}),
            ...(options.dashboardAuthorize !== undefined
              ? { authorize: options.dashboardAuthorize }
              : {}),
          },
        },
      },
    })
    .create(new URL('../', import.meta.url));

  const app = ignitor.createApp('web');
  if (options.inProduction === true) {
    Object.defineProperty(app, 'inProduction', { get: () => true });
  }
  await app.init();
  // `app.boot()` only — `app.start()` notifies the parent process (`process.send`), which the vitest
  // forks pool rejects. Routes are registered by the provider's `boot()`, so booting is enough.
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

const adminOnly = (_ctx: unknown, actor?: { roles?: string[] }) =>
  actor?.roles?.includes('ADMIN') ?? false;
const PAGE = { accept: 'text/html' };

let booted: BootedApp | null = null;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await booted?.close();
  booted = null;
});

const warnings = () => warn.mock.calls.map((call) => String(call[0]));

describe('standalone dashboard provider — mounting and access', () => {
  it('mounts without authorize and is open outside production', async () => {
    booted = await bootApp({});

    // Open: the request reaches the asset handler (no SPA built in tests, so whatever it answers,
    // it is neither the router's 404-for-unmounted nor the gate's 401/403).
    const response = await fetch(`${booted.url}/agent/dashboard/assets/index.js`, {
      headers: PAGE,
    });
    expect([401, 403]).not.toContain(response.status);
  });

  it('denies every request with 403 in production when authorize is omitted, warning once', async () => {
    booted = await bootApp({ inProduction: true });

    const page = await fetch(`${booted.url}/agent/dashboard`, { headers: PAGE });
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');
    const api = await fetch(`${booted.url}/agent/dashboard/assets/index.js`, {
      headers: { accept: 'application/json' },
    });
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'forbidden' });
    expect(warnings().filter((text) => text.includes('no `authorize` configured'))).toHaveLength(1);
  });

  it('applies authorize once mounted', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly });

    const denied = await fetch(`${booted.url}/agent/dashboard`, {
      headers: { ...PAGE, 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT' },
    });
    expect(denied.status).toBe(403);
    expect(warnings()).toEqual([]);
  });

  it('stays off, and silent, when the dashboard is explicitly disabled', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly, dashboardEnabled: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status).toBe(404);
    expect(warnings()).toEqual([]);
  });

  // `governanceQueries: undefined` is NOT this case: the agent provider defaults it to the Lucid
  // read-model when the main store is Lucid, so only an explicit `false` is decidable from config.
  it('does not mount when governanceQueries is false, and names it in the boot warning', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly, governanceQueries: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status, 'GET /agent/dashboard').toBe(404);
    const mine = warnings().filter((text) => text.includes('agent-dashboard'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('governanceQueries');
  });
});
