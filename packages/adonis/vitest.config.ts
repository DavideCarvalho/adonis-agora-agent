import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Every spec runs in the `sqlite` project. The Lucid store specs — the ones that build their database
 * with `makeStoreDb()` — run AGAIN in a `postgres` and a `mysql` project, where `makeStoreDb()` opens
 * a throwaway database on a real server instead. Those two projects exist only when real databases
 * were asked for (CI, `pnpm test:db`, or a URL in the environment); `test/global-setup-real-db.ts`
 * starts the servers with testcontainers.
 */
const LUCID_STORE_SPECS = [
  'test/action-proposal-store.spec.ts',
  'test/action-proposal-outcome-lucid.spec.ts',
  'test/action-proposal-worker-store.spec.ts',
  'test/attachment-inventory.spec.ts',
  'test/attachment-references.spec.ts',
  'test/blank-assistant-history.spec.ts',
  'test/channels-store-lucid.spec.ts',
  'test/chat-queue-store.spec.ts',
  'test/delegation-cycle.spec.ts',
  'test/fake-model-provider-ids.spec.ts',
  'test/governance-queries-lucid.spec.ts',
  'test/governance-runs.spec.ts',
  'test/inline-agent.spec.ts',
  'test/lucid-confirm-token-store.spec.ts',
  'test/lucid-store.spec.ts',
  'test/message-fields.spec.ts',
  'test/pricing.spec.ts',
  'test/run-fields.spec.ts',
  'test/run-tracing-spans.spec.ts',
  'test/run-tracking.spec.ts',
];

const realDatabases =
  Boolean(process.env.CI) ||
  Boolean(process.env.AGENT_TEST_REAL_DB) ||
  (process.env.AGENT_TEST_PG_URL !== undefined && process.env.AGENT_TEST_MYSQL_URL !== undefined);

const backendProject = (backend: 'postgres' | 'mysql') => ({
  extends: true as const,
  test: {
    name: backend,
    include: LUCID_STORE_SPECS,
    env: { AGENT_TEST_BACKEND: backend },
    setupFiles: ['./test/helpers/skip-without-real-db.ts'],
  },
});

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    pool: 'forks',
    // Postgres + MySQL containers for the Lucid store suites, under CI or `pnpm test:db` only.
    globalSetup: ['./test/global-setup-real-db.ts'],
    hookTimeout: 120_000,
    projects: [
      // `include` per project, not at the root: a project that `extends` the root ADDS to its
      // include list rather than replacing it.
      { extends: true, test: { name: 'sqlite', include: ['test/**/*.{spec,test}.{ts,tsx}'] } },
      ...(realDatabases ? [backendProject('postgres'), backendProject('mysql')] : []),
    ],
  },
});
