import { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthActorResolver } from '../src/index.js';
import { FakeModelProvider } from '../src/testing/fake-model-provider.js';
import { type BootedApp, bootAgentApp } from './helpers/boot-agent-app.js';

/**
 * `@adonisjs/auth`'s `ctx.auth` as far as the resolver reads it: `user` stays undefined until a
 * check or an authenticate ran, `check()`/`checkUsing()` never throw for an anonymous request.
 */
function fakeAuth(userFor: (guard: string) => unknown) {
  const auth = {
    user: undefined as unknown,
    authenticationAttempted: false,
    check: vi.fn(async () => auth.checkUsing(['web'])),
    checkUsing: vi.fn(async (guards: string[]) => {
      auth.authenticationAttempted = true;
      for (const guard of guards) {
        auth.user = userFor(guard);
        if (auth.user !== undefined) return true;
      }
      return false;
    }),
  };
  return auth;
}

describe('AuthActorResolver', () => {
  it('reads ctx.auth.user and fail-closes when unauthenticated', async () => {
    const resolver = new AuthActorResolver();
    await expect(
      resolver.resolve({ auth: { user: { id: 42, roles: ['ADMIN'] } } }),
    ).resolves.toEqual({ id: '42', roles: ['ADMIN'] });
    await expect(resolver.resolve({ auth: { user: undefined } })).rejects.toThrow(
      /no authenticated user/,
    );
    await expect(resolver.resolve({})).rejects.toThrow(/no authenticated user/);
  });

  it('checks the request itself when no auth middleware ran', async () => {
    const auth = fakeAuth(() => ({ id: 7, roles: ['member'] }));
    await expect(new AuthActorResolver().resolve({ auth })).resolves.toEqual({
      id: '7',
      roles: ['member'],
    });
    expect(auth.check).toHaveBeenCalledTimes(1);
  });

  it('refuses an anonymous request without the check throwing', async () => {
    const auth = fakeAuth(() => undefined);
    await expect(new AuthActorResolver().resolve({ auth })).rejects.toThrow(
      /no authenticated user/,
    );
    expect(auth.check).toHaveBeenCalledTimes(1);
  });

  it('does not check again a request a middleware already checked', async () => {
    const auth = fakeAuth(() => ({ id: 1 }));
    auth.authenticationAttempted = true;
    await expect(new AuthActorResolver().resolve({ auth })).rejects.toThrow(
      /no authenticated user/,
    );
    expect(auth.check).not.toHaveBeenCalled();
  });

  it('tries the guards it is given, in order', async () => {
    const auth = fakeAuth((guard) => (guard === 'api' ? { id: 'token-user' } : undefined));
    const resolver = new AuthActorResolver({ guards: ['web', 'api'] });
    await expect(resolver.resolve({ auth })).resolves.toEqual({ id: 'token-user', roles: [] });
    expect(auth.checkUsing).toHaveBeenCalledWith(['web', 'api']);
    expect(auth.check).not.toHaveBeenCalled();
  });
});

describe('AuthActorResolver on the agent routes', () => {
  let booted: BootedApp | undefined;
  afterEach(async () => {
    await booted?.close();
    booted = undefined;
    Reflect.deleteProperty(HttpContext.prototype, 'auth');
  });

  it('authenticates a request no auth middleware touched (a session or token guard)', async () => {
    booted = await bootAgentApp(
      {
        model: new FakeModelProvider(() => ({ text: 'hi' })),
        actorResolver: new AuthActorResolver(),
      },
      { anonymous: true },
    );
    // What `@adonisjs/auth`'s provider does: a lazy `ctx.auth` per request, nothing checked yet.
    (
      HttpContext as unknown as { getter(name: string, fn: unknown, singleton: boolean): void }
    ).getter(
      'auth',
      function (this: HttpContext) {
        const header = this.request.header('authorization');
        return fakeAuth(() =>
          header === 'Bearer good' ? { id: 'u1', roles: ['ADMIN'] } : undefined,
        );
      },
      true,
    );
    const threads = (authorization?: string) =>
      fetch(`${booted?.url}/agent/threads`, {
        headers: authorization === undefined ? {} : { authorization },
      });
    expect((await threads('Bearer good')).status).toBe(200);
    expect((await threads()).status).toBe(401);
    expect((await threads('Bearer bad')).status).toBe(401);
  });
});
