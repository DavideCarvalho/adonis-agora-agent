import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { actorFromAuthInfo, isActor, isMcpAuthInfo } from '../src/mcp/actor.js';
import type { McpAuth, McpAuthInfo } from '../src/mcp/auth.js';
import type { Actor } from '../src/types.js';

const baseAuthInfo = { token: 't', clientId: 'c', scopes: [] };

describe('isActor', () => {
  it('accepts a minimal actor with only an id', () => {
    expect(isActor({ id: 'u1' })).toBe(true);
  });

  it('accepts an actor with a roles array and tenant', () => {
    expect(isActor({ id: 'u1', roles: ['ADMIN', 'USER'], tenantRef: 'acme' })).toBe(true);
  });

  it('rejects non-object values', () => {
    for (const value of [null, undefined, 'u1', 42, true, ['u1']]) {
      expect(isActor(value)).toBe(false);
    }
  });

  it('rejects a missing or non-string id', () => {
    expect(isActor({})).toBe(false);
    expect(isActor({ id: 42 })).toBe(false);
  });

  it('rejects a non-array roles field', () => {
    expect(isActor({ id: 'u1', roles: 'ADMIN' })).toBe(false);
  });

  it('rejects a roles array containing non-strings', () => {
    expect(isActor({ id: 'u1', roles: ['ADMIN', 42] })).toBe(false);
  });

  it('rejects a non-string tenantRef', () => {
    expect(isActor({ id: 'u1', tenantRef: 42 })).toBe(false);
  });
});

describe('actorFromAuthInfo', () => {
  it('reads the typed actor from extra', () => {
    const authInfo: McpAuthInfo = { ...baseAuthInfo, extra: { actor: { id: 'u1' } } };
    expect(actorFromAuthInfo(authInfo)).toEqual({ id: 'u1' });
  });

  it('throws when authInfo is absent', () => {
    expect(() => actorFromAuthInfo(undefined)).toThrow(/no actor/);
  });

  it('throws when extra.actor is missing or malformed', () => {
    expect(() => actorFromAuthInfo(baseAuthInfo)).toThrow(/no actor/);
    expect(() => actorFromAuthInfo({ ...baseAuthInfo, extra: {} })).toThrow(/no actor/);
    expect(() => actorFromAuthInfo({ ...baseAuthInfo, extra: { actor: { id: 42 } } })).toThrow(
      /no actor/,
    );
  });
});

describe('isMcpAuthInfo', () => {
  it('narrows the SDK AuthInfo a handler receives, so extra.actor is an Actor without a cast', () => {
    const fromSdk: AuthInfo | undefined = {
      ...baseAuthInfo,
      extra: { actor: { id: 'u1', roles: ['ADMIN'] } },
    };
    expectTypeOf(fromSdk?.extra?.actor).toEqualTypeOf<unknown>();
    if (!isMcpAuthInfo(fromSdk)) throw new Error('expected an actor');
    expectTypeOf(fromSdk.extra.actor).toEqualTypeOf<Actor>();
    expect(fromSdk.extra.actor.roles).toEqual(['ADMIN']);
  });

  it('is false, not a throw, when there is no well-formed actor', () => {
    expect(isMcpAuthInfo(undefined)).toBe(false);
    expect(isMcpAuthInfo(baseAuthInfo)).toBe(false);
    expect(isMcpAuthInfo({ ...baseAuthInfo, extra: { actor: { id: 42 } } })).toBe(false);
  });
});

describe('McpAuthInfo', () => {
  it('lets a strategy of your own carry more in extra, and is still an SDK AuthInfo', async () => {
    const custom: McpAuth = {
      async verify(token) {
        return {
          token,
          clientId: 'c',
          scopes: [],
          extra: { actor: { id: 'u1' }, sessionId: 's1' },
        };
      },
    };
    const authInfo = await custom.verify('t');
    expectTypeOf(authInfo.extra.actor).toEqualTypeOf<Actor>();
    expectTypeOf(authInfo).toExtend<AuthInfo>();
    expect(authInfo.extra.sessionId).toBe('s1');
    expect(actorFromAuthInfo(authInfo)).toEqual({ id: 'u1' });
  });
});
