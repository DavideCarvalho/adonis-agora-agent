// Real databases for the Lucid store suites: one Postgres and one MySQL for the whole run, started
// with testcontainers, their admin URLs handed to every worker as AGENT_TEST_PG_URL /
// AGENT_TEST_MYSQL_URL (the variables the specs already read). Each spec creates its own throwaway
// database inside them (test/helpers/real-db.ts).
//
// Only when asked: under CI, or with AGENT_TEST_REAL_DB=1 (`pnpm test:db`). A plain `pnpm test`
// starts nothing and the Postgres/MySQL cases skip, as they always have. A URL already in the
// environment (CI's Postgres service, a server of your own) is used instead of a container.
//
// Asked and no Docker: under CI (or AGENT_TEST_REQUIRE_REAL_DB=1) the run fails; otherwise it warns
// and the real-database cases skip.
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const MYSQL_IMAGE = 'mysql:8.4';

const wanted = () => Boolean(process.env.CI) || Boolean(process.env.AGENT_TEST_REAL_DB);
const required = () => Boolean(process.env.CI) || Boolean(process.env.AGENT_TEST_REQUIRE_REAL_DB);

export default async function setup() {
  if (!wanted()) return;
  const needPg = process.env.AGENT_TEST_PG_URL === undefined;
  const needMySql = process.env.AGENT_TEST_MYSQL_URL === undefined;
  if (!needPg && !needMySql) return;

  try {
    await getContainerRuntimeClient();
  } catch (error) {
    const cause = `Docker is not available (${(error instanceof Error ? error.message : String(error)).split('\n')[0]})`;
    if (required()) {
      throw new Error(
        `[real-db] ${cause}. The Postgres and MySQL suites are required here (CI / AGENT_TEST_REQUIRE_REAL_DB), so this run fails rather than skipping them.`,
      );
    }
    console.warn(
      `\n[real-db] ${cause}, so the Postgres/MySQL cases are skipped and only SQLite runs. Start Docker, or set AGENT_TEST_PG_URL / AGENT_TEST_MYSQL_URL.\n`,
    );
    return;
  }

  const started: Array<StartedPostgreSqlContainer | StartedMySqlContainer> = [];
  const [postgres, mysql] = await Promise.all([
    needPg
      ? new PostgreSqlContainer(POSTGRES_IMAGE)
          .withLabels({ 'adonis-agent.test-db': 'postgres' })
          .withCommand(['postgres', '-c', 'max_connections=500', '-c', 'fsync=off'])
          .start()
      : undefined,
    needMySql
      ? new MySqlContainer(MYSQL_IMAGE)
          .withLabels({ 'adonis-agent.test-db': 'mysql' })
          .withRootPassword('test')
          .withCommand([
            '--max-connections=500',
            '--innodb-flush-log-at-trx-commit=0',
            '--skip-log-bin',
          ])
          .start()
      : undefined,
  ]);
  if (postgres !== undefined) {
    started.push(postgres);
    process.env.AGENT_TEST_PG_URL = postgres.getConnectionUri();
  }
  if (mysql !== undefined) {
    started.push(mysql);
    process.env.AGENT_TEST_MYSQL_URL = `mysql://root:test@${mysql.getHost()}:${mysql.getPort()}/mysql`;
  }

  return async () => {
    await Promise.all(started.map((container) => container.stop()));
  };
}
