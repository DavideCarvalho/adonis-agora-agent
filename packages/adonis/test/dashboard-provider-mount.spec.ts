// @vitest-environment node
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDashboardAuthorize } from '../src/dashboard/index.js';
import type { AgentGovernanceAuthorize } from '../src/governance-gate.js';

/**
 * Boots a real AdonisJS app with ONLY `providers/dashboard_provider.ts` (this package's OWN embedded
 * dashboard, NOT `@adonis-agora/agent-dashboard`'s standalone provider) and hits the mount over HTTP —
 * mirrors `@adonis-agora/agent-dashboard`'s `test/dashboard-mount.spec.ts` byte-for-byte in structure,
 * since both providers share the exact same mount/gate decision logic (`src/dashboard/index.js`).
 *
 * The observable used throughout is the response to an UNAUTHENTICATED request at the mount:
 * - mounted  → the dashboard's own gate runs first and replies `401` (no resolvable actor)
 * - unmounted → the router replies `404`
 *
 * That discriminator needs no built SPA (`dist/assets/spa` only exists after the package's own build
 * copies it in from `@adonis-agora/agent-dashboard`'s `dist/spa`), which is what makes it usable in a
 * plain test run — this suite never reads `index.html`/assets off disk.
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
  governanceAuthorize?: AgentGovernanceAuthorize;
  dashboardAuthorize?: AgentDashboardAuthorize;
  dashboardEnabled?: boolean;
  governanceQueries?: false;
}): Promise<BootedApp> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [() => import('../providers/dashboard_provider.js')],
      },
      config: {
        agent: {
          actorResolver: headerActorResolver,
          ...(options.governanceAuthorize !== undefined
            ? { governanceAuthorize: options.governanceAuthorize }
            : {}),
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

const adminOnly = (actor: { roles?: string[] }) => actor.roles?.includes('ADMIN') ?? false;

let booted: BootedApp | null = null;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await booted?.close();
  booted = null;
});

const warnings = () => warn.mock.calls.map((call) => String(call[0]));

describe('embedded dashboard_provider mount vs. the agent governance gate', () => {
  it('does not mount the console when the agent has no governanceAuthorize', async () => {
    booted = await bootApp({});

    for (const path of ['/agent/dashboard', '/agent/dashboard/assets/index.js']) {
      const response = await fetch(`${booted.url}${path}`);
      expect(response.status, `GET ${path}`).toBe(404);
    }
  });

  it('explains the refusal at boot, naming both migration paths', async () => {
    booted = await bootApp({});

    const message = warnings().find((text) => text.includes('agent-dashboard'));
    expect(message).toBeDefined();
    expect(message).toContain('governanceAuthorize');
    expect(message).toContain('governanceAuthorize: () => true');
    expect(message).toContain('approvals/mine');
  });

  it('mounts the console normally when a governanceAuthorize gate is configured', async () => {
    booted = await bootApp({ governanceAuthorize: adminOnly });

    // Mounted: the dashboard's own gate answers first, so an unauthenticated caller gets 401 — not
    // the router's 404. Both the shell route and the asset wildcard are registered. `sendIndex`/
    // `sendAsset` (which would need the built SPA on disk) never run: the gate short-circuits first.
    for (const path of ['/agent/dashboard', '/agent/dashboard/assets/index.js']) {
      const response = await fetch(`${booted.url}${path}`);
      expect(response.status, `GET ${path}`).toBe(401);
    }
    expect(warnings().filter((text) => text.includes('agent-dashboard'))).toEqual([]);
  });

  it("keeps the dashboard's own authorize gate in force once mounted", async () => {
    booted = await bootApp({ governanceAuthorize: adminOnly, dashboardAuthorize: adminOnly });

    const denied = await fetch(`${booted.url}/agent/dashboard`, {
      headers: { 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT' },
    });
    expect(denied.status).toBe(403);
  });

  it('stays off, and silent, when the dashboard is explicitly disabled', async () => {
    booted = await bootApp({ governanceAuthorize: adminOnly, dashboardEnabled: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status).toBe(404);
    expect(warnings().filter((text) => text.includes('agent-dashboard'))).toEqual([]);
  });

  it('does not mount when governanceQueries is false, even with a gate configured', async () => {
    booted = await bootApp({ governanceAuthorize: adminOnly, governanceQueries: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status, 'GET /agent/dashboard').toBe(404);
  });

  it('names governanceQueries — not the gate — as the cause in the boot warning', async () => {
    booted = await bootApp({ governanceAuthorize: adminOnly, governanceQueries: false });

    const mine = warnings().filter((text) => text.includes('agent-dashboard'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('governanceQueries');
    expect(mine[0]).not.toContain('no `governanceAuthorize` gate is configured');
  });
});
