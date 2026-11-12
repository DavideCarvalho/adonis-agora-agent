import type { ConfirmTokenClaim, ConfirmTokenStore } from '../spi/confirm-token-store.js';
import { validateSchema } from './db-schema.js';
import type { LucidDatabaseLike } from './lucid.js';
import {
  type AgentTableKey,
  agentTables,
  agentTablesSql,
  ensureAgentTables,
} from './lucid-schema.js';
import { dialectOf } from './sql-dialect.js';

/** Options for {@link LucidConfirmTokenStore}. */
export interface LucidConfirmTokenStoreOptions {
  /**
   * Provision the shared agent tables on first use. Default `true` (the ecosystem convention). Set
   * `false` to run the migration.
   */
  autoCreateTables?: boolean;
  /**
   * The database schema (a Postgres schema, a MySQL database) the agent tables live in — the same
   * one the agent store writes to. Default: none (the connection's current schema). Refused on SQLite.
   */
  schema?: string | undefined;
}

/** How many rows a raw write touched, whatever the driver wraps it in. */
function insertedRows(result: unknown): number {
  // mysql2: `[ResultSetHeader, fields]`. Everything else here answers `RETURNING` with rows.
  const head = Array.isArray(result) ? result[0] : result;
  const affected = (head as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected === 'number') return affected;
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * A production {@link ConfirmTokenStore} backed by AdonisJS **Lucid** over the `agent_confirm_token`
 * table — what makes a confirmed write single use across replicas. Like
 * {@link import('./lucid.js').LucidAgentStore} it touches only the structural {@link LucidDatabaseLike}
 * slice, so `@adonisjs/lucid` stays an optional peer.
 *
 * `claim` is one `INSERT` that skips on a duplicate hash, so the primary key is the lock: of two
 * concurrent confirmations one inserts and the other touches no row. It is a statement that does not
 * FAIL on the duplicate (`ON CONFLICT DO NOTHING`; `INSERT IGNORE` on MySQL) rather than an insert
 * whose unique violation is caught, because on Postgres a failed statement aborts the transaction it
 * ran in.
 *
 * Only the token's SHA-256, the actor and the tool name are stored. `expires_at` is epoch-ms, like the
 * rest of the schema; call {@link purgeExpired} from a scheduled job to drop the dead rows.
 */
export class LucidConfirmTokenStore implements ConfirmTokenStore {
  private readonly autoCreateTables: boolean;
  private readonly schema: string | undefined;
  /** The agent tables as the query builder names them (`schema.table` under a schema). */
  private readonly tables: Record<AgentTableKey, string>;
  /** The agent tables as raw SQL names them (`"schema"."table"` under a schema). */
  private readonly tablesSql: Record<AgentTableKey, string>;

  constructor(
    private readonly db: LucidDatabaseLike,
    options: LucidConfirmTokenStoreOptions = {},
  ) {
    this.autoCreateTables = options.autoCreateTables ?? true;
    this.schema = validateSchema(db, options.schema, 'LucidConfirmTokenStore');
    this.tables = agentTables(this.schema);
    this.tablesSql = agentTablesSql(this.schema);
  }

  /** Provision the shared schema on first use (no-op when disabled), memoized across the stores. */
  private ready(): Promise<void> {
    return this.autoCreateTables
      ? ensureAgentTables(this.db, { schema: this.schema })
      : Promise.resolve();
  }

  /** Provision the shared schema now. Idempotent. */
  ensureSchema(): Promise<void> {
    return this.ready();
  }

  async claim(input: ConfirmTokenClaim): Promise<boolean> {
    await this.ready();
    const table = this.tablesSql.confirmTokens;
    const bindings = [input.hash, input.actorRef, input.tool, input.expiresAt, Date.now()];
    const sql = /mysql|maria/i.test(dialectOf(this.db))
      ? `INSERT IGNORE INTO ${table.replaceAll('"', '`')} (hash, actor_ref, tool, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
      : `INSERT INTO ${table} ("hash", "actor_ref", "tool", "expires_at", "created_at") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("hash") DO NOTHING RETURNING "hash"`;
    return insertedRows(await this.db.rawQuery(sql, bindings)) === 1;
  }

  async release(hash: string): Promise<void> {
    await this.ready();
    await this.db.from(this.tables.confirmTokens).where('hash', hash).delete();
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    await this.ready();
    const expired = await this.db
      .from(this.tables.confirmTokens)
      .where('expires_at', '<', now)
      .select('hash');
    if (expired.length === 0) return 0;
    await this.db.from(this.tables.confirmTokens).where('expires_at', '<', now).delete();
    return expired.length;
  }
}
