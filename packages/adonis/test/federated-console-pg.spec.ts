import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFederatedAgentApp } from '../src/federation/console.js';
import { RedisConsoleChannel } from '../src/federation/redis_channel.js';
import {
  AGENT_TABLES,
  createAgentTables,
  governanceQueries,
  LucidAgentStore,
  type LucidDatabaseLike,
  pricingStores,
} from '../src/index.js';
import { RedisBus } from './support/redis_bus.js';

/**
 * The federated console against real Postgres: two apps keep their agent tables in their own
 * schemas, and the console reads the other app's through a role with only `USAGE` + `SELECT`
 * there. Runs when `AGENT_TEST_PG_URL` is set.
 */
const url = process.env.AGENT_TEST_PG_URL;

function database(connection: string): Database {
  const target = new URL(connection);
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: {
            host: target.hostname,
            port: Number(target.port || 5432),
            user: decodeURIComponent(target.username),
            password: decodeURIComponent(target.password),
            database: target.pathname.slice(1),
          },
          pool: { min: 0, max: 4 },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

const asStoreDb = (db: unknown) => db as LucidDatabaseLike;

describe.skipIf(url === undefined)('federated agent console on Postgres', () => {
  const suffix = randomBytes(4).toString('hex');
  const owning = `et_${suffix}`;
  const local = `hub_${suffix}`;
  const role = `agent_ro_${suffix}`;
  let admin: Database;
  let readOnly: Database;
  const statements: string[] = [];

  const raw = (sql: string) => admin.connection('pg').rawQuery(sql);

  beforeAll(async () => {
    admin = database(url as string);
    await createAgentTables(asStoreDb(admin.connection('pg')), { schema: owning });
    await createAgentTables(asStoreDb(admin.connection('pg')), { schema: local });
    await raw(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    await raw(`GRANT USAGE ON SCHEMA "${owning}" TO ${role}`);
    const tables = Object.values(AGENT_TABLES)
      .map((table) => `"${owning}"."${table}"`)
      .join(', ');
    await raw(`GRANT SELECT ON ${tables} TO ${role}`);
    const limited = new URL(url as string);
    limited.username = role;
    limited.password = 'pw';
    readOnly = database(limited.href);
    const knex = readOnly.connection('pg').getWriteClient() as unknown as {
      on(event: 'query', listener: (query: { sql: string }) => void): void;
    };
    knex.on('query', (query) => statements.push(query.sql));
  });

  afterAll(async () => {
    await readOnly?.manager.closeAll();
    if (admin) {
      await raw(`DROP SCHEMA IF EXISTS "${owning}" CASCADE`);
      await raw(`DROP SCHEMA IF EXISTS "${local}" CASCADE`);
      await raw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await raw(`DROP ROLE IF EXISTS ${role}`);
      await admin.manager.closeAll();
    }
  });

  it("reads the other app's threads and prices through SELECT only, never its own", async () => {
    const etStore = new LucidAgentStore(asStoreDb(admin.connection('pg')), {
      schema: owning,
      autoCreateTables: false,
    } as never);
    const hubStore = new LucidAgentStore(asStoreDb(admin.connection('pg')), {
      schema: local,
      autoCreateTables: false,
    } as never);
    await etStore.createThread({ actor: { id: 'student-1' }, title: 'ET thread' });
    await hubStore.createThread({ actor: { id: 'hub-1' }, title: 'Hub thread' });
    // The console builds the app from its config, as `dashboard.apps` does — no
    // `autoCreateTables: false` needed: a federated reader never creates anything.
    const app = await buildFederatedAgentApp(
      'entre-textos',
      {
        label: 'Entre Textos',
        governance: governanceQueries.lucid({ connection: 'pg', schema: owning }),
        pricing: pricingStores.lucid({ connection: 'pg', schema: owning }),
        controlPlane: new RedisConsoleChannel({
          client: new RedisBus().connection(),
          prefix: 'et',
        }),
      },
      { container: { make: async () => readOnly } } as never,
    );

    const threads = await app.governance.recentThreads(10);
    expect(threads.map((t) => t.title)).toEqual(['ET thread']);
    // Its prices are read from its own table too (empty here).
    expect(await app.pricing?.listCurrentPrices()).toEqual([]);

    // The role cannot write there, and the console never sent any DDL.
    await expect(
      readOnly
        .connection('pg')
        .from(`${owning}.${AGENT_TABLES.threads}`)
        .where('title', 'ET thread')
        .delete(),
    ).rejects.toThrow(/permission denied/);
    expect(statements.filter((sql) => /^\s*(create|alter|drop)\b/i.test(sql))).toEqual([]);
    await app.close();
  });
});
