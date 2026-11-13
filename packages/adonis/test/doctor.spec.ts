// @vitest-environment node
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { describe, expect, it } from 'vitest';
import { DEV_TOOLS_BINDING, resolveDevTools } from '../src/dev-tools/resolve.js';
import { readDoctorChecks, runAgoraDoctor } from '../src/doctor/agora_doctor.js';
import {
  checkActorResolver,
  checkConsoleGate,
  checkDevToolsAuthkitMcp,
  checkDevToolsGate,
  checkMcpCsrf,
  checkMcpExecute,
  checkMcpOpen,
  checkTenancyStore,
  mcpConfig,
  readAuthkitMcpOption,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import { FakeModelProvider, InMemoryAgentStore } from '../src/testing/index.js';

describe('agent doctor checks', () => {
  it('console gate: warn in dev, error in production, ok with authorize, skip when off', () => {
    expect(checkConsoleGate({}, false).status).toBe('warn');
    expect(checkConsoleGate({}, true).status).toBe('error');
    expect(checkConsoleGate({ dashboard: { authorize: () => true } }, true).status).toBe('ok');
    expect(checkConsoleGate({ dashboard: { enabled: false } }, true).status).toBe('skip');
    expect(checkConsoleGate({ governanceQueries: false }, true).status).toBe('skip');
    expect(checkConsoleGate(undefined, true).status).toBe('skip');
  });

  it('actor resolver: public endpoints without a quota are an error in production', () => {
    expect(checkActorResolver({ actorResolver: {} }, true).status).toBe('ok');
    expect(checkActorResolver({}, false).status).toBe('warn');
    expect(checkActorResolver({}, true).status).toBe('error');
    expect(checkActorResolver({ quota: { limits: {} } }, true).status).toBe('warn');
  });

  it('mcp-open: a fixed actor without auth, on the base or an extra endpoint', () => {
    expect(checkMcpOpen({ auth: {} }, true).status).toBe('ok');
    const open = checkMcpOpen({ actor: { id: 'dev' }, path: 'api/mcp' }, true);
    expect(open).toMatchObject({ status: 'error' });
    expect(open.message).toContain('/api/mcp');
    expect(
      checkMcpOpen({ auth: {}, actor: { id: 'x' }, endpoints: [{ path: 'mcp/x' }] }, true).status,
    ).toBe('ok');
    expect(checkMcpOpen({ actor: { id: 'x' } }, false).status).toBe('warn');
    expect(checkMcpOpen(undefined, true).status).toBe('skip');
  });

  it("mcp-execute: 'execute' without an authorizer warns", () => {
    expect(checkMcpExecute({}).status).toBe('ok');
    expect(checkMcpExecute({ actions: 'execute' }).status).toBe('warn');
    expect(checkMcpExecute({ endpoints: [{ path: 'x', actions: 'execute' }] }).status).toBe('warn');
    expect(checkMcpExecute({ actions: 'execute', authorizer: {} }).status).toBe('ok');
  });

  it("mcp-execute: devTools.actions 'execute' warns and suggests the map form", () => {
    const dev = checkMcpExecute({ devTools: { actions: 'execute' } });
    expect(dev).toMatchObject({ status: 'warn' });
    expect(dev.fix).toContain('devTools.actions: { payments: authorizeByRoles(');
    expect(checkMcpExecute({ devTools: { actions: { payments: () => true } } }).status).toBe('ok');
    expect(checkMcpExecute({ devTools: { actions: ['durable'] } }).status).toBe('ok');
    expect(checkMcpExecute({ devTools: false }).status).toBe('ok');
    const both = checkMcpExecute({ actions: 'execute', devTools: { actions: 'execute' } });
    expect(both.fix).toContain('authorizer');
    expect(both.fix).toContain('devTools.actions: {');
  });

  it('mcp-csrf: every MCP path, including the dev tools one', () => {
    const shield = { csrf: { enabled: true, exceptRoutes: ['/api/mcp'] } };
    const result = checkMcpCsrf({ path: 'api/mcp', endpoints: [{ path: 'mcp/family' }] }, shield);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('/mcp/family');
    expect(result.message).toContain('/mcp/agora');
    expect(result.message).not.toContain('/api/mcp,');
    expect(checkMcpCsrf({ path: 'api/mcp', devTools: false }, shield).status).toBe('ok');
    expect(
      checkMcpCsrf(
        {},
        {
          csrf: {
            enabled: true,
            exceptRoutes: (ctx: { request: { url(): string } }) =>
              ctx.request.url().startsWith('/mcp'),
          },
        },
      ).status,
    ).toBe('ok');
  });

  it('dev-tools-gate: console-less libs without devTools.authorize warn in production', () => {
    expect(checkDevToolsGate({}, [], true).status).toBe('skip');
    expect(checkDevToolsGate({}, ['resilience'], true).status).toBe('warn');
    expect(checkDevToolsGate({}, ['resilience'], false).status).toBe('ok');
    expect(checkDevToolsGate({ devTools: { authorize: () => true } }, ['authz'], true).status).toBe(
      'ok',
    );
    expect(checkDevToolsGate({ devTools: false }, ['authz'], true).status).toBe('skip');
  });

  it('a missing config/mcp.ts is every default when mcp_provider is registered, not "off"', () => {
    const fakeApp = (config: unknown, hubBound: boolean) =>
      ({
        config: { get: (_key: string, fallback: unknown) => config ?? fallback },
        container: { hasBinding: (key: string) => hubBound && key === DEV_TOOLS_BINDING },
      }) as never;
    expect(mcpConfig(fakeApp(undefined, true))).toEqual({});
    expect(mcpConfig(fakeApp(undefined, false))).toBeUndefined();
    expect(mcpConfig(fakeApp({ path: 'api/mcp' }, false))).toEqual({ path: 'api/mcp' });

    // The same resolution the provider mounts with.
    expect(resolveDevTools({})).toMatchObject({ path: 'mcp/agora', actions: 'refuse' });
    expect(resolveDevTools(undefined)).toMatchObject({ path: 'mcp/agora' });
    expect(resolveDevTools({ devTools: { path: '/dev/mcp/' } })?.path).toBe('dev/mcp');
    expect(resolveDevTools({ devTools: false })).toBeNull();

    const missing = mcpConfig(fakeApp(undefined, true));
    expect(checkDevToolsGate(missing, ['resilience'], true).status).toBe('warn');
    const csrf = checkMcpCsrf(missing, { csrf: { enabled: true } });
    expect(csrf.message).toContain('/mcp/agora');
    expect(checkDevToolsGate(undefined, ['resilience'], true)).toMatchObject({
      status: 'skip',
      message: expect.stringContaining('mcp_provider is not registered'),
    });
  });

  it('tenancy-store: organizations on with a store that cannot scope is an error', () => {
    expect(checkTenancyStore({}, false, {}).status).toBe('skip');
    expect(checkTenancyStore({}, true, {}).status).toBe('error');
    expect(
      checkTenancyStore({}, true, new InMemoryAgentStore() as unknown as Record<string, unknown>)
        .status,
    ).toBe('ok');
  });

  it('dev-tools-authkit-mcp: warns when the hub is on with authkit but authkit mcp is off', () => {
    const off = checkDevToolsAuthkitMcp({}, { installed: true, mcp: false });
    expect(off).toMatchObject({ status: 'warn', fix: 'Set `mcp: true` in config/authkit.ts.' });
    expect(off.message).toContain("MCP clients can't register");
    expect(off.message).toContain('/mcp/agora');
    expect(checkDevToolsAuthkitMcp({}, { installed: true, mcp: true }).status).toBe('ok');
    expect(checkDevToolsAuthkitMcp({}, { installed: false }).status).toBe('skip');
    expect(checkDevToolsAuthkitMcp({}, { installed: true, unresolved: 'boom' }).status).toBe(
      'skip',
    );
    expect(
      checkDevToolsAuthkitMcp({ devTools: false }, { installed: true, mcp: false }).status,
    ).toBe('skip');
    expect(checkDevToolsAuthkitMcp(undefined, { installed: true, mcp: false }).status).toBe('skip');
  });

  it('reads authkit mcp from a config provider, a resolved config or a plain object', async () => {
    const appWith = (authkit: unknown) =>
      ({ config: { get: (_key: string, fallback: unknown) => authkit ?? fallback } }) as never;
    const provider = (config: unknown) => ({ type: 'provider', resolver: async () => config });
    expect(await readAuthkitMcpOption(appWith(undefined))).toEqual({ installed: false });
    expect(await readAuthkitMcpOption(appWith(provider({ mcp: { enabled: true } })))).toEqual({
      installed: true,
      mcp: true,
    });
    expect(await readAuthkitMcpOption(appWith(provider({ mcp: { enabled: false } })))).toEqual({
      installed: true,
      mcp: false,
    });
    expect(await readAuthkitMcpOption(appWith({ mcp: true }))).toEqual({
      installed: true,
      mcp: true,
    });
    expect(await readAuthkitMcpOption(appWith({ issuer: 'x' }))).toEqual({
      installed: true,
      mcp: false,
    });
    const failing = {
      type: 'provider',
      resolver: async () => {
        throw new Error('no db');
      },
    };
    expect(await readAuthkitMcpOption(appWith(failing))).toEqual({
      installed: true,
      unresolved: 'no db',
    });
  });

  it('ids are unique, prefixed agent., and the --no-boot entry exports them', () => {
    const ids = agoraDoctorChecks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('agent.'))).toBe(true);
    expect(ids).toEqual([
      'agent.console-gate',
      'agent.actor-resolver',
      'agent.mcp-open',
      'agent.mcp-execute',
      'agent.mcp-csrf',
      'agent.dev-tools-gate',
      'agent.dev-tools-authkit-mcp',
      'agent.tenancy-store',
    ]);
  });
});

describe('agent_provider registers its checks into agora.doctor', () => {
  it('runs them through the shared runner after boot', { timeout: 60_000 }, async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/agent_provider.js')] },
        config: {
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => ({ id: 'u' }) },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    const checks = await readDoctorChecks(app.container);
    expect(checks.filter((check) => check.lib === 'agent')).toHaveLength(8);
    const { report } = await runAgoraDoctor(app, checks, { only: 'agent.console-gate' });
    expect(report.results).toEqual([
      expect.objectContaining({ id: 'agent.console-gate', status: 'warn' }),
    ]);
    await app.terminate();
  });
});

describe('mcp_provider without config/mcp.ts', () => {
  it('mounts /mcp/agora and the doctor reports the dev tools as on', {
    timeout: 60_000,
  }, async () => {
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
          agent: {
            model: new FakeModelProvider(() => ({ text: 'hi' })),
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => ({ id: 'u' }) },
          },
        },
      })
      .create(new URL('../', import.meta.url));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    const router = await app.container.make('router');
    router.commit();
    const patterns = Object.values(router.toJSON())
      .flat()
      .map((route) => route.pattern);
    expect(patterns).toContain('/mcp/agora');

    const checks = await readDoctorChecks(app.container);
    const { report } = await runAgoraDoctor(app, checks, { only: 'agent.mcp-csrf' });
    expect(report.results).toEqual([
      expect.objectContaining({ id: 'agent.mcp-csrf', status: 'ok' }),
    ]);
    const gate = await runAgoraDoctor(app, checks, { only: 'agent.dev-tools-gate' });
    expect(gate.report.results[0]?.message).not.toContain('off');
    await app.terminate();
  });
});

describe('the commands barrel', () => {
  it('lists agora:doctor and agent:doctor', async () => {
    const barrel = await import('../commands/main.js');
    const names = (await barrel.getMetaData()).map((command) => command.commandName);
    expect(names).toEqual(['agora:doctor', 'agent:doctor']);
  });
});
