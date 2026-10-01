import { beforeEach } from 'vitest';

/**
 * Setup file of the `postgres` and `mysql` test projects: when the global setup could not provide
 * that server (no Docker, outside CI), every case is skipped — reported as skipped, not passed.
 */
beforeEach((context) => {
  const backend = process.env.AGENT_TEST_BACKEND;
  const url =
    backend === 'postgres' ? process.env.AGENT_TEST_PG_URL : process.env.AGENT_TEST_MYSQL_URL;
  if (url === undefined) context.skip(`no ${backend} server (Docker unavailable?)`);
});
