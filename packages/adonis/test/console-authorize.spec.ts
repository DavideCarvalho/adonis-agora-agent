import { Container } from '@adonisjs/core/container';
import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentConsoleAuthorize,
  type ConsoleAuthorize,
  type ConsoleAuthorizer,
  consoleAuthorizeFor,
  isPageNavigation,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../src/console-authorize.js';
import type { Actor } from '../src/types.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

function makeCtx(accept?: string): HttpContext {
  const container = new Container();
  return {
    containerResolver: container.createResolver(),
    request: { header: (name: string) => (name === 'accept' ? accept : undefined) },
  } as unknown as HttpContext;
}

class AuditService {
  calls: string[] = [];
  record(entry: string) {
    this.calls.push(entry);
  }
}

describe('normalizeConsoleAuthorizeResult', () => {
  it.each([
    [true, { allowed: true }],
    [{ allowed: true }, { allowed: true }],
    [false, { allowed: false, status: 403 }],
    [{ allowed: false }, { allowed: false, status: 403 }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, status: 403 },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, status: 401 },
    ],
    [{ redirectTo: '/login' }, { allowed: false, status: 401, redirectTo: '/login' }],
    [undefined, { allowed: false, status: 403 }],
    ['yes', { allowed: false, status: 403 }],
    [{}, { allowed: false, status: 403 }],
  ])('%j → %j', (result, expected) => {
    expect(normalizeConsoleAuthorizeResult(result)).toEqual(expected);
  });
});

describe('resolveConsoleAuthorize — inline function', () => {
  it('passes ctx first and the resolved actor second', async () => {
    const ctx = makeCtx();
    const hook = vi.fn((_ctx: HttpContext, _actor: Actor) => true);
    expect(await resolveConsoleAuthorize(hook)(ctx, actor)).toEqual({ allowed: true });
    expect(hook).toHaveBeenCalledWith(ctx, actor);
  });

  it('accepts a ctx-only function (the shared ConsoleAuthorize shape)', async () => {
    const shared: ConsoleAuthorize = (ctx) =>
      (ctx as unknown as { auth?: { user?: unknown } }).auth?.user !== undefined;
    const authorize: AgentConsoleAuthorize = shared;
    expect(await resolveConsoleAuthorize(authorize)(makeCtx(), actor)).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it('awaits an async function and normalises every result shape', async () => {
    const authorize = resolveConsoleAuthorize(async () => ({
      allowed: false,
      reason: 'unauthenticated' as const,
    }));
    expect(await authorize(makeCtx(), actor)).toEqual({ allowed: false, status: 401 });
    expect(
      await resolveConsoleAuthorize(() => ({ redirectTo: '/entrar' }))(makeCtx(), actor),
    ).toEqual({ allowed: false, status: 401, redirectTo: '/entrar' });
  });

  it('treats a throw as a 403 denial, never an allow', async () => {
    const error = new Error('boom');
    const decision = await resolveConsoleAuthorize(() => {
      throw error;
    })(makeCtx(), actor);
    expect(decision).toEqual({ allowed: false, status: 403, error });
  });

  it('treats a rejected promise as a 403 denial', async () => {
    const decision = await resolveConsoleAuthorize(async () => {
      throw new Error('nope');
    })(makeCtx(), actor);
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ status: 403 });
  });
});

describe('resolveConsoleAuthorize — class', () => {
  it('builds the class through the container (DI) and calls authorize(ctx, actor)', async () => {
    // An app's `@inject()` class reaches the container the same way: what matters is that the
    // authorizer is built by `ctx.containerResolver.make`, so the container supplies its deps.
    const audit = new AuditService();
    class ConsoleAccess implements ConsoleAuthorizer {
      constructor(private service: AuditService) {}
      authorize(_ctx: HttpContext) {
        this.service.record('checked');
        return { allowed: true } as const;
      }
    }
    const container = new Container();
    container.bind(
      ConsoleAccess,
      async (resolver) => new ConsoleAccess(await resolver.make(AuditService)),
    );
    container.bindValue(AuditService, audit);
    const ctx = {
      containerResolver: container.createResolver(),
    } as unknown as HttpContext;

    expect(await resolveConsoleAuthorize(ConsoleAccess)(ctx, actor)).toEqual({ allowed: true });
    expect(audit.calls).toEqual(['checked']);
  });

  it('hands the resolved actor as the second argument', async () => {
    const seen: unknown[] = [];
    class ActorAware {
      authorize(ctx: HttpContext, who: Actor) {
        seen.push(ctx, who);
        return who.roles?.includes('ADMIN') ?? false;
      }
    }
    const ctx = makeCtx();
    expect(await resolveConsoleAuthorize(ActorAware)(ctx, actor)).toEqual({ allowed: true });
    expect(seen).toEqual([ctx, actor]);
  });

  it('builds a fresh instance per request', async () => {
    let built = 0;
    class Counting {
      constructor() {
        built++;
      }
      authorize() {
        return true;
      }
    }
    const authorize = resolveConsoleAuthorize(Counting);
    await authorize(makeCtx(), actor);
    await authorize(makeCtx(), actor);
    expect(built).toBe(2);
  });

  it('treats a throwing class as a 403 denial', async () => {
    class Throws {
      authorize(): boolean {
        throw new Error('policy blew up');
      }
    }
    expect(await resolveConsoleAuthorize(Throws)(makeCtx(), actor)).toMatchObject({
      allowed: false,
      status: 403,
    });
  });
});

describe('resolveConsoleAuthorize — lazy import', () => {
  it('imports once, then builds the class through the container on every request', async () => {
    const audit = new AuditService();
    class ConsoleAccess {
      constructor(private service: AuditService) {}
      authorize(_ctx: HttpContext, who: Actor) {
        this.service.record(who.id);
        return { allowed: false, reason: 'forbidden' } as const;
      }
    }
    const loader = vi.fn(async () => ({ default: ConsoleAccess }));
    const container = new Container();
    container.bind(
      ConsoleAccess,
      async (resolver) => new ConsoleAccess(await resolver.make(AuditService)),
    );
    container.bindValue(AuditService, audit);
    const ctx = { containerResolver: container.createResolver() } as unknown as HttpContext;

    const authorize = resolveConsoleAuthorize(loader);
    expect(await authorize(ctx, actor)).toEqual({ allowed: false, status: 403 });
    expect(await authorize(ctx, actor)).toEqual({ allowed: false, status: 403 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(audit.calls).toEqual(['u1', 'u1']);
  });

  it('memoises per configured value with consoleAuthorizeFor', async () => {
    class Allow {
      authorize() {
        return true;
      }
    }
    const loader = vi.fn(async () => ({ default: Allow }));
    expect(await consoleAuthorizeFor(loader)(makeCtx(), actor)).toEqual({ allowed: true });
    expect(await consoleAuthorizeFor(loader)(makeCtx(), actor)).toEqual({ allowed: true });
    expect(consoleAuthorizeFor(loader)).toBe(consoleAuthorizeFor(loader));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('treats a failing import as a 403 denial', async () => {
    const decision = await resolveConsoleAuthorize(async () => {
      throw new Error('Cannot find module');
    })(makeCtx(), actor);
    expect(decision).toMatchObject({ allowed: false, status: 403 });
  });

  it('a module whose default is not an authorizer class is a result, not an import (denies)', async () => {
    const authorize = resolveConsoleAuthorize((async () => ({
      default: { not: 'a class' },
    })) as unknown as AgentConsoleAuthorize);
    expect(await authorize(makeCtx(), actor)).toEqual({ allowed: false, status: 403 });
  });
});

describe('isPageNavigation', () => {
  it('is true only when the request accepts HTML', () => {
    expect(isPageNavigation(makeCtx('text/html,application/xhtml+xml'))).toBe(true);
    expect(isPageNavigation(makeCtx('application/json'))).toBe(false);
    expect(isPageNavigation(makeCtx())).toBe(false);
  });
});
