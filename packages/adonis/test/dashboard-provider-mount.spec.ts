// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { AgentDashboardAuthorize, AgentDashboardConfig } from '../src/dashboard/index.js';

/**
 * Boots a real AdonisJS app with ONLY `providers/dashboard_provider.ts` (this package's OWN embedded
 * dashboard, NOT `@adonis-agora/agent-dashboard`'s standalone provider) and hits the mount over HTTP —
 * mirrors `@adonis-agora/agent-dashboard`'s `test/dashboard-mount.spec.ts` byte-for-byte in structure,
 * since both providers share the exact same mount/gate decision logic (`src/dashboard/index.js`).
 *
 * Mounted vs. unmounted is told apart by status: the router answers `404` for an unmounted console,
 * while a mounted one runs `dashboard.authorize` first. That discriminator needs no built SPA (`dist/assets/spa` only exists after the package's own build
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
  inProduction?: boolean;
  dashboardAuthorize?: AgentDashboardAuthorize;
  dashboardAccessDenied?: AgentDashboardConfig['accessDenied'];
  dashboardEnabled?: boolean;
  governanceQueries?: false;
  setup?: (app: { container: { bindValue(key: unknown, value: unknown): void } }) => void;
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
          ...(options.governanceQueries === false ? { governanceQueries: false as const } : {}),
          dashboard: {
            ...(options.dashboardEnabled !== undefined
              ? { enabled: options.dashboardEnabled }
              : {}),
            ...(options.dashboardAuthorize !== undefined
              ? { authorize: options.dashboardAuthorize }
              : {}),
            ...(options.dashboardAccessDenied !== undefined
              ? { accessDenied: options.dashboardAccessDenied }
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
  options.setup?.(app as never);
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

const isAdmin = (actor?: { roles?: string[] }) => actor?.roles?.includes('ADMIN') ?? false;
const adminOnly = (_ctx: unknown, actor?: { roles?: string[] }) => isAdmin(actor);
const PAGE = { accept: 'text/html,application/xhtml+xml' };

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

describe('embedded dashboard_provider — mounting and the default', () => {
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

    const page = await fetch(`${booted.url}/agent/dashboard`, {
      headers: { ...PAGE, 'x-actor-id': 'staff-1', 'x-actor-roles': 'ADMIN' },
    });
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');

    const api = await fetch(`${booted.url}/agent/dashboard/assets/index.js`, {
      headers: { accept: 'application/json' },
    });
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'forbidden' });

    const mine = warnings().filter((text) => text.includes('no `authorize` configured'));
    expect(mine).toEqual([
      '[@adonis-agora/agent] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/agent.ts.',
    ]);
  });

  it('logs no warning when authorize is set', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly });
    expect(warnings()).toEqual([]);
  });

  it('applies authorize once mounted', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly });

    const denied = await fetch(`${booted.url}/agent/dashboard`, {
      headers: { ...PAGE, 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT' },
    });
    expect(denied.status).toBe(403);
  });

  it('stays off, and silent, when the dashboard is explicitly disabled', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly, dashboardEnabled: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status).toBe(404);
    expect(warnings()).toEqual([]);
  });

  it('does not mount when governanceQueries is false, and says so at boot', async () => {
    booted = await bootApp({ dashboardAuthorize: adminOnly, governanceQueries: false });

    const response = await fetch(`${booted.url}/agent/dashboard`);
    expect(response.status, 'GET /agent/dashboard').toBe(404);
    const mine = warnings().filter((text) => text.includes('agent-dashboard'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('governanceQueries');
  });

  it('refuses a denied actor with the 403 page, honouring accessDenied options', async () => {
    booted = await bootApp({
      dashboardAuthorize: adminOnly,
      dashboardAccessDenied: { brand: 'Entre Textos', title: 'Sem acesso', homeHref: '/admin' },
    });

    const response = await fetch(`${booted.url}/agent/dashboard/assets/index.js`, {
      headers: { ...PAGE, 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<h1>Sem acesso</h1>');
    expect(html).toContain('Entre Textos');
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain('<script');
  });

  it('serves an accessDenied renderer HTML, or stands down when it redirected', async () => {
    booted = await bootApp({
      dashboardAuthorize: (_ctx, actor) =>
        actor === undefined ? { allowed: false, reason: 'unauthenticated' } : isAdmin(actor),
      dashboardAccessDenied: (info, ctx) => {
        if (info.status === 401) {
          ctx.response.redirect().toPath('/entrar');
          return;
        }
        return `<p>custom ${info.status} ${info.basePath}</p>`;
      },
    });

    const anonymous = await fetch(`${booted.url}/agent/dashboard`, {
      redirect: 'manual',
      headers: PAGE,
    });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toBe('/entrar');
  });

  it('keeps a redirect authorize wrote itself (actor resolved, denied)', async () => {
    booted = await bootApp({
      dashboardAuthorize: (ctx, actor) => {
        if (!isAdmin(actor)) {
          ctx.response.redirect().toPath('/acesso-negado');
          return false;
        }
        return true;
      },
    });

    const response = await fetch(`${booted.url}/agent/dashboard`, {
      redirect: 'manual',
      headers: { 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/acesso-negado');
  });

  it('maps authorize results to the access-denied page status', async () => {
    booted = await bootApp({
      dashboardAuthorize: (_ctx, actor) => {
        if (actor?.id === 'allowed-object') return { allowed: true };
        if (actor?.id === 'anonymous-ish') return { allowed: false, reason: 'unauthenticated' };
        if (actor?.id === 'forbidden') return { allowed: false, reason: 'forbidden' };
        if (actor?.id === 'bare-object') return { allowed: false };
        if (actor?.id === 'throws') throw new Error('policy blew up');
        if (actor?.id === 'true') return true;
        return false;
      },
    });
    const as = (id: string) =>
      fetch(`${booted?.url}/agent/dashboard/assets/index.js`, {
        redirect: 'manual',
        headers: { ...PAGE, 'x-actor-id': id, 'x-actor-roles': 'PATIENT' },
      });

    // Allowed: the gate passes and the request reaches the asset handler (no SPA built in tests, so
    // whatever it answers, it is NOT the gate's 401/403 page).
    for (const id of ['true', 'allowed-object']) {
      const response = await as(id);
      expect([401, 403], id).not.toContain(response.status);
    }

    const unauthenticated = await as('anonymous-ish');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('content-type')).toContain('text/html');
    expect(await unauthenticated.text()).toContain('<h1>Sign in required</h1>');

    for (const id of ['forbidden', 'bare-object', 'bare-false', 'throws']) {
      const response = await as(id);
      expect(response.status, id).toBe(403);
      expect(response.headers.get('content-type'), id).toContain('text/html');
    }
  });
});

describe('embedded dashboard_provider — dashboard.authorize forms', () => {
  class AuditLog {
    entries: string[] = [];
  }

  const asAdmin = (url: string, accept = 'text/html') =>
    fetch(`${url}/agent/dashboard/assets/index.js`, {
      redirect: 'manual',
      headers: { 'x-actor-id': 'staff-1', 'x-actor-roles': 'ADMIN', accept },
    });
  const asPatient = (url: string, accept = 'text/html') =>
    fetch(`${url}/agent/dashboard/assets/index.js`, {
      redirect: 'manual',
      headers: { 'x-actor-id': 'patient-1', 'x-actor-roles': 'PATIENT', accept },
    });

  /** A class authorizer, built per request by the app container (its deps come from the container). */
  class ConsoleAccess {
    constructor(private audit: AuditLog) {}
    authorize(_ctx: HttpContext, actor?: { id: string; roles?: string[] }) {
      this.audit.entries.push(actor?.id ?? '');
      return isAdmin(actor) ? { allowed: true as const } : { allowed: false as const };
    }
  }

  it('accepts a ctx-only function', async () => {
    booted = await bootApp({
      dashboardAuthorize: (ctx) => ctx.request.header('x-actor-roles') === 'ADMIN',
    });
    expect([401, 403]).not.toContain((await asAdmin(booted.url)).status);
    expect((await asPatient(booted.url)).status).toBe(403);
  });

  it('accepts a class, built through the container', async () => {
    const audit = new AuditLog();
    booted = await bootApp({
      dashboardAuthorize: ConsoleAccess,
      setup: (app) =>
        app.container.bindValue(ConsoleAccess, {
          authorize: (ctx: HttpContext, actor?: { id: string; roles?: string[] }) =>
            new ConsoleAccess(audit).authorize(ctx, actor),
        }),
    });
    expect([401, 403]).not.toContain((await asAdmin(booted.url)).status);
    const denied = await asPatient(booted.url);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain('text/html');
    const api = await asPatient(booted.url, 'application/json');
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'forbidden' });
    expect(audit.entries).toEqual(['staff-1', 'patient-1', 'patient-1']);
  });

  it('accepts a lazy import, importing it once', async () => {
    let imports = 0;
    class Lazy {
      authorize(_ctx: HttpContext, actor?: { roles?: string[] }) {
        return isAdmin(actor) || { allowed: false as const, reason: 'unauthenticated' as const };
      }
    }
    booted = await bootApp({
      dashboardAuthorize: async () => {
        imports++;
        return { default: Lazy };
      },
    });
    expect([401, 403]).not.toContain((await asAdmin(booted.url)).status);
    expect((await asPatient(booted.url)).status).toBe(401);
    expect((await asPatient(booted.url)).status).toBe(401);
    expect(imports).toBe(1);
  });

  it('a { redirectTo } result redirects a page navigation and answers 401 otherwise', async () => {
    booted = await bootApp({
      dashboardAuthorize: (_ctx, actor) => isAdmin(actor) || { redirectTo: '/entrar' },
    });
    const page = await asPatient(booted.url, 'text/html,application/xhtml+xml');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/entrar');

    const api = await asPatient(booted.url, 'application/json');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'unauthenticated', redirectTo: '/entrar' });
  });
});
