import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  aud?: string | string[];
  clientId?: string;
  grantId?: string;
  scope?: string;
  exp?: number;
  extra?: Record<string, unknown>;
  gty?: string;
  isExpired: boolean;
}

/** A fake `'authkit.server'` binding: access tokens and grants keyed by id. */
function fakeAuthKit(options: {
  tokens?: Record<string, FakeToken>;
  grants?: Record<string, Record<string, unknown>>;
  withoutGrantModel?: boolean;
  /** The issuer's public JWKS (`jwks_uri`), for the JWT access tokens in another process. */
  publicJwks?: { keys: Record<string, unknown>[] };
}) {
  const grantFind = vi.fn(async (id: string) => options.grants?.[id]);
  const service = {
    config: { issuer: 'https://app.example.com/oidc' },
    provider: {
      AccessToken: { find: async (token: string) => options.tokens?.[token] },
      ...(options.withoutGrantModel ? {} : { Grant: { find: grantFind } }),
    },
    ...(options.publicJwks ? { publicJwks: options.publicJwks } : {}),
  };
  const app = {
    container: { make: async (binding: string) => (binding === 'authkit.server' ? service : null) },
  } as unknown as ApplicationService;
  return { app, grantFind };
}

/**
 * A key pair + the public JWKS a `authkit.server` would expose, and a signer for the JWT access
 * tokens (RFC 9068) authkit mints for a resource in another process.
 */
async function jwtIssuer() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return {
    publicJwks: { keys: [jwk] },
    sign: async (claims: Record<string, unknown> = {}) => {
      const { iss, typ, sub, aud, exp, withoutExp } = claims;
      const jwt = new SignJWT({
        scope: 'openid profile',
        client_id: 'claude',
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: (typ as string) ?? 'at+jwt' })
        .setIssuer((iss as string) ?? 'https://app.example.com/oidc')
        .setSubject((sub as string) ?? 'acc-1')
        .setAudience((aud as string) ?? 'https://app.example.com/mcp')
        .setIssuedAt();
      if (!withoutExp) jwt.setExpirationTime((exp as number) ?? '5m');
      return jwt.sign(privateKey);
    },
  };
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

describe('authKitAuth() → a personal agent (Poppy) token', () => {
  const poppyToken: FakeToken = {
    accountId: 'acc-1',
    clientId: 'https://agent.example/agent.json',
    grantId: 'pgrant_1',
    scope: 'orders:read',
    gty: 'poppy',
    isExpired: false,
  };

  it('puts the actor behind the personal agent gate: personal_agent + one scope: role per scope', async () => {
    const { app } = fakeAuthKit({ tokens: { p1: poppyToken }, grants: { pgrant_1: {} } });
    const seen: AuthKitActorInfo[] = [];
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: (info) => {
          seen.push(info);
          return { id: `profile-of-${info.accountId}`, roles: ['account:acc-1'] };
        },
      }),
      { app },
    );
    const actor = (await auth.verify('p1')).extra.actor;
    expect(seen[0]?.personalAgent).toBe(true);
    expect(actor.id).toBe('profile-of-acc-1');
    expect(actor.roles).toEqual(['account:acc-1', 'personal_agent', 'scope:orders:read']);
  });

  it('leaves an MCP client login alone', async () => {
    const { app } = fakeAuthKit({ tokens: { t1: validToken }, grants: { 'grant-1': {} } });
    const seen: AuthKitActorInfo[] = [];
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: (info) => {
          seen.push(info);
          return { id: info.accountId };
        },
      }),
      { app },
    );
    expect((await auth.verify('t1')).extra.actor).toEqual({ id: 'acc-1' });
    expect(seen[0]?.personalAgent).toBe(false);
  });
});

describe('authKitAuth() → a JWT access token (RFC 9068)', () => {
  it('accepts the JWT authkit minted for this endpoint and never touches the adapter', async () => {
    const issuer = await jwtIssuer();
    const { app, grantFind } = fakeAuthKit({ tokens: {}, publicJwks: issuer.publicJwks });
    const token = await issuer.sign({ scope: 'openid profile email' });
    const seen: AuthKitActorInfo[] = [];
    const auth = await resolveMcpAuth(
      authKitAuth({
        toActor: (info) => {
          seen.push(info);
          return { id: info.accountId };
        },
      }),
      { app },
    );

    const result = await auth.verify(token, { resource: 'https://app.example.com/mcp' });
    expect(result.extra.actor).toEqual({ id: 'acc-1' });
    expect(result.clientId).toBe('claude');
    expect(result.scopes).toEqual(['openid', 'profile', 'email']);
    expect(seen[0]).toMatchObject({ accountId: 'acc-1', personalAgent: false });
    // A JWT is self-contained: no grant lookup (and no grant to revoke).
    expect(grantFind).not.toHaveBeenCalled();
  });

  it('refuses a JWT for another resource, and one with a bad signature', async () => {
    const issuer = await jwtIssuer();
    const { app } = fakeAuthKit({ tokens: {}, publicJwks: issuer.publicJwks });
    const auth = await resolveMcpAuth(authKitAuth(), { app });

    const otherResource = await issuer.sign({ aud: 'https://other.example.com/mcp' });
    await expect(
      auth.verify(otherResource, { resource: 'https://app.example.com/mcp' }),
    ).rejects.toThrow('token was not issued for this MCP server');

    // This issuer's token with a tampered signature: a refusal, not "somebody else's token".
    const forged = `${await issuer.sign({})}x`;
    await expect(
      auth.verify(forged, { resource: 'https://app.example.com/mcp' }),
    ).rejects.toBeInstanceOf(McpAuthError);
  });

  it('refuses a JWT without exp or expired, the same way an opaque token is refused', async () => {
    const issuer = await jwtIssuer();
    const { app } = fakeAuthKit({ tokens: {}, publicJwks: issuer.publicJwks });
    const auth = await resolveMcpAuth(authKitAuth(), { app });

    // RFC 9068 requires `exp`, and a token without one would be immortal.
    const noExp = await issuer.sign({ withoutExp: true });
    await expect(
      auth.verify(noExp, { resource: 'https://app.example.com/mcp' }),
    ).rejects.toBeInstanceOf(McpAuthError);

    const expired = await issuer.sign({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(
      auth.verify(expired, { resource: 'https://app.example.com/mcp' }),
    ).rejects.toBeInstanceOf(McpAuthError);
  });

  it('a JWT of another issuer, or a non-JWT, stays a plain Error', async () => {
    const issuer = await jwtIssuer();
    const { app } = fakeAuthKit({ tokens: {}, publicJwks: issuer.publicJwks });
    const auth = await resolveMcpAuth(authKitAuth(), { app });

    const foreign = await issuer.sign({ iss: 'https://other.example.com/oidc' });
    const foreignErr = await auth
      .verify(foreign, { resource: 'https://app.example.com/mcp' })
      .catch((e: unknown) => e);
    expect(foreignErr).not.toBeInstanceOf(McpAuthError);

    const opaque = await auth
      .verify('opaque-token', { resource: 'https://app.example.com/mcp' })
      .catch((e: unknown) => e);
    expect(opaque).not.toBeInstanceOf(McpAuthError);
  });

  it('ignores the JWT path when the issuer exposes no JWKS', async () => {
    const issuer = await jwtIssuer();
    const { app } = fakeAuthKit({ tokens: {} });
    const auth = await resolveMcpAuth(authKitAuth(), { app });
    const token = await issuer.sign({});
    await expect(auth.verify(token)).rejects.toThrow('invalid or expired access token');
  });
});

describe('authKitAuth() → a token this issuer does not know', () => {
  it('stays a plain Error (anyOf tries the next strategy)', async () => {
    const { app } = fakeAuthKit({ tokens: {} });
    const auth = await resolveMcpAuth(authKitAuth(), { app });
    const err = await auth
      .verify('nope', { resource: 'https://app.example.com/mcp' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(McpAuthError);
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

describe('authKitAuth() → audience (the token must be for THIS server)', () => {
  const resource = 'https://app.example.com/mcp';
  const tokens = {
    mine: { ...validToken, aud: resource },
    slash: { ...validToken, aud: `${resource}/` },
    other: { ...validToken, aud: 'https://app.example.com/other-mcp' },
    web: { ...validToken },
  };

  it('accepts a token issued for this resource, trailing slash tolerated', async () => {
    const { app } = fakeAuthKit({ tokens, grants: { 'grant-1': {} } });
    const auth = await resolveMcpAuth(authKitAuth(), { app });
    await expect(auth.verify('mine', { resource })).resolves.toMatchObject({ token: 'mine' });
    await expect(auth.verify('slash', { resource })).resolves.toMatchObject({ token: 'slash' });
  });

  it('refuses a token for another resource, or with no audience at all', async () => {
    const { app } = fakeAuthKit({ tokens, grants: { 'grant-1': {} } });
    const auth = await resolveMcpAuth(authKitAuth(), { app });
    for (const token of ['other', 'web']) {
      const refusal = await auth.verify(token, { resource }).catch((error) => error);
      expect(refusal).toBeInstanceOf(McpAuthError);
      expect(refusal.message).toBe('token was not issued for this MCP server');
    }
  });

  it("audience: 'any' skips the check; so does a caller that names no resource", async () => {
    const { app } = fakeAuthKit({ tokens, grants: { 'grant-1': {} } });
    const any = await resolveMcpAuth(authKitAuth({ audience: 'any' }), { app });
    await expect(any.verify('web', { resource })).resolves.toMatchObject({ token: 'web' });
    const strict = await resolveMcpAuth(authKitAuth(), { app });
    await expect(strict.verify('web')).resolves.toMatchObject({ token: 'web' });
  });

  it('anyOf() hands the resource on to each strategy', async () => {
    const seen: unknown[] = [];
    const auth = await resolveMcpAuth(
      anyOf({
        async verify(token, context) {
          seen.push(context);
          return { token, clientId: '', scopes: [], extra: { actor: { id: 'u' } } };
        },
      }),
      { app: {} as ApplicationService },
    );
    await auth.verify('t', { resource });
    expect(seen).toEqual([{ resource }]);
  });
});
