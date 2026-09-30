import { createHash, randomBytes } from 'node:crypto';
import type { ActorResolver } from './spi/actor-resolver.js';
import type { Actor } from './types.js';

/** Options for {@link AnonymousActorResolver}. All optional. */
export interface AnonymousActorOptions {
  /** Cookie name. Default `agent_anon`. */
  cookieName?: string;
  /** Cookie lifetime in days. Default 365. */
  maxAgeDays?: number;
  /** `SameSite`. Default `lax`; `none` (a cross-site client) forces `Secure`. */
  sameSite?: 'lax' | 'strict' | 'none';
  /** `Secure`. Default `'auto'` — set when the request came over HTTPS. */
  secure?: boolean | 'auto';
  /** Cookie path. Default `/`. */
  path?: string;
  /** Roles every anonymous actor holds. Default `['anonymous']`. */
  roles?: string[];
}

/** The minted cookie value: 32 random bytes, base64url (43 characters). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What this resolver reads off an Adonis `HttpContext` — structural, so it stays framework-light. */
interface ContextLike {
  request?: {
    header?(name: string): string | undefined;
    secure?(): boolean;
  };
  response?: {
    append?(key: string, value: string): unknown;
  };
}

/** One minted token per request, however many times a request resolves its actor. */
const minted = new WeakMap<object, string>();

function readCookie(ctx: ContextLike, name: string): string | undefined {
  const raw = ctx.request?.header?.('cookie');
  if (raw === undefined) return undefined;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The default identity when `config/agent.ts` sets no `actorResolver`: the endpoints are PUBLIC and
 * every browser is its own anonymous actor, so visitors never share threads, quota or attachments.
 *
 * On the first request without it, the response sets `agent_anon=<32 random bytes, base64url>;
 * Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` (plus `Secure` over HTTPS), and the actor id is
 * `anon:` + a SHA-256 digest of the token — the contract of `@dudousxd/nestjs-agent`'s resolver of
 * the same name. The cookie is `HttpOnly` (page scripts cannot read it), server-minted, and needs no
 * secret: the digest is stable across pods and restarts. A client needs no code for it.
 *
 * Require login instead with `actorResolver: new AuthActorResolver()` (reads `ctx.auth.user`).
 */
export class AnonymousActorResolver implements ActorResolver {
  private readonly cookieName: string;
  private readonly roles: string[];

  constructor(private readonly options: AnonymousActorOptions = {}) {
    this.cookieName = options.cookieName ?? 'agent_anon';
    this.roles = options.roles ?? ['anonymous'];
  }

  resolve(context: unknown): Actor {
    const ctx = (typeof context === 'object' && context !== null ? context : {}) as ContextLike;
    let token = minted.get(ctx) ?? readCookie(ctx, this.cookieName);
    if (token === undefined || !TOKEN_PATTERN.test(token)) {
      token = randomBytes(32).toString('base64url');
      minted.set(ctx, token);
      this.setCookie(ctx, token);
    }
    const digest = createHash('sha256').update(token).digest('base64url').slice(0, 32);
    return { id: `anon:${digest}`, roles: [...this.roles] };
  }

  private setCookie(ctx: ContextLike, token: string): void {
    const sameSite = this.options.sameSite ?? 'lax';
    const secureOption = this.options.secure ?? 'auto';
    const secure =
      sameSite === 'none' ||
      (secureOption === 'auto' ? ctx.request?.secure?.() === true : secureOption);
    const maxAge = Math.round((this.options.maxAgeDays ?? 365) * 24 * 60 * 60);
    const cookie = [
      `${this.cookieName}=${token}`,
      `Path=${this.options.path ?? '/'}`,
      `Max-Age=${maxAge}`,
      'HttpOnly',
      `SameSite=${sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax'}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
    // Plain (unsigned) on purpose: the value is already unguessable, and the NestJS contract is the
    // raw token. `append` keeps any other `Set-Cookie` the app's own middleware wrote.
    ctx.response?.append?.('Set-Cookie', cookie);
  }
}
