import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type AuthKitActorInfo,
  anyOf,
  apiKeyAuth,
  authKitAuth,
  type McpAuth,
  McpAuthError,
  resolveMcpAuth,
} from '../src/mcp/auth.js';

interface FakeToken {
  accountId: string;
  clientId?: string;
  grantId?: string;
  scope?: string;
  exp?: number;
  extra?: Record<string, unknown>;
  isExpired: boolean;
}

/** A fake `'authkit.server'` binding: access tokens and grants keyed by id. */
function fakeAuthKit(options: {
  tokens?: Record<string, FakeToken>;
  grants?: Record<string, Record<string, unknown>>;
  withoutGrantModel?: boolean;
}) {
  const grantFind = vi.fn(async (id: string) => options.grants?.[id]);
  const service = {
    config: { issuer: 'https://app.example.com/oidc' },
    provider: {
      AccessToken: { find: async (token: string) => options.tokens?.[token] },
      ...(options.withoutGrantModel ? {} : { Grant: { find: grantFind } }),
    },
  };
  const app = {
    container: { make: async (binding: string) => (binding === 'authkit.server' ? service : null) },
  } as unknown as ApplicationService;
  return { app, grantFind };
}

const validToken: FakeToken = {
  accountId: 'acc-1',
  clientId: 'claude',
  grantId: 'grant-1',
  scope: 'openid profile',
  exp: 2_000_000_000,
  extra: { tier: 'pro' },
  isExpired: false,
};

describe('authKitAuth() → toActor', () => {
  it('hands toActor the grant, its bound org, and the token extra claims', async () => {
    const { app } = fakeAuthKit({
      tokens: { t1: validToken },
      grants: {
        'grant-1': {
          accountId: 'acc-1',
          clientId: 'claude',
          activeOrg: { orgId: 'org-9', orgSlug: 'acme', orgRole: 'owner' },
        },
      },
    });
    const seen: AuthKitActorInfo[] = [];
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: (info) => {
          seen.push(info);
          return { id: info.accountId, tenantRef: info.activeOrg?.orgId ?? 'none' };
        },
      }),
      { app },
    );

    const result = await auth.verify('t1');

    expect(result.extra.actor).toEqual({ id: 'acc-1', tenantRef: 'org-9' });
    expect(result.clientId).toBe('claude');
    expect(result.scopes).toEqual(['openid', 'profile']);
    expect(seen[0]).toMatchObject({
      accountId: 'acc-1',
      scopes: ['openid', 'profile'],
      clientId: 'claude',
      grantId: 'grant-1',
      activeOrg: { orgId: 'org-9', orgSlug: 'acme', orgRole: 'owner' },
      extra: { tier: 'pro' },
    });
    expect(seen[0]?.grant).toMatchObject({ accountId: 'acc-1', clientId: 'claude' });
  });

  it('keeps the old three-field resolver working', async () => {
    const { app } = fakeAuthKit({ tokens: { t1: validToken }, grants: { 'grant-1': {} } });
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: ({
          accountId,
          scopes,
          clientId,
        }: {
          accountId: string;
          scopes: string[];
          clientId: string | undefined;
        }) => ({
          id: `${accountId}:${clientId}:${scopes.length}`,
        }),
      }),
      { app },
    );
    expect((await auth.verify('t1')).extra.actor).toEqual({ id: 'acc-1:claude:2' });
  });

  it('reports no org when the grant carries none (or a malformed one)', async () => {
    const { app } = fakeAuthKit({
      tokens: { t1: validToken, t2: { ...validToken, grantId: 'grant-2' } },
      grants: { 'grant-1': {}, 'grant-2': { activeOrg: { orgSlug: 'no-id' } } },
    });
    const orgs: unknown[] = [];
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: ({ accountId, activeOrg }) => {
          orgs.push(activeOrg);
          return { id: accountId };
        },
      }),
      { app },
    );
    await auth.verify('t1');
    await auth.verify('t2');
    expect(orgs).toEqual([undefined, undefined]);
  });

  it('refuses a token whose grant was revoked', async () => {
    const { app } = fakeAuthKit({ tokens: { t1: validToken }, grants: {} });
    const toActor = vi.fn(({ accountId }: AuthKitActorInfo) => ({ id: accountId }));
    const auth = await resolveMcpAuth(authKitAuth({ toActor }), { app });

    const error = await auth.verify('t1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpAuthError);
    expect((error as McpAuthError).message).toBe('authorization revoked');
    expect(toActor).not.toHaveBeenCalled();
  });

  it('skips the grant lookup when the provider has no Grant model or the token no grantId', async () => {
    const noModel = fakeAuthKit({ tokens: { t1: validToken }, withoutGrantModel: true });
    const auth1 = await resolveMcpAuth(authKitAuth(), { app: noModel.app });
    expect((await auth1.verify('t1')).extra.actor).toEqual({ id: 'acc-1' });

    const { grantId: _grantId, ...withoutGrantId } = validToken;
    const noGrantId = fakeAuthKit({ tokens: { t1: withoutGrantId } });
    const auth2 = await resolveMcpAuth(authKitAuth(), { app: noGrantId.app });
    expect((await auth2.verify('t1')).extra.actor).toEqual({ id: 'acc-1' });
    expect(noGrantId.grantFind).not.toHaveBeenCalled();
  });

  it('lets toActor refuse a client with a typed McpAuthError', async () => {
    const { app } = fakeAuthKit({
      tokens: { web: { ...validToken, clientId: 'web-session' } },
      grants: { 'grant-1': {} },
    });
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: ({ accountId, clientId }) => {
          if (clientId === 'web-session') throw new McpAuthError('token was not issued for MCP');
          return { id: accountId };
        },
      }),
      { app },
    );
    await expect(auth.verify('web')).rejects.toThrow(McpAuthError);
    await expect(auth.verify('web')).rejects.toThrow('token was not issued for MCP');
  });

  it('an unknown token is a plain Error; an expired one is a typed refusal', async () => {
    const { app } = fakeAuthKit({ tokens: { old: { ...validToken, isExpired: true } } });
    const auth = await resolveMcpAuth(authKitAuth(), { app });

    const unknown = await auth.verify('nope').catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(McpAuthError);

    await expect(auth.verify('old')).rejects.toBeInstanceOf(McpAuthError);
  });
});

describe('McpAuthError', () => {
  it('defaults to 401 and carries an explicit 403', () => {
    expect(new McpAuthError('no').status).toBe(401);
    expect(new McpAuthError('no', { status: 403 }).status).toBe(403);
    expect(new McpAuthError('no').name).toBe('McpAuthError');
  });
});

describe('anyOf()', () => {
  const app = {} as ApplicationService;
  const pat = (): McpAuth => ({
    async verify(token) {
      if (!token.startsWith('pat_')) throw new Error('not a PAT');
      return { token, clientId: 'pat', scopes: [], extra: { actor: { id: 'machine' } } };
    },
  });

  it('accepts a token any strategy verifies, in order', async () => {
    const auth = await resolveMcpAuth(anyOf(pat(), apiKeyAuth({ apiKeys: ['k1'] })), { app });
    expect((await auth.verify('pat_1')).extra.actor).toEqual({ id: 'machine' });
    expect((await auth.verify('k1')).extra.actor).toEqual({ id: 'k1' });
  });

  it('rethrows the last error when no strategy recognizes the token', async () => {
    const auth = await resolveMcpAuth(anyOf(pat(), apiKeyAuth({ apiKeys: ['k1'] })), { app });
    await expect(auth.verify('other')).rejects.toThrow('invalid API key');
  });

  it('stops at a typed refusal instead of trying the next strategy', async () => {
    const refusing: McpAuth = {
      async verify() {
        throw new McpAuthError('client not allowed', { status: 403 });
      },
    };
    const next = { verify: vi.fn(pat().verify) };
    const auth = await resolveMcpAuth(anyOf(refusing, next), { app });
    const error = await auth.verify('pat_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpAuthError);
    expect((error as McpAuthError).status).toBe(403);
    expect(next.verify).not.toHaveBeenCalled();
  });

  it('advertises the OAuth metadata of the first strategy that exposes it', async () => {
    const { app: authkitApp } = fakeAuthKit({
      tokens: { t1: validToken },
      grants: { 'grant-1': {} },
    });
    const auth = await resolveMcpAuth(anyOf(pat(), authKitAuth({ resourceName: 'Acme' })), {
      app: authkitApp,
    });
    expect(auth.oauth).toBeTypeOf('function');
    const meta = typeof auth.oauth === 'function' ? await auth.oauth() : auth.oauth;
    expect(meta).toMatchObject({ issuer: 'https://app.example.com/oidc', resourceName: 'Acme' });
    expect((await auth.verify('t1')).extra.actor).toEqual({ id: 'acc-1' });
  });

  it('exposes no OAuth metadata when no strategy does', async () => {
    const auth = await resolveMcpAuth(anyOf(pat()), { app });
    expect(auth.oauth).toBeUndefined();
  });

  it('refuses to be built empty', () => {
    expect(() => anyOf()).toThrow(/at least one/);
  });
});
