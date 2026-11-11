import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import {
  authorizeByToken,
  evaluateDashboardGate,
  resolveDashboardConfig,
} from '../src/dashboard/index.js';
import type { ActorResolver } from '../src/spi/actor-resolver.js';

/**
 * `evaluateDashboardGate` is the ONE access check of the agent console: the SPA shell and the
 * `/agent/governance/*` routes it reads both run it with `dashboard.authorize`.
 */

const ctx = {} as HttpContext;
const resolverFor = (actor: { id: string; roles?: string[] }): ActorResolver => ({
  resolve: async () => actor,
});
const rejecting: ActorResolver = {
  resolve: async () => {
    throw new Error('no session');
  },
};
const admin = { id: 'u1', roles: ['ADMIN'] };
const coordinator = { id: 'u2', roles: ['COORDINATOR'] };
const isAdmin = (_ctx: HttpContext, actor?: { roles?: string[] }) =>
  actor?.roles?.includes('ADMIN') ?? false;

describe('evaluateDashboardGate — authorize omitted', () => {
  it('is open outside production, with or without an actor', async () => {
    expect(await evaluateDashboardGate(ctx, { inProduction: false })).toEqual({ ok: true });
    expect(await evaluateDashboardGate(ctx, { actorResolver: rejecting })).toEqual({ ok: true });
  });

  it('denies every request with 403 in production', async () => {
    expect(
      await evaluateDashboardGate(ctx, {
        actorResolver: resolverFor(admin),
        inProduction: true,
      }),
    ).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });
});

describe('evaluateDashboardGate — authorize set', () => {
  it('allows when authorize returns true, and hands back the resolved actor', async () => {
    expect(
      await evaluateDashboardGate(ctx, { actorResolver: resolverFor(admin), authorize: isAdmin }),
    ).toEqual({ ok: true, actor: admin });
  });

  it('denies with 403 when authorize returns false', async () => {
    expect(
      await evaluateDashboardGate(ctx, {
        actorResolver: resolverFor(coordinator),
        authorize: isAdmin,
        inProduction: true,
      }),
    ).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });

  it('passes ctx first and the resolved actor second', async () => {
    const seen: unknown[] = [];
    await evaluateDashboardGate(ctx, {
      actorResolver: resolverFor(admin),
      authorize: (c, actor) => {
        seen.push(c, actor);
        return true;
      },
    });
    expect(seen).toEqual([ctx, admin]);
  });

  it('runs authorize with no actor when the resolver rejects (a ctx-only hook still decides)', async () => {
    const seen: unknown[] = [];
    const verdict = await evaluateDashboardGate(ctx, {
      actorResolver: rejecting,
      authorize: (c, actor) => {
        seen.push(c, actor);
        return { allowed: false, reason: 'unauthenticated' };
      },
    });
    expect(seen).toEqual([ctx, undefined]);
    expect(verdict).toEqual({ ok: false, status: 401, error: 'unauthenticated' });
  });

  it('lets authorizeByToken in without any actor resolver', async () => {
    const authorize = authorizeByToken({ token: 't0k' });
    const withHeader = (value: string | undefined) =>
      ({
        request: { header: (name: string) => (name === 'authorization' ? value : undefined) },
      }) as unknown as HttpContext;
    expect(
      await evaluateDashboardGate(withHeader('Bearer t0k'), { authorize, inProduction: true }),
    ).toEqual({ ok: true });
    expect(
      await evaluateDashboardGate(withHeader(undefined), { authorize, inProduction: true }),
    ).toEqual({ ok: false, status: 401, error: 'unauthenticated' });
  });

  it('denies with 403 when authorize throws; the message is a detail outside production only', async () => {
    const authorize = () => {
      throw new Error('policy blew up');
    };
    expect(
      await evaluateDashboardGate(ctx, {
        actorResolver: resolverFor(admin),
        authorize,
        inProduction: true,
      }),
    ).toEqual({ ok: false, status: 403, error: 'forbidden' });
    expect(
      await evaluateDashboardGate(ctx, { actorResolver: resolverFor(admin), authorize }),
    ).toEqual({ ok: false, status: 403, error: 'forbidden', detail: 'policy blew up' });
  });

  it.each([
    [{ allowed: true }, { ok: true, actor: coordinator }],
    [{ allowed: false }, { ok: false, status: 403, error: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { ok: false, status: 403, error: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { ok: false, status: 401, error: 'unauthenticated' },
    ],
    [
      { redirectTo: '/login' },
      { ok: false, status: 401, error: 'unauthenticated', redirectTo: '/login' },
    ],
    [false, { ok: false, status: 403, error: 'forbidden' }],
  ])('%j → %j', async (result, expected) => {
    expect(
      await evaluateDashboardGate(ctx, {
        actorResolver: resolverFor(coordinator),
        authorize: () => result as never,
      }),
    ).toEqual(expected);
  });
});

describe('resolveDashboardConfig — authorize passthrough', () => {
  it('defaults authorize to undefined', () => {
    expect(resolveDashboardConfig({}).authorize).toBeUndefined();
    expect(resolveDashboardConfig(undefined).enabled).toBe(true);
  });

  it('passes an authorize gate through untouched', () => {
    const authorize = () => true;
    expect(resolveDashboardConfig({ authorize }).authorize).toBe(authorize);
  });
});
