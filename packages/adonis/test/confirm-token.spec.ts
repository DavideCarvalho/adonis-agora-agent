import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  confirmTokenExpiry,
  hashConfirmToken,
  InMemoryConfirmTokenStore,
  signConfirmToken,
  verifyConfirmToken,
} from '../src/index.js';

const SECRET = 'a-secret-only-the-server-knows';
const NOW = 1_800_000_000_000;
const SUBJECT = {
  tool: 'refund_order',
  actorId: 'u1',
  tenantRef: 'acme',
  args: { orderId: 'o-1', amount: 10 },
};

describe('canonicalJson', () => {
  it('sorts keys at every depth, so key order never changes the text', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('keeps array order, which is meaning and not formatting', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('drops undefined properties and writes a bare undefined as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('serializes what JSON.stringify would (toJSON)', () => {
    const date = new Date(NOW);
    expect(canonicalJson({ at: date })).toBe(`{"at":${JSON.stringify(date.toISOString())}}`);
  });
});

describe('confirm tokens', () => {
  const token = signConfirmToken(SUBJECT, { secret: SECRET, expiresAt: NOW + 60_000 });
  const verify = (subject: typeof SUBJECT, now = NOW, given: string | undefined = token) =>
    verifyConfirmToken(given, subject, { secret: SECRET, now });

  it('verifies for the subject it was issued to, whatever the key order', () => {
    expect(verify(SUBJECT)).toBe(true);
    expect(verify({ ...SUBJECT, args: { amount: 10, orderId: 'o-1' } })).toBe(true);
    expect(confirmTokenExpiry(token)).toBe(NOW + 60_000);
  });

  it('refuses a changed argument, actor, tenant or tool', () => {
    expect(verify({ ...SUBJECT, args: { orderId: 'o-1', amount: 11 } })).toBe(false);
    expect(verify({ ...SUBJECT, actorId: 'u2' })).toBe(false);
    expect(verify({ ...SUBJECT, tenantRef: 'globex' })).toBe(false);
    expect(verify({ ...SUBJECT, tool: 'delete_order' })).toBe(false);
  });

  it('signs an absent tenant and an empty one alike, and both apart from a real one', () => {
    const { tenantRef: _tenant, ...noTenant } = SUBJECT;
    const bare = signConfirmToken(noTenant, { secret: SECRET, expiresAt: NOW + 60_000 });
    expect(
      verifyConfirmToken(bare, { ...SUBJECT, tenantRef: '' }, { secret: SECRET, now: NOW }),
    ).toBe(true);
    expect(verifyConfirmToken(bare, SUBJECT, { secret: SECRET, now: NOW })).toBe(false);
  });

  it('refuses a token whose expiry was pushed forward', () => {
    const signature = token.slice(token.indexOf('.') + 1);
    expect(verify(SUBJECT, NOW, `${NOW + 3_600_000}.${signature}`)).toBe(false);
  });

  it('refuses an expired token, and one signed with another secret', () => {
    expect(verify(SUBJECT, NOW + 60_001)).toBe(false);
    expect(verifyConfirmToken(token, SUBJECT, { secret: 'another', now: NOW })).toBe(false);
  });

  it('refuses a malformed token without throwing', () => {
    for (const bad of ['', 'nope', '.sig', 'abc.sig', `${NOW + 60_000}`, `${NOW + 60_000}.`]) {
      expect(verify(SUBJECT, NOW, bad)).toBe(false);
    }
    expect(verifyConfirmToken(undefined, SUBJECT, { secret: SECRET, now: NOW })).toBe(false);
    expect(verifyConfirmToken(null, SUBJECT, { secret: SECRET, now: NOW })).toBe(false);
  });

  it('never signs with an empty secret', () => {
    expect(() => signConfirmToken(SUBJECT, { secret: '', expiresAt: NOW })).toThrow(/secret/);
  });

  it('hashes to a fixed-size digest that does not contain the token', () => {
    expect(hashConfirmToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConfirmToken(token)).toBe(hashConfirmToken(token));
  });
});

describe('InMemoryConfirmTokenStore', () => {
  const claim = (hash: string, expiresAt = Date.now() + 60_000) => ({
    hash,
    actorRef: 'u1',
    tool: 'refund_order',
    expiresAt,
  });

  it('gives a hash to the first claim only, until it is released', async () => {
    const store = new InMemoryConfirmTokenStore();
    expect(await store.claim(claim('h1'))).toBe(true);
    expect(await store.claim(claim('h1'))).toBe(false);
    expect(await store.claim(claim('h2'))).toBe(true);
    await store.release('h1');
    expect(await store.claim(claim('h1'))).toBe(true);
  });

  it('forgets expired marks lazily, on the next claim', async () => {
    const store = new InMemoryConfirmTokenStore();
    await store.claim(claim('old', Date.now() - 1));
    expect(store.size).toBe(1);
    await store.claim(claim('new'));
    expect(store.size).toBe(1);
    expect(await store.purgeExpired(Date.now() + 120_000)).toBe(1);
    expect(store.size).toBe(0);
  });
});
