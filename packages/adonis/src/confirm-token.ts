import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfirmTokenClaim, ConfirmTokenStore } from './spi/confirm-token-store.js';

/** How long a preview stays confirmable unless the tool says otherwise. */
export const DEFAULT_CONFIRM_TTL_MS = 15 * 60 * 1000;

/** What a confirm token is bound to. Change any of it and the token stops matching. */
export interface ConfirmTokenSubject {
  /** The tool's name. */
  tool: string;
  /** `ctx.actor.id`. */
  actorId: string;
  /** `ctx.actor.tenantRef`; absent and `''` sign the same. */
  tenantRef?: string;
  /** The call's arguments, WITHOUT `confirm` / `confirmToken`. */
  args: unknown;
}

/**
 * JSON with object keys sorted at every depth, so two argument objects that differ only in key
 * order produce the same text. `undefined` properties are dropped (as `JSON.stringify` does); a
 * bare `undefined` and an `undefined` array element are `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON(): unknown }).toJSON());
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** The signed text is itself canonical JSON, so no field can bleed into its neighbour. */
function signature(subject: ConfirmTokenSubject, expiresAt: number, secret: string): string {
  if (secret === '') {
    throw new Error('confirm token: the secret is empty');
  }
  return createHmac('sha256', secret)
    .update(
      canonicalJson([
        'agent-confirm',
        subject.tool,
        subject.actorId,
        subject.tenantRef ?? '',
        expiresAt,
        subject.args,
      ]),
    )
    .digest('base64url');
}

/**
 * Issue a confirm token: `<expiresAt>.<signature>`, an HMAC-SHA256 (keyed by `secret`) over the tool,
 * the actor, the tenant, the expiry and the canonical arguments. Stateless — nothing is stored — and
 * useless for another actor, tenant, tool or argument, or after `expiresAt` (epoch-ms).
 */
export function signConfirmToken(
  subject: ConfirmTokenSubject,
  options: { secret: string; expiresAt: number },
): string {
  return `${options.expiresAt}.${signature(subject, options.expiresAt, options.secret)}`;
}

/** The expiry (epoch-ms) a token carries, or `undefined` for a malformed one. Not a verification. */
export function confirmTokenExpiry(token: string): number | undefined {
  const separator = token.indexOf('.');
  if (separator <= 0) return undefined;
  const expiresAt = Number(token.slice(0, separator));
  return Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
}

/** Was this token issued for exactly this subject, with this secret, and is it still valid at `now`? */
export function verifyConfirmToken(
  token: string | null | undefined,
  subject: ConfirmTokenSubject,
  options: { secret: string; now?: number },
): boolean {
  if (typeof token !== 'string') return false;
  const expiresAt = confirmTokenExpiry(token);
  if (expiresAt === undefined || expiresAt < (options.now ?? Date.now())) return false;
  const expected = Buffer.from(signature(subject, expiresAt, options.secret));
  const given = Buffer.from(token.slice(token.indexOf('.') + 1));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** SHA-256 (hex) of a token — what a {@link ConfirmTokenStore} keys on, so the token is never stored. */
export function hashConfirmToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A single-process {@link ConfirmTokenStore}: tests, scripts, and a deployment that runs ONE replica.
 * With more than one, a token spent on replica A is still fresh on replica B — use the Lucid store.
 * Expired marks are dropped lazily, on the next claim.
 */
export class InMemoryConfirmTokenStore implements ConfirmTokenStore {
  private readonly claims = new Map<string, ConfirmTokenClaim>();

  async claim(input: ConfirmTokenClaim): Promise<boolean> {
    await this.purgeExpired();
    if (this.claims.has(input.hash)) return false;
    this.claims.set(input.hash, { ...input });
    return true;
  }

  async release(hash: string): Promise<void> {
    this.claims.delete(hash);
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    let purged = 0;
    for (const [hash, claim] of this.claims) {
      if (claim.expiresAt < now) {
        this.claims.delete(hash);
        purged += 1;
      }
    }
    return purged;
  }

  /** How many tokens are currently marked as spent. */
  get size(): number {
    return this.claims.size;
  }
}
