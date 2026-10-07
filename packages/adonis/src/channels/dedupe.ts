/**
 * Remembers which provider message ids were already taken, so a webhook the provider delivers twice
 * (a retry, a duplicate) starts one turn. Keys expire after a TTL.
 *
 * The default, {@link InMemoryChannelDedupe}, only sees its own process: with several app replicas
 * behind a load balancer two deliveries can land on different ones. Use a shared store there —
 * {@link redisChannelDedupe} over `@adonisjs/redis`, or your own.
 */
export interface ChannelDedupeStore {
  /**
   * Take `key` for `ttlMs` — atomically. `true` when it was free (now taken: handle the message),
   * `false` when someone already took it (a duplicate).
   */
  claim(key: string, ttlMs: number): boolean | Promise<boolean>;
}

/** Process-local {@link ChannelDedupeStore}: a single replica, tests, development. */
export class InMemoryChannelDedupe implements ChannelDedupeStore {
  readonly #expiries = new Map<string, number>();

  /** @param maxEntries Past this many live keys, the oldest are forgotten first. */
  constructor(private readonly maxEntries = 50_000) {}

  claim(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const expiry = this.#expiries.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.#expiries.delete(key);
    this.#expiries.set(key, now + ttlMs);
    if (this.#expiries.size > this.maxEntries) {
      // Insertion order is claim order: the first keys are the oldest.
      for (const [stored, at] of this.#expiries) {
        if (this.#expiries.size <= this.maxEntries && at > now) break;
        this.#expiries.delete(stored);
      }
    }
    return true;
  }
}

/**
 * The slice of a Redis client {@link redisChannelDedupe} uses: `SET key value PX ttl NX`, answering
 * `'OK'` when it set the key and `null` when it existed. An `@adonisjs/redis` connection (ioredis)
 * has this shape: `redisChannelDedupe(redis)` or `redisChannelDedupe(redis.connection('main'))`.
 */
export interface ChannelDedupeRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
}

/** A {@link ChannelDedupeStore} shared by every replica, over Redis's `SET … NX`. */
export function redisChannelDedupe(
  redis: ChannelDedupeRedis,
  options: { prefix?: string } = {},
): ChannelDedupeStore {
  const prefix = options.prefix ?? 'agora:channel:dedupe:';
  return {
    async claim(key, ttlMs) {
      return (await redis.set(`${prefix}${key}`, '1', 'PX', Math.max(1, ttlMs), 'NX')) === 'OK';
    },
  };
}
