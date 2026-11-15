import {
  ensureDatabaseSchema,
  qualifiedName,
  qualifiedSql,
  validateSchema,
} from '../stores/db-schema.js';
import type { LucidClientLike, LucidRawRunner } from '../stores/lucid.js';
import { forDialect } from '../stores/lucid-schema.js';
import { isMySql } from '../stores/sql-dialect.js';

/**
 * What one owner (a person/account of this app) holds at one Company: the Company's issuer and
 * domain, the scope granted, and the sealed client state (User ID, keys, refresh token, access
 * tokens). `status`: `pending` while signing in, `active` with an refresh token, `revoked` after a
 * disconnect (either side).
 */
export interface PoppyConnectionRecord {
  owner: string;
  issuer: string;
  domain: string;
  organization: string;
  scope: string;
  status: 'pending' | 'active' | 'revoked';
  /** Sealed `CompanyState` of the poppy-client (see `Sealer`). */
  state: string;
  createdAt: number;
  updatedAt: number;
}

/** A sign-in started by the `connect` tool, completed on this app's connect page. */
export interface PoppyPendingConnect {
  /** Unguessable (128 bits): the connect page's URL is a bearer link. */
  id: string;
  owner: string;
  domain: string;
  issuer: string;
  organization: string;
  scope: string;
  /** The actor the turn ran as, to decide the parked call on completion. */
  actor: { id: string; roles?: string[]; tenantRef?: string } | null;
  threadId: string | null;
  runId: string | null;
  toolCallId: string | null;
  /** Sealed per-method state (PKCE verifier, mediated sign-in id). Never the credentials. */
  flow: string | null;
  status: 'open' | 'connected' | 'failed';
  expiresAt: number;
  createdAt: number;
}

export interface PoppyConnectionStore {
  listConnections(owner: string): Promise<PoppyConnectionRecord[]>;
  getConnection(owner: string, issuer: string): Promise<PoppyConnectionRecord | null>;
  saveConnection(record: PoppyConnectionRecord): Promise<void>;
  deleteConnection(owner: string, issuer: string): Promise<void>;
  createPending(record: PoppyPendingConnect): Promise<void>;
  getPending(id: string): Promise<PoppyPendingConnect | null>;
  updatePending(
    id: string,
    patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>,
  ): Promise<void>;
  /**
   * Every sealed value the store holds (`agent:crypto:reseal`, the `agent.crypto` doctor check).
   * Optional: a custom store without it is reported as not walkable.
   */
  listSealed?(): Promise<PoppySealedValue[]>;
  /** Swap one sealed value if it is still `from`. `false`: it changed meanwhile (left alone). */
  replaceSealed?(ref: PoppySealedRef, from: string, to: string): Promise<boolean>;
}

/** Where a sealed value lives: a connection's `state` or a pending connect's `flow`. */
export type PoppySealedRef =
  | { table: 'connection'; owner: string; issuer: string }
  | { table: 'pending'; id: string };

export interface PoppySealedValue {
  ref: PoppySealedRef;
  value: string;
}

export class InMemoryPoppyConnectionStore implements PoppyConnectionStore {
  readonly #connections = new Map<string, PoppyConnectionRecord>();
  readonly #pending = new Map<string, PoppyPendingConnect>();

  async listConnections(owner: string) {
    return [...this.#connections.values()].filter((c) => c.owner === owner).map((c) => ({ ...c }));
  }
  async getConnection(owner: string, issuer: string) {
    const found = this.#connections.get(`${owner}\n${issuer}`);
    return found ? { ...found } : null;
  }
  async saveConnection(record: PoppyConnectionRecord) {
    this.#connections.set(`${record.owner}\n${record.issuer}`, { ...record });
  }
  async deleteConnection(owner: string, issuer: string) {
    this.#connections.delete(`${owner}\n${issuer}`);
  }
  async createPending(record: PoppyPendingConnect) {
    if (!this.#pending.has(record.id)) this.#pending.set(record.id, structuredClone(record));
  }
  async getPending(id: string) {
    const found = this.#pending.get(id);
    return found ? structuredClone(found) : null;
  }
  async updatePending(id: string, patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>) {
    const found = this.#pending.get(id);
    if (found) Object.assign(found, patch);
  }
  async listSealed(): Promise<PoppySealedValue[]> {
    const out: PoppySealedValue[] = [];
    for (const c of this.#connections.values()) {
      out.push({ ref: { table: 'connection', owner: c.owner, issuer: c.issuer }, value: c.state });
    }
    for (const p of this.#pending.values()) {
      if (p.flow !== null) out.push({ ref: { table: 'pending', id: p.id }, value: p.flow });
    }
    return out;
  }
  async replaceSealed(ref: PoppySealedRef, from: string, to: string): Promise<boolean> {
    if (ref.table === 'connection') {
      const found = this.#connections.get(`${ref.owner}\n${ref.issuer}`);
      if (found?.state !== from) return false;
      found.state = to;
      return true;
    }
    const found = this.#pending.get(ref.id);
    if (found?.flow !== from) return false;
    found.flow = to;
    return true;
  }
}

export const POPPY_CONNECTION_TABLES = {
  connections: 'agent_poppy_connection',
  pending: 'agent_poppy_connect',
} as const;

export function poppyConnectionTableStatements(schema?: string): string[] {
  const t = POPPY_CONNECTION_TABLES;
  return [
    `CREATE TABLE IF NOT EXISTS ${qualifiedSql(t.connections, schema)} (
      "owner" VARCHAR(255) NOT NULL,
      "issuer" VARCHAR(1024) NOT NULL,
      "domain" VARCHAR(255) NOT NULL,
      "organization" VARCHAR(255) NOT NULL,
      "scope" TEXT NOT NULL,
      "status" VARCHAR(16) NOT NULL,
      "state" TEXT NOT NULL,
      "created_at" BIGINT NOT NULL,
      "updated_at" BIGINT NOT NULL,
      PRIMARY KEY ("owner", "issuer")
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualifiedSql(t.pending, schema)} (
      "id" VARCHAR(64) PRIMARY KEY NOT NULL,
      "owner" VARCHAR(255) NOT NULL,
      "domain" VARCHAR(255) NOT NULL,
      "issuer" VARCHAR(1024) NOT NULL,
      "organization" VARCHAR(255) NOT NULL,
      "scope" TEXT NOT NULL,
      "actor" TEXT NULL,
      "thread_id" VARCHAR(255) NULL,
      "run_id" VARCHAR(255) NULL,
      "tool_call_id" VARCHAR(255) NULL,
      "flow" TEXT NULL,
      "status" VARCHAR(16) NOT NULL,
      "expires_at" BIGINT NOT NULL,
      "created_at" BIGINT NOT NULL
    )`,
  ];
}

/**
 * The connection table's primary key on MySQL. `("owner", "issuer")` is 255 + 1024 utf8mb4
 * characters — 5116 bytes, past InnoDB's 3072-byte key limit, so the table could not be created
 * there. MySQL keys on a stored SHA-256 of the issuer instead, computed by the database itself
 * (`issuer_hash`, a generated column the store never writes): 32 bytes, and unique exactly when the
 * issuer's bytes are, as on Postgres and SQLite. Reads still filter on `issuer`. A prefix index would
 * have fit but made two issuers sharing their first characters collide.
 *
 * No install needs repairing: the old statement always failed on MySQL, so no table of that shape
 * was ever created there by this library.
 */
function withMySqlConnectionKey(statement: string): string {
  return statement.replace(
    'PRIMARY KEY ("owner", "issuer")',
    '"issuer_hash" BINARY(32) AS (UNHEX(SHA2("issuer", 256))) STORED,\n      PRIMARY KEY ("owner", "issuer_hash")',
  );
}

/**
 * Create the connection tables if missing. Idempotent. `schema` puts them in that database schema
 * (created when missing); refused on SQLite.
 */
export async function ensurePoppyConnectionTables(
  db: LucidRawRunner,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const schema = validateSchema(db, options.schema, 'config/poppy_connections.ts');
  const mysql = isMySql(db);
  if (schema !== undefined) await ensureDatabaseSchema(db, schema);
  for (const statement of poppyConnectionTableStatements(schema)) {
    await db.rawQuery(forDialect(mysql ? withMySqlConnectionKey(statement) : statement, mysql));
  }
}

const int = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown) => (v == null ? null : String(v));

/** {@link PoppyConnectionStore} over Lucid (SQLite / Postgres / MySQL); tables created on first use. */
export class LucidPoppyConnectionStore implements PoppyConnectionStore {
  #ready: Promise<void> | null = null;
  readonly #autoCreate: boolean;
  readonly #schema: string | undefined;
  /** The tables as the query builder names them (`schema.table` under a `schema`). */
  readonly #tables: Record<keyof typeof POPPY_CONNECTION_TABLES, string>;

  constructor(
    private readonly db: LucidClientLike & LucidRawRunner,
    options: { autoCreateTables?: boolean; schema?: string | undefined } = {},
  ) {
    this.#autoCreate = options.autoCreateTables ?? true;
    this.#schema = validateSchema(db, options.schema, 'config/poppy_connections.ts');
    this.#tables = {
      connections: qualifiedName(POPPY_CONNECTION_TABLES.connections, this.#schema),
      pending: qualifiedName(POPPY_CONNECTION_TABLES.pending, this.#schema),
    };
  }

  ready(): Promise<void> {
    if (!this.#autoCreate) return Promise.resolve();
    if (this.#ready === null) {
      this.#ready = ensurePoppyConnectionTables(this.db, { schema: this.#schema });
      this.#ready.catch(() => {
        this.#ready = null;
      });
    }
    return this.#ready;
  }

  #connection(row: Record<string, unknown>): PoppyConnectionRecord {
    return {
      owner: String(row.owner),
      issuer: String(row.issuer),
      domain: String(row.domain),
      organization: String(row.organization),
      scope: String(row.scope ?? ''),
      status: String(row.status) as PoppyConnectionRecord['status'],
      state: String(row.state),
      createdAt: int(row.created_at),
      updatedAt: int(row.updated_at),
    };
  }

  async listConnections(owner: string) {
    await this.ready();
    const rows = await this.db
      .from(this.#tables.connections)
      .where('owner', owner)
      .orderBy('domain', 'asc')
      .select('*');
    return rows.map((row) => this.#connection(row));
  }

  async getConnection(owner: string, issuer: string) {
    await this.ready();
    const row = await this.db
      .from(this.#tables.connections)
      .where('owner', owner)
      .where('issuer', issuer)
      .first();
    return row ? this.#connection(row) : null;
  }

  async saveConnection(record: PoppyConnectionRecord) {
    await this.ready();
    const columns = {
      domain: record.domain,
      organization: record.organization,
      scope: record.scope,
      status: record.status,
      state: record.state,
      updated_at: record.updatedAt,
    };
    const existing = await this.db
      .from(this.#tables.connections)
      .where('owner', record.owner)
      .where('issuer', record.issuer)
      .first();
    if (existing) {
      await this.db
        .from(this.#tables.connections)
        .where('owner', record.owner)
        .where('issuer', record.issuer)
        .update(columns);
      return;
    }
    await this.db.table(this.#tables.connections).insert({
      owner: record.owner,
      issuer: record.issuer,
      created_at: record.createdAt,
      ...columns,
    });
  }

  async deleteConnection(owner: string, issuer: string) {
    await this.ready();
    await this.db
      .from(this.#tables.connections)
      .where('owner', owner)
      .where('issuer', issuer)
      .delete();
  }

  async createPending(record: PoppyPendingConnect) {
    await this.ready();
    if (await this.getPending(record.id)) return;
    await this.db.table(this.#tables.pending).insert({
      id: record.id,
      owner: record.owner,
      domain: record.domain,
      issuer: record.issuer,
      organization: record.organization,
      scope: record.scope,
      actor: record.actor === null ? null : JSON.stringify(record.actor),
      thread_id: record.threadId,
      run_id: record.runId,
      tool_call_id: record.toolCallId,
      flow: record.flow,
      status: record.status,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    });
  }

  async getPending(id: string) {
    await this.ready();
    const row = await this.db.from(this.#tables.pending).where('id', id).first();
    if (!row) return null;
    return {
      id: String(row.id),
      owner: String(row.owner),
      domain: String(row.domain),
      issuer: String(row.issuer),
      organization: String(row.organization),
      scope: String(row.scope ?? ''),
      actor:
        row.actor == null ? null : (JSON.parse(String(row.actor)) as PoppyPendingConnect['actor']),
      threadId: str(row.thread_id),
      runId: str(row.run_id),
      toolCallId: str(row.tool_call_id),
      flow: str(row.flow),
      status: String(row.status) as PoppyPendingConnect['status'],
      expiresAt: int(row.expires_at),
      createdAt: int(row.created_at),
    };
  }

  async updatePending(id: string, patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>) {
    await this.ready();
    const row: Record<string, unknown> = {};
    if (patch.flow !== undefined) row.flow = patch.flow;
    if (patch.status !== undefined) row.status = patch.status;
    if (Object.keys(row).length === 0) return;
    await this.db.from(this.#tables.pending).where('id', id).update(row);
  }

  async listSealed(): Promise<PoppySealedValue[]> {
    await this.ready();
    const connections = await this.db
      .from(this.#tables.connections)
      .select('owner', 'issuer', 'state');
    const pending = (await this.db.from(this.#tables.pending).select('id', 'flow')).filter(
      (row) => row.flow != null,
    );
    return [
      ...connections.map((row) => ({
        ref: { table: 'connection' as const, owner: String(row.owner), issuer: String(row.issuer) },
        value: String(row.state),
      })),
      ...pending.map((row) => ({
        ref: { table: 'pending' as const, id: String(row.id) },
        value: String(row.flow),
      })),
    ];
  }

  async replaceSealed(ref: PoppySealedRef, from: string, to: string): Promise<boolean> {
    await this.ready();
    const affected =
      ref.table === 'connection'
        ? await this.db
            .from(this.#tables.connections)
            .where('owner', ref.owner)
            .where('issuer', ref.issuer)
            .where('state', from)
            .update({ state: to })
        : await this.db
            .from(this.#tables.pending)
            .where('id', ref.id)
            .where('flow', from)
            .update({ flow: to });
    return affectedRows(affected) > 0;
  }
}

/** knex answers an update with a count (or, on some drivers, an array). */
function affectedRows(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return typeof result[0] === 'number' ? result[0] : result.length;
  return Number(result ?? 0);
}

/** The slice of a Redis client {@link redisPoppyConnectionStore} uses (ioredis has it). */
export interface PoppyConnectionRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  /** `SCAN cursor MATCH pattern COUNT n` (ioredis has it): lets `agent:crypto:reseal` walk the store. */
  scan?(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
}

/** {@link PoppyConnectionStore} over Redis: JSON values, an index set per owner. */
export function redisPoppyConnectionStore(
  redis: PoppyConnectionRedisClient,
  options: { prefix?: string } = {},
): PoppyConnectionStore {
  const p = options.prefix ?? 'agent:poppy-connections:';
  const key = (owner: string, issuer: string) => `${p}conn:${owner}\n${issuer}`;
  const index = (owner: string) => `${p}owner:${owner}`;
  const pendingKey = (id: string) => `${p}pending:${id}`;
  const get = async <T>(k: string): Promise<T | null> => {
    const raw = await redis.get(k);
    return raw === null ? null : (JSON.parse(raw) as T);
  };
  return {
    async listConnections(owner) {
      const issuers = await redis.smembers(index(owner));
      const found = await Promise.all(
        issuers.map((i) => get<PoppyConnectionRecord>(key(owner, i))),
      );
      return found.filter((c): c is PoppyConnectionRecord => c !== null);
    },
    getConnection: (owner, issuer) => get<PoppyConnectionRecord>(key(owner, issuer)),
    async saveConnection(record) {
      await redis.set(key(record.owner, record.issuer), JSON.stringify(record));
      await redis.sadd(index(record.owner), record.issuer);
    },
    async deleteConnection(owner, issuer) {
      await redis.del(key(owner, issuer));
      await redis.srem(index(owner), issuer);
    },
    async createPending(record) {
      const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000) + 3600);
      await redis.set(pendingKey(record.id), JSON.stringify(record), 'EX', ttl, 'NX');
    },
    getPending: (id) => get<PoppyPendingConnect>(pendingKey(id)),
    async updatePending(id, patch) {
      const found = await get<PoppyPendingConnect>(pendingKey(id));
      if (!found) return;
      await redis.set(pendingKey(id), JSON.stringify({ ...found, ...patch }), 'KEEPTTL');
    },
    ...(typeof redis.scan === 'function'
      ? {
          async listSealed() {
            const out: PoppySealedValue[] = [];
            for (const k of await scanKeys(`${p}conn:*`)) {
              const c = await get<PoppyConnectionRecord>(k);
              if (c)
                out.push({
                  ref: { table: 'connection', owner: c.owner, issuer: c.issuer },
                  value: c.state,
                });
            }
            for (const k of await scanKeys(`${p}pending:*`)) {
              const found = await get<PoppyPendingConnect>(k);
              if (found?.flow)
                out.push({ ref: { table: 'pending', id: found.id }, value: found.flow });
            }
            return out;
          },
        }
      : {}),
    // Read, compare, write: not atomic, so a value written between the two is lost only if it
    // was written in that instant; `agent:crypto:reseal` is an operator command, not a hot path.
    async replaceSealed(ref, from, to) {
      if (ref.table === 'connection') {
        const found = await get<PoppyConnectionRecord>(key(ref.owner, ref.issuer));
        if (found?.state !== from) return false;
        await redis.set(key(ref.owner, ref.issuer), JSON.stringify({ ...found, state: to }));
        return true;
      }
      const found = await get<PoppyPendingConnect>(pendingKey(ref.id));
      if (found?.flow !== from) return false;
      await redis.set(pendingKey(ref.id), JSON.stringify({ ...found, flow: to }), 'KEEPTTL');
      return true;
    },
  };

  async function scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await (redis.scan as NonNullable<typeof redis.scan>)(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        200,
      );
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return [...new Set(keys)];
  }
}
