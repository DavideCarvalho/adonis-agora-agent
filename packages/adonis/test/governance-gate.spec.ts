import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { evaluateGovernanceGate } from '../src/governance-gate.js';
import type { Actor } from '../src/types.js';

// The gate only threads `ctx` through to the `authorize` predicate; it never reads it itself, so a
// bare sentinel object stands in for the HttpContext.
const ctx = { sentinel: true } as unknown as HttpContext;
const admin: Actor = { id: 'u1', roles: ['ADMIN'] };
const member: Actor = { id: 'u2', roles: ['COORDINATOR'] };

describe('evaluateGovernanceGate', () => {
  it('is open (ok) when no authorize is configured', async () => {
    const verdict = await evaluateGovernanceGate(member, ctx, undefined);
    expect(verdict).toEqual({ ok: true, status: 200 });
  });

  it('allows when authorize returns true', async () => {
    const verdict = await evaluateGovernanceGate(
      admin,
      ctx,
      (a) => a.roles?.includes('ADMIN') ?? false,
    );
    expect(verdict.ok).toBe(true);
  });

  it('denies with 403 when authorize returns false', async () => {
    const verdict = await evaluateGovernanceGate(
      member,
      ctx,
      (a) => a.roles?.includes('ADMIN') ?? false,
    );
    expect(verdict).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });

  it('awaits an async authorize predicate', async () => {
    const verdict = await evaluateGovernanceGate(member, ctx, async () => false);
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(403);
  });

  it('passes the actor and ctx through to authorize', async () => {
    let seenActor: Actor | undefined;
    let seenCtx: unknown;
    await evaluateGovernanceGate(admin, ctx, (a, c) => {
      seenActor = a;
      seenCtx = c;
      return true;
    });
    expect(seenActor).toBe(admin);
    expect(seenCtx).toBe(ctx);
  });

  it('fails closed (403) when authorize throws, generic message by default', async () => {
    const verdict = await evaluateGovernanceGate(member, ctx, () => {
      throw new Error('boom');
    });
    expect(verdict).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });

  it('surfaces the thrown message only when debug is true', async () => {
    const verdict = await evaluateGovernanceGate(
      member,
      ctx,
      () => {
        throw new Error('boom');
      },
      true,
    );
    expect(verdict).toEqual({ ok: false, status: 403, error: 'boom' });
  });

  it('fails closed (403) with a generic error when authorize throws a non-Error', async () => {
    const verdict = await evaluateGovernanceGate(member, ctx, () => {
      throw 'nope';
    });
    expect(verdict).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });
});
