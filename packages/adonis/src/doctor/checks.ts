import type { ApplicationService } from '@adonisjs/core/types';
import { resolveAgentTenancy } from '../agora/tenancy.js';
import { resolveDashboardConfig } from '../dashboard/define_config.js';
import { csrfBlocksPath } from '../dev-tools/csrf.js';
import { normalizeMcpPath } from '../mcp/discovery.js';
import { schemaExists } from '../stores/db-schema.js';
import type { LucidDatabaseLike } from '../stores/lucid.js';
import { AGENT_TABLES, agentTables, rowsOf } from '../stores/lucid-schema.js';
import { isMySql } from '../stores/sql-dialect.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/agent';

type AnyConfig = Record<string, unknown>;

function agentConfig(app: ApplicationService): AnyConfig | undefined {
  return app.config.get<AnyConfig | undefined>('agent', undefined);
}

function mcpConfig(app: ApplicationService): AnyConfig | undefined {
  return app.config.get<AnyConfig | undefined>('mcp', undefined);
}

/** `agent.console-gate`: the governance console has an `authorize`. */
export function checkConsoleGate(
  agent: AnyConfig | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (agent === undefined) return { status: 'skip', message: 'config/agent.ts is missing.' };
  const dashboard = resolveDashboardConfig(agent.dashboard as never);
  if (!dashboard.enabled || agent.governanceQueries === false) {
    return { status: 'skip', message: 'The governance console is off.' };
  }
  if (dashboard.authorize !== undefined) {
    return { status: 'ok', message: 'The governance console has an authorize.' };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message: inProduction
      ? 'The governance console has no authorize: it denies every request in production.'
      : 'The governance console has no authorize: it is open here and denies every request in production.',
    fix: 'Set `dashboard.authorize` in config/agent.ts.',
    docs: `${DOCS}/governance/dashboard#access`,
  };
}

/** `agent.actor-resolver`: the chat endpoints know who is calling. */
export function checkActorResolver(
  agent: AnyConfig | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (agent === undefined) return { status: 'skip', message: 'config/agent.ts is missing.' };
  if (agent.actorResolver !== undefined) {
    return { status: 'ok', message: 'An actorResolver identifies every caller.' };
  }
  const quota = agent.quota !== undefined;
  return {
    status: inProduction && !quota ? 'error' : 'warn',
    message: quota
      ? 'No actorResolver: the agent endpoints are public, each browser is its own anonymous actor (the quota applies per browser).'
      : 'No actorResolver and no quota: the agent endpoints are public and model spend is unbounded.',
    fix: 'Set `actorResolver: new AuthActorResolver()` (and a `quota`) in config/agent.ts.',
    docs: `${DOCS}/config-reference#actorresolver`,
  };
}

/** `agent.mcp-open`: the product MCP endpoint runs with a fixed `actor` (no auth) in production. */
export function checkMcpOpen(mcp: AnyConfig | undefined, inProduction: boolean): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: 'config/mcp.ts is missing.' };
  const open: string[] = [];
  if (mcp.auth === undefined && mcp.actor !== undefined)
    open.push(`/${normalizeMcpPath(mcp.path as string | undefined)}`);
  for (const endpoint of (mcp.endpoints as AnyConfig[] | undefined) ?? []) {
    const auth = endpoint.auth ?? mcp.auth;
    if (auth === undefined && mcp.actor !== undefined) {
      open.push(`/${normalizeMcpPath(endpoint.path as string | undefined)}`);
    }
  }
  if (open.length === 0)
    return { status: 'ok', message: 'Every MCP endpoint authenticates its callers.' };
  return {
    status: inProduction ? 'error' : 'warn',
    message: `${open.join(', ')} ${open.length === 1 ? 'runs' : 'run'} without auth, as the fixed \`actor\` (open mode).`,
    fix: 'Set `auth` (authKitAuth() or apiKeyAuth()) in config/mcp.ts and remove `actor`.',
    docs: `${DOCS}/mcp`,
  };
}

/** `agent.mcp-execute`: action tools served over MCP without an authorizer. */
export function checkMcpExecute(mcp: AnyConfig | undefined): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: 'config/mcp.ts is missing.' };
  const executes =
    mcp.actions === 'execute' ||
    ((mcp.endpoints as AnyConfig[] | undefined) ?? []).some((e) => e.actions === 'execute');
  if (!executes) return { status: 'ok', message: 'MCP clients cannot run action tools.' };
  if (mcp.authorizer !== undefined) {
    return { status: 'ok', message: 'Action tools over MCP go through your authorizer.' };
  }
  return {
    status: 'warn',
    message:
      "`actions: 'execute'` lets MCP clients run action tools, checked only by roles (no `authorizer`).",
    fix: "Set an `authorizer` in config/mcp.ts (e.g. an ability-based one), or keep `actions: 'refuse'`.",
    docs: `${DOCS}/mcp`,
  };
}

/** `agent.mcp-csrf`: every MCP path is exempt from shield's CSRF check. */
export function checkMcpCsrf(mcp: AnyConfig | undefined, shield: unknown): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: 'config/mcp.ts is missing.' };
  const paths = [normalizeMcpPath(mcp.path as string | undefined)];
  for (const endpoint of (mcp.endpoints as AnyConfig[] | undefined) ?? []) {
    paths.push(normalizeMcpPath(endpoint.path as string | undefined));
  }
  if (mcp.devTools !== false) {
    const devTools = (mcp.devTools as AnyConfig | undefined) ?? {};
    paths.push(normalizeMcpPath((devTools.path as string | undefined) ?? 'mcp/agora'));
  }
  const blocked = paths.filter((path) => csrfBlocksPath(shield, path)).map((path) => `/${path}`);
  if (blocked.length === 0) return { status: 'ok', message: 'No MCP path is blocked by CSRF.' };
  return {
    status: 'warn',
    message: `Shield's CSRF check rejects MCP clients at ${blocked.join(', ')}.`,
    fix: `Add ${blocked.join(', ')} to \`csrf.exceptRoutes\` in config/shield.ts.`,
    docs: `${DOCS}/dev-tools#csrf`,
  };
}

/** `agent.dev-tools-gate`: libs without a console are gated in production. */
export function checkDevToolsGate(
  mcp: AnyConfig | undefined,
  consoleless: readonly string[],
  inProduction: boolean,
): AgoraDoctorResult {
  if (mcp === undefined || mcp.devTools === false) {
    return { status: 'skip', message: 'The dev tools endpoint is off.' };
  }
  if (consoleless.length === 0) {
    return { status: 'skip', message: 'No lib without a console serves dev tools.' };
  }
  if ((mcp.devTools as AnyConfig | undefined)?.authorize !== undefined) {
    return { status: 'ok', message: 'devTools.authorize gates the libs without a console.' };
  }
  return {
    status: inProduction ? 'warn' : 'ok',
    message: `The dev tools of ${consoleless.join(', ')} have no authorize: open outside production, denied in production.`,
    fix: 'Set `devTools.authorize` in config/mcp.ts to reach them in production.',
    docs: `${DOCS}/dev-tools#libs-without-a-console`,
  };
}

/** `agent.tenancy-store`: with organizations on, the store can scope threads and runs. */
export function checkTenancyStore(
  agent: AnyConfig | undefined,
  enabled: boolean,
  store: Record<string, unknown> | undefined,
): AgoraDoctorResult {
  if (agent === undefined || !enabled) return { status: 'skip', message: 'Organizations are off.' };
  if (store === undefined) {
    return { status: 'skip', message: 'The agent store has not been built (app not booted).' };
  }
  const missing = ['listThreadsInScope', 'getThreadTenantRef', 'getRunTenantRef'].filter(
    (method) => typeof store[method] !== 'function',
  );
  if (missing.length === 0) {
    return { status: 'ok', message: 'The agent store scopes threads and runs by organization.' };
  }
  return {
    status: 'error',
    message: `Organizations are on, but the agent store has no ${missing.join(', ')}: users see no thread or run.`,
    fix: 'Use the Lucid store, or implement those methods on your AgentStore.',
    docs: `${DOCS}/governance/authorization#organizations`,
  };
}

/** What {@link checkDbSchema} reads from the Lucid agent store. */
export interface SchemaStoreLike {
  database: LucidDatabaseLike;
  databaseSchema: string | undefined;
}

/** Thrown inside the write probe's transaction so it always rolls back. */
class ProbeRollback extends Error {}

/**
 * `agent.db-schema`: with a `schema` set, it exists, the agent tables are in it, and the connection
 * can write there (one insert, rolled back). Only registered when a schema is configured.
 */
export async function checkDbSchema(
  store: SchemaStoreLike | undefined,
): Promise<AgoraDoctorResult> {
  if (store?.databaseSchema === undefined) {
    return { status: 'skip', message: 'The agent store has no database schema configured.' };
  }
  const { database: db, databaseSchema: schema } = store;
  const docs = `${DOCS}/stores/lucid#database-schema`;
  if (!(await schemaExists(db, schema))) {
    return {
      status: 'error',
      message: `The database schema "${schema}" does not exist.`,
      fix: 'Start the app once with `autoCreateTables` on, or run the agent migration (`createAgentTables`).',
      docs,
    };
  }
  const present = new Set(
    rowsOf(
      await db.rawQuery(
        'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
        [schema],
      ),
    ).map((row) => String(row.name ?? row.NAME)),
  );
  const missing = Object.values(AGENT_TABLES).filter((table) => !present.has(table));
  if (missing.length > 0) {
    return {
      status: 'error',
      message: `Schema "${schema}" lacks ${missing.join(', ')}.`,
      fix: 'Start the app once with `autoCreateTables` on, or run the agent migration (`createAgentTables`).',
      docs,
    };
  }
  try {
    await db.transaction(async (trx) => {
      await trx.table(agentTables(schema).confirmTokens).insert({
        hash: `doctor-${Date.now()}`,
        actor_ref: 'agora:doctor',
        tool: 'agora:doctor',
        expires_at: 0,
        created_at: 0,
      });
      throw new ProbeRollback();
    });
  } catch (error) {
    if (!(error instanceof ProbeRollback)) {
      const grant = isMySql(db)
        ? `GRANT INSERT, UPDATE, DELETE ON \`${schema}\`.* TO <app user>`
        : `GRANT USAGE ON SCHEMA "${schema}" TO <app role>; GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO <app role>`;
      return {
        status: 'error',
        message: `The connection cannot write to schema "${schema}": ${(error as Error).message}`,
        fix: grant,
        docs,
      };
    }
  }
  return {
    status: 'ok',
    message: `Schema "${schema}" holds the agent tables and the connection can write there.`,
  };
}

/** The checks `@adonis-agora/agent`'s provider registers. */
export function agentDoctorChecks(
  deps: {
    /** The agent store the provider built, when it did. */
    store?: () => Record<string, unknown> | undefined;
    /** Libs registered on the dev tools hub without an `authorize` of their own. */
    consolelessLibs?: () => Promise<string[]>;
    /**
     * The Lucid agent store, when it keeps its tables in a database `schema`. Absent → the
     * `agent.db-schema` check is not registered at all (no schema, nothing new to report).
     */
    schemaStore?: () => SchemaStoreLike | undefined;
  } = {},
): AgoraDoctorCheck[] {
  const schemaCheck: AgoraDoctorCheck[] =
    deps.schemaStore === undefined
      ? []
      : [
          {
            id: 'agent.db-schema',
            lib: 'agent',
            title: 'Database schema',
            cost: 'deep',
            run: () => checkDbSchema(deps.schemaStore?.()),
          },
        ];
  return [
    {
      id: 'agent.console-gate',
      lib: 'agent',
      title: 'Console access in production',
      run: (app) => checkConsoleGate(agentConfig(app), app.inProduction),
    },
    {
      id: 'agent.actor-resolver',
      lib: 'agent',
      title: 'Callers are identified',
      run: (app) => checkActorResolver(agentConfig(app), app.inProduction),
    },
    {
      id: 'agent.mcp-open',
      lib: 'agent',
      title: 'MCP endpoints authenticate',
      run: (app) => checkMcpOpen(mcpConfig(app), app.inProduction),
    },
    {
      id: 'agent.mcp-execute',
      lib: 'agent',
      title: 'Action tools over MCP are authorized',
      run: (app) => checkMcpExecute(mcpConfig(app)),
    },
    {
      id: 'agent.mcp-csrf',
      lib: 'agent',
      title: 'MCP paths pass CSRF',
      run: (app) => checkMcpCsrf(mcpConfig(app), app.config.get<unknown>('shield', undefined)),
    },
    {
      id: 'agent.dev-tools-gate',
      lib: 'agent',
      title: 'Dev tools of libs without a console',
      run: async (app) =>
        checkDevToolsGate(mcpConfig(app), (await deps.consolelessLibs?.()) ?? [], app.inProduction),
    },
    {
      id: 'agent.tenancy-store',
      lib: 'agent',
      title: 'Organizations: the store scopes data',
      run: (app) => {
        const agent = agentConfig(app);
        const enabled = resolveAgentTenancy(agent?.tenancy as never).enabled;
        return checkTenancyStore(agent, enabled, deps.store?.());
      },
    },
    ...schemaCheck,
  ];
}
