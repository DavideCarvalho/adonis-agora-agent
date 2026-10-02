import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { describe } from 'vitest';
import { AGENT_TABLES, createAgentTables, type LucidDatabaseLike } from '../../src/index.js';
import { makeMemoryDb } from './make-db.js';

/**
 * The Lucid store suites on SQLite, Postgres and MySQL. SQLite is always there; Postgres and MySQL
 * are there when `AGENT_TEST_PG_URL` / `AGENT_TEST_MYSQL_URL` name a server whose user may `CREATE
 * DATABASE` — which `test/global-setup-real-db.ts` arranges under CI and `pnpm test:db`. Every
 * {@link openBackend} gets a database of its own on that server, so specs running in parallel never
 * see each other's rows.
 */
export type Backend = 'sqlite' | 'postgres' | 'mysql';
export const BACKENDS: readonly Backend[] = ['sqlite', 'postgres', 'mysql'];

function adminUrl(backend: 'postgres' | 'mysql'): string | undefined {
  return backend === 'postgres' ? process.env.AGENT_TEST_PG_URL : process.env.AGENT_TEST_MYSQL_URL;
}

/** Why `backend` cannot run here, or `undefined` when it can. */
export function unavailable(backend: Backend): string | undefined {
  if (backend === 'sqlite' || adminUrl(backend) !== undefined) return undefined;
  return `set ${backend === 'postgres' ? 'AGENT_TEST_PG_URL' : 'AGENT_TEST_MYSQL_URL'} or run \`pnpm test:db\` with Docker`;
}

/**
 * `describe` once per backend. A backend without a server is still listed — skipped, its title
 * saying why — so a run without one reads as "skipped", never as "passed".
 */
export function describeEachBackend(title: string, body: (backend: Backend) => void): void {
  for (const backend of BACKENDS) {
    const reason = unavailable(backend);
    if (reason === undefined) {
      describe(`${title} [${backend}]`, () => body(backend));
    } else {
      describe.skip(`${title} [${backend}] — skipped: ${reason}`, () => body(backend));
    }
  }
}

async function admin(backend: 'postgres' | 'mysql', statement: string): Promise<void> {
  const url = adminUrl(backend) as string;
  if (backend === 'postgres') {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
    return;
  }
  const connection = await mysql.createConnection(url);
  try {
    await connection.query(statement);
  } finally {
    await connection.end();
  }
}

/** A Lucid `Database` over `url`, the way an app configures one. */
export function lucidOver(
  backend: 'postgres' | 'mysql',
  url: string,
  extra: Record<string, unknown> = {},
): Database {
  const target = new URL(url);
  const connection = {
    host: target.hostname,
    port: Number(target.port || (backend === 'postgres' ? 5432 : 3306)),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: target.pathname.slice(1),
    ...extra,
  };
  return new Database(
    {
      connection: backend,
      connections: {
        [backend]: {
          client: backend === 'postgres' ? 'pg' : 'mysql2',
          connection,
          pool: { min: 0, max: 5 },
        },
      },
    } as never,
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

/** The agent tables, each before the tables it references. */
const RESET_ORDER = [
  AGENT_TABLES.actionProposals,
  AGENT_TABLES.confirmTokens,
  AGENT_TABLES.streamFrames,
  AGENT_TABLES.queuedMessages,
  AGENT_TABLES.runs,
  AGENT_TABLES.tokenUsage,
  AGENT_TABLES.toolCalls,
  AGENT_TABLES.messages,
  AGENT_TABLES.modelPricing,
  AGENT_TABLES.threads,
];

/** Close a `Database`'s pools — through the original `closeAll`, which `makeStoreDb` wraps. */
const originalCloseAll = new WeakMap<object, () => Promise<void>>();
async function closeAllOf(db: Database): Promise<void> {
  const original = originalCloseAll.get(db.manager);
  await (original !== undefined ? original() : db.manager.closeAll());
}

export interface BackendDb {
  backend: Backend;
  db: Database;
  /** The same database as the structural type the stores take. */
  store: LucidDatabaseLike;
  /** Empty every agent table, children first: a fresh start for the next case, schema kept. */
  reset(): Promise<void>;
  /** Another `Database` — its own pool — over the same database (SQLite `:memory:`: the same one). */
  replica(): Database;
  close(): Promise<void>;
}

/**
 * A Lucid `Database` over a fresh database of `backend`. `tables` (default true) provisions the
 * agent tables with `createAgentTables`, as the stores do for themselves.
 */
export async function openBackend(
  backend: Backend,
  options: { tables?: boolean; mysqlFlags?: string[]; sqliteFile?: string } = {},
): Promise<BackendDb> {
  const opened: Database[] = [];
  let drop: (() => Promise<void>) | undefined;
  let open: () => Database;
  if (backend === 'sqlite') {
    const db = makeMemoryDb();
    open = options.sqliteFile === undefined ? () => db : () => makeMemoryDb(options.sqliteFile);
  } else {
    const name = `agent_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await admin(
      backend,
      backend === 'postgres' ? `create database "${name}"` : `create database \`${name}\``,
    );
    drop = () =>
      admin(
        backend,
        backend === 'postgres'
          ? `drop database if exists "${name}" with (force)`
          : `drop database if exists \`${name}\``,
      );
    const url = new URL(adminUrl(backend) as string);
    url.pathname = `/${name}`;
    open = () =>
      lucidOver(
        backend,
        url.toString(),
        backend === 'mysql' && options.mysqlFlags !== undefined
          ? { flags: options.mysqlFlags }
          : {},
      );
  }
  const db = open();
  opened.push(db);
  originalCloseAll.set(db.manager, db.manager.closeAll.bind(db.manager));
  if (options.tables !== false) {
    await createAgentTables(db as unknown as LucidDatabaseLike);
  }
  return {
    backend,
    db,
    store: db as unknown as LucidDatabaseLike,
    reset: async () => {
      for (const table of RESET_ORDER) await db.from(table).delete();
    },
    replica: () => {
      if (backend === 'sqlite' && options.sqliteFile === undefined) return db;
      const second = open();
      opened.push(second);
      originalCloseAll.set(second.manager, second.manager.closeAll.bind(second.manager));
      return second;
    },
    close: async () => {
      for (const each of opened) await closeAllOf(each);
      await drop?.();
    },
  };
}
