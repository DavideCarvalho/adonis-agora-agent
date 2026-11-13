// @vitest-environment node
import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { AGORA_CONSOLES_BINDING, registerAgoraConsole } from '../src/console-switcher.js';
import {
  consoleShellIdentity,
  csrfTokenOf,
  resolveSignOut,
  resolveViewer,
  viewerFromUser,
} from '../src/dashboard/console_shell.js';
import { resolveDashboardConfig } from '../src/dashboard/define_config.js';
import { CONFIG_ELEMENT_ID, injectApiBase } from '../src/dashboard/paths.js';
import { consoleShellConfig, registerAgentConsole } from '../src/dashboard/switcher.js';

function ctx(extra: { user?: unknown; csrfToken?: unknown; throwOnUser?: boolean } = {}) {
  const auth = extra.throwOnUser
    ? {
        get user(): unknown {
          throw new Error('not authenticated');
        },
      }
    : 'user' in extra
      ? { user: extra.user }
      : undefined;
  return {
    ...(auth ? { auth } : {}),
    request: { csrfToken: extra.csrfToken, header: () => undefined },
  } as unknown as HttpContext;
}

function fakeApp() {
  const values = new Map<string, unknown>();
  return {
    inProduction: false,
    values,
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => values.set(key, value),
      make: async (key: string) => values.get(key),
    },
  };
}

describe('viewerFromUser', () => {
  it('prefers fullName, then name, then email for the label; first role wins', () => {
    expect(
      viewerFromUser({ fullName: 'Ann Lee', email: 'ann@x.test', roles: ['admin', 'ops'] }),
    ).toEqual({ label: 'Ann Lee', email: 'ann@x.test', role: 'admin' });
    expect(viewerFromUser({ name: 'Bo', roles: [{ name: 'support' }] })).toEqual({
      label: 'Bo',
      role: 'support',
    });
    expect(viewerFromUser({ email: 'c@x.test', role: 'viewer' })).toEqual({
      label: 'c@x.test',
      email: 'c@x.test',
      role: 'viewer',
    });
  });

  it('is undefined for nothing usable', () => {
    expect(viewerFromUser(undefined)).toBeUndefined();
    expect(viewerFromUser({ id: 1 })).toBeUndefined();
    expect(viewerFromUser({ name: '  ' })).toBeUndefined();
  });
});

describe('resolveViewer', () => {
  it('reads ctx.auth.user structurally when no hook is configured', async () => {
    expect(await resolveViewer(ctx({ user: { email: 'a@x.test' } }), null)).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
    expect(await resolveViewer(ctx(), null)).toBeUndefined();
    expect(await resolveViewer(ctx({ user: null }), null)).toBeUndefined();
    expect(await resolveViewer(ctx({ throwOnUser: true }), null)).toBeUndefined();
  });

  it('uses the hook when configured, cleaning its answer; a throw means no viewer', async () => {
    const c = ctx({ user: { email: 'ignored@x.test' } });
    expect(await resolveViewer(c, async () => ({ label: ' Ops ', role: 'admin' }))).toEqual({
      label: 'Ops',
      role: 'admin',
    });
    expect(await resolveViewer(c, () => null)).toBeUndefined();
    expect(await resolveViewer(c, () => ({ label: '' }))).toBeUndefined();
    expect(
      await resolveViewer(c, () => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
  });
});

describe('resolveSignOut', () => {
  const registry = { version: 1, entries: [], account: { signOut: '/account/logout' } };

  it('uses the configured option first, with the CSRF token on a POST action', () => {
    expect(resolveSignOut(ctx({ csrfToken: 'tok' }), '/logout', registry)).toEqual({
      action: '/logout',
      csrfToken: 'tok',
    });
    expect(resolveSignOut(ctx(), { href: '/bye' }, registry)).toEqual({ href: '/bye' });
    expect(resolveSignOut(ctx(), false, registry)).toBeUndefined();
  });

  it('falls back to the sign-out an account console announced on the registry', () => {
    expect(resolveSignOut(ctx({ csrfToken: 'tok' }), null, registry)).toEqual({
      action: '/account/logout',
      csrfToken: 'tok',
    });
    expect(
      resolveSignOut(ctx(), null, {
        version: 1,
        entries: [],
        account: { signOut: { href: '/out' } },
      }),
    ).toEqual({ href: '/out' });
    expect(resolveSignOut(ctx(), null, { version: 1, entries: [] })).toBeUndefined();
    expect(resolveSignOut(ctx(), null, undefined)).toBeUndefined();
  });

  it('never emits anything but a same-origin path', () => {
    expect(resolveSignOut(ctx(), 'https://evil.example/out', undefined)).toBeUndefined();
    expect(resolveSignOut(ctx(), { href: '//evil.example' }, undefined)).toBeUndefined();
    expect(resolveSignOut(ctx(), '/\\evil', undefined)).toBeUndefined();
    expect(
      resolveSignOut(ctx(), null, { account: { signOut: 'javascript:alert(1)' } }),
    ).toBeUndefined();
  });

  it('reads the CSRF token only when it is a non-empty string', () => {
    expect(csrfTokenOf(ctx({ csrfToken: 'x' }))).toBe('x');
    expect(csrfTokenOf(ctx({ csrfToken: '' }))).toBeUndefined();
    expect(csrfTokenOf(ctx({ csrfToken: 3 }))).toBeUndefined();
  });
});

describe('consoleShellIdentity', () => {
  it('combines viewer and signOut, leaving out what is unknown', async () => {
    expect(await consoleShellIdentity(ctx(), {}, null)).toEqual({});
    expect(
      await consoleShellIdentity(
        ctx({ user: { name: 'Bo' }, csrfToken: 't' }),
        { signOut: '/logout' },
        null,
      ),
    ).toEqual({ viewer: { label: 'Bo' }, signOut: { action: '/logout', csrfToken: 't' } });
  });
});

describe('resolveDashboardConfig: viewer / signOut', () => {
  it('defaults both to null and keeps what the host set', () => {
    expect(resolveDashboardConfig({}).viewer).toBeNull();
    expect(resolveDashboardConfig({}).signOut).toBeNull();
    const hook = () => null;
    expect(resolveDashboardConfig({ viewer: hook, signOut: false })).toMatchObject({
      viewer: hook,
      signOut: false,
    });
  });
});

describe('consoleShellConfig', () => {
  it('adds switcher, search, viewer and signOut from the registry and the options', async () => {
    const app = fakeApp();
    expect(await consoleShellConfig(app, ctx(), '/agent', {})).toEqual({});

    await registerAgentConsole(app, { mount: '/agent/dashboard' });
    await registerAgoraConsole(app, {
      id: 'authkit',
      title: 'Identity',
      icon: 'identity',
      path: '/admin',
      order: 10,
      authorize: async () => ({ allowed: true }),
    });
    // authkit announces its sign-out on the registry.
    (app.values.get(AGORA_CONSOLES_BINDING) as { account?: unknown }).account = {
      signOut: '/account/logout',
    };

    expect(
      await consoleShellConfig(
        app,
        ctx({ user: { fullName: 'Ann Lee', roles: ['admin'] }, csrfToken: 'tok' }),
        '/agent',
        { viewer: null, signOut: null },
      ),
    ).toEqual({
      switcher: { endpoint: '/agent/governance/consoles', others: 1 },
      search: { endpoint: '/agent/governance/consoles/search' },
      viewer: { label: 'Ann Lee', role: 'admin' },
      signOut: { action: '/account/logout', csrfToken: 'tok' },
    });

    // The host's own options win; `signOut: false` hides it.
    expect(
      await consoleShellConfig(app, ctx({ user: { email: 'x@y.test' } }), '/agent', {
        viewer: () => ({ label: 'Ops' }),
        signOut: false,
      }),
    ).toMatchObject({ viewer: { label: 'Ops' } });
    expect(await consoleShellConfig(app, ctx(), '/agent', { signOut: false })).not.toHaveProperty(
      'signOut',
    );
  });

  it('lands in the data block escaped like the rest', () => {
    const out = injectApiBase('<head></head>', '/agent', {
      viewer: { label: '</script><b>', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 't' },
    });
    expect(out.split('</script>')).toHaveLength(2);
    const json = new RegExp(`id="${CONFIG_ELEMENT_ID}">(.*?)</script>`).exec(out)?.[1] ?? '{}';
    expect(JSON.parse(json)).toEqual({
      apiBase: '/agent',
      viewer: { label: '</script><b>', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 't' },
    });
  });
});
