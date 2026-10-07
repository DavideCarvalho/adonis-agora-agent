import { createHash } from 'node:crypto';
import type { LucidRawRunner } from '../stores/lucid.js';
import { AGENT_TABLES, ensureChannelStateTable, rowsOf } from '../stores/lucid-schema.js';
import { isMySql, portableSql } from '../stores/sql-dialect.js';

/**
 * Text channels' short-lived state, every entry with a TTL: the provider message ids already taken
 * (so a webhook delivered twice starts one turn), a question waiting for the person's answer, an
 * outcome already relayed.
 *
 * {@link InMemoryChannelStore} only sees its own process. With several replicas a retry, an answer
 * or a settled proposal can land on another one, so use a shared store there:
 * {@link lucidChannelStore} (the default when the agent's own store is Lucid),
 * {@link redisChannelStore}, or your own.
 */
export interface ChannelStore {
  /**
   * Take `key` for `ttlMs` — atomically. `true` when it was free (now taken), `false` when someone
   * already took it.
   */
  claim(key: string, ttlMs: number): boolean | Promise<boolean>;
  /** The live value under `key`, or `null`. */
  get(key: string): string | null | Promise<string | null>;
  /** Store `value` under `key` for `ttlMs`, replacing what was there. */
  set(key: string, value: string, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Process-local {@link ChannelStore}: a single replica, tests, development. */
export class InMemoryChannelStore implements ChannelStore {
  readonly #entries = new Map<string, { value: string | null; expiresAt: number }>();

  /** @param maxEntries Past this many live keys, the oldest are forgotten first. */
  constructor(private readonly maxEntries = 50_000) {}

  #live(key: string) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > Date.now()) return entry;
    this.#entries.delete(key);
    return undefined;
  }

  #put(key: string, value: string | null, ttlMs: number) {
    const now = Date.now();
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + ttlMs });
    if (this.#entries.size <= this.maxEntries) return;
    // Insertion order is write order: the first keys are the oldest.
    for (const [stored, entry] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && entry.expiresAt > now) break;
      this.#entries.delete(stored);
    }
  }

  claim(key: string, ttlMs: number): boolean {
    if (this.#live(key) !== undefined) return false;
    this.#put(key, null, ttlMs);
    return true;
  }

  get(key: string): string | null {
    return this.#live(key)?.value ?? null;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.#put(key, value, ttlMs);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

/**
 * The slice of a Redis client {@link redisChannelStore} uses — an `@adonisjs/redis` connection
 * (ioredis) has it: `redisChannelStore(redis)` or `redisChannelStore(redis.connection('main'))`.
 */
export interface ChannelStoreRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** A {@link ChannelStore} shared by every replica, over Redis (`SET … PX … NX` for claims). */
export function redisChannelStore(
  redis: ChannelStoreRedis,
  options: { prefix?: string } = {},
): ChannelStore {
  const prefix = options.prefix ?? 'agora:channel:';
  const ttl = (ms: number) => Math.max(1, Math.round(ms));
  return {
    async claim(key, ttlMs) {
      return (await redis.set(`${prefix}${key}`, '', 'PX', ttl(ttlMs), 'NX')) === 'OK';
    },
    get: (key) => redis.get(`${prefix}${key}`),
    async set(key, value, ttlMs) {
      await redis.set(`${prefix}${key}`, value, 'PX', ttl(ttlMs));
    },
    async delete(key) {
      await redis.del(`${prefix}${key}`);
    },
  };
}

export interface LucidChannelStoreOptions {
  /** A named connection of the `Database` manager. Default: the one `db` is. */
  connection?: string;
  /** Default `agent_channel_state`. */
  table?: string;
  /**
   * Create the table (and its index) on first use. Default `true`; `false` when a migration owns it
   * (`createAgentTables` and the published migration create it under the default name).
   */
  autoCreateTables?: boolean;
  /** How often a claim also deletes expired rows. Default 10 minutes. */
  purgeEveryMs?: number;
}

/** A Lucid `Database` (or one of its connections): raw SQL, and named connections when it has them. */
export type LucidChannelStoreDatabase = LucidRawRunner & {
  connection?(name?: string): LucidRawRunner;
};

/** Keys longer than the column are stored by their hash. */
const storedKey = (key: string) =>
  key.length <= 255 ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`;

/** How many rows a raw write touched, whatever the driver wraps it in. */
function affected(result: unknown): number {
  // mysql2: `[ResultSetHeader, fields]`. Everything else here answers `RETURNING` with rows.
  const head = Array.isArray(result) ? result[0] : result;
  const count = (head as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof count === 'number') return count;
  return rowsOf(result).length;
}

/**
 * A {@link ChannelStore} in the app's SQL database through Lucid — shared by every replica, no Redis
 * needed. One row per key in `agent_channel_state`; a claim is one `INSERT` that skips on a duplicate
 * key (`ON CONFLICT DO NOTHING`, `INSERT IGNORE` on MySQL), so the primary key is the lock. Expired
 * rows are deleted as claims come in (`purgeEveryMs`), and an expired key can be taken again.
 *
 * ```ts
 * import db from '@adonisjs/lucid/services/db'
 * channels.handle(adapter, { …, store: lucidChannelStore(db) })
 * ```
 */
export function lucidChannelStore(
  database: LucidChannelStoreDatabase,
  options: LucidChannelStoreOptions = {},
): ChannelStore {
  const db: LucidRawRunner =
    options.connection !== undefined && typeof database.connection === 'function'
      ? database.connection(options.connection)
      : database;
  const table = options.table ?? AGENT_TABLES.channelState;
  const purgeEveryMs = options.purgeEveryMs ?? 10 * 60 * 1000;
  const mysql = isMySql(db);
  const sql = (statement: string) => portableSql(db, statement);
  let ready: Promise<void> | undefined;
  let lastPurge = 0;
  const init = () => {
    if (options.autoCreateTables === false) return Promise.resolve();
    ready ??= ensureChannelStateTable(db, table).catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  const purge = async (now: number) => {
    if (now - lastPurge < purgeEveryMs) return;
    lastPurge = now;
    await db.rawQuery(sql(`DELETE FROM "${table}" WHERE "expires_at" <= ?`), [now]);
  };

  return {
    async claim(key, ttlMs) {
      await init();
      const now = Date.now();
      await purge(now);
      const id = storedKey(key);
      // An expired claim is free again.
      await db.rawQuery(sql(`DELETE FROM "${table}" WHERE "key" = ? AND "expires_at" <= ?`), [
        id,
        now,
      ]);
      const bindings = [id, now + ttlMs, now];
      const insert = mysql
        ? sql(
            `INSERT IGNORE INTO "${table}" ("key", "value", "expires_at", "created_at") VALUES (?, NULL, ?, ?)`,
          )
        : `INSERT INTO "${table}" ("key", "value", "expires_at", "created_at") VALUES (?, NULL, ?, ?) ON CONFLICT ("key") DO NOTHING RETURNING "key"`;
      return affected(await db.rawQuery(insert, bindings)) === 1;
    },

    async get(key) {
      await init();
      const rows = rowsOf(
        await db.rawQuery(
          sql(`SELECT "value" FROM "${table}" WHERE "key" = ? AND "expires_at" > ?`),
          [storedKey(key), Date.now()],
        ),
      );
      const value = rows[0]?.value;
      return typeof value === 'string' ? value : null;
    },

    async set(key, value, ttlMs) {
      await init();
      const now = Date.now();
      const bindings = [storedKey(key), value, now + ttlMs, now];
      await db.rawQuery(
        mysql
          ? sql(
              `INSERT INTO "${table}" ("key", "value", "expires_at", "created_at") VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE "value" = VALUES("value"), "expires_at" = VALUES("expires_at")`,
            )
          : `INSERT INTO "${table}" ("key", "value", "expires_at", "created_at") VALUES (?, ?, ?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value", "expires_at" = excluded."expires_at"`,
        bindings,
      );
    },

    async delete(key) {
      await init();
      await db.rawQuery(sql(`DELETE FROM "${table}" WHERE "key" = ?`), [storedKey(key)]);
    },
  };
}
