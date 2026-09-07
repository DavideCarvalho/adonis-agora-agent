import { afterEach, describe, expect, it } from 'vitest';
import {
  AGORA_CONTEXT_ACCESSOR,
  readContextAccessor,
  tenantIdFromContext,
  userRefFromContext,
} from '../src/authz/agora-context.js';

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR];
});

describe('readContextAccessor', () => {
  it('returns undefined when the slot is absent', () => {
    expect(readContextAccessor()).toBeUndefined();
  });

  it('returns undefined when the slot is not an object', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = 'nope';
    expect(readContextAccessor()).toBeUndefined();
  });

  it('returns the accessor object when present', () => {
    const accessor = { userRef: () => ({ type: 'user', id: 'u-1' }), tenantId: () => 't-1' };
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = accessor;
    expect(readContextAccessor()).toBe(accessor);
  });
});

// `@adonis-agora/context`'s real accessor (packages/core/src/accessor.ts) publishes `userRef`
// and `tenantId` as METHODS — calling them returns the value, or `undefined` outside an active
// context. These tests pin that contract so a future regression back to plain-value fields (the
// bug this file used to have) fails loudly here instead of as a production 401.
describe('userRefFromContext', () => {
  it('returns undefined when the accessor slot is absent', () => {
    expect(userRefFromContext()).toBeUndefined();
  });

  it('calls the userRef() method and returns its value', () => {
    const ref = { type: 'user', id: 'u-1' };
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = { userRef: () => ref };
    expect(userRefFromContext()).toBe(ref);
  });

  it('returns undefined when userRef is not a function (malformed/legacy accessor)', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = {
      userRef: { type: 'user', id: 'u-1' },
    };
    expect(userRefFromContext()).toBeUndefined();
  });

  it('degrades to undefined when userRef() throws', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = {
      userRef: () => {
        throw new Error('no active context store');
      },
    };
    expect(userRefFromContext()).toBeUndefined();
  });

  it('accepts an already-read accessor to avoid re-reading the global slot', () => {
    const ref = { type: 'user', id: 'u-2' };
    expect(userRefFromContext({ userRef: () => ref })).toBe(ref);
  });
});

describe('tenantIdFromContext', () => {
  it('returns undefined when the accessor slot is absent', () => {
    expect(tenantIdFromContext()).toBeUndefined();
  });

  it('calls the tenantId() method and returns its value', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = { tenantId: () => 't-1' };
    expect(tenantIdFromContext()).toBe('t-1');
  });

  it('returns undefined when tenantId is not a function (malformed/legacy accessor)', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = { tenantId: 't-1' };
    expect(tenantIdFromContext()).toBeUndefined();
  });

  it('degrades to undefined when tenantId() throws', () => {
    (globalThis as Record<symbol, unknown>)[AGORA_CONTEXT_ACCESSOR] = {
      tenantId: () => {
        throw new Error('no active context store');
      },
    };
    expect(tenantIdFromContext()).toBeUndefined();
  });
});
