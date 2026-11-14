import type { ApplicationService } from '@adonisjs/core/types';
import { resolveAgentTenancy } from '../agora/tenancy.js';
import { resolveDashboardConfig } from '../dashboard/define_config.js';
import { devToolsAuthIssuers, devToolsAuthProblems } from '../dev-tools/auth.js';
import { csrfBlocksPath } from '../dev-tools/csrf.js';
import { DEV_TOOLS_BINDING, resolveDevTools } from '../dev-tools/resolve.js';
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

/** What the checks say when nothing serves MCP. */
const MCP_OFF = 'MCP is not mounted (no config/mcp.ts and mcp_provider is not registered).';

/**
 * The MCP config `mcp_provider` runs with, or `undefined` when nothing serves MCP. A missing
 * `config/mcp.ts` is NOT "off": with the provider registered (its dev tools hub is bound) it runs
 * on an empty config, i.e. every default — `/mcp` and the dev tools at `/mcp/agora`.
 */
export function mcpConfig(app: ApplicationService): AnyConfig | undefined {
  const config = app.config.get<AnyConfig | undefined>('mcp', undefined);
  if (config !== undefined) return config;
  return app.container.hasBinding(DEV_TOOLS_BINDING as never) ? {} : undefined;
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
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
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

/**
 * `agent.mcp-execute`: action tools served over MCP without a per-caller check — the product
 * endpoint without an `authorizer`, or `devTools.actions: 'execute'`.
 */
export function checkMcpExecute(mcp: AnyConfig | undefined): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
  const productExecutes =
    mcp.actions === 'execute' ||
    ((mcp.endpoints as AnyConfig[] | undefined) ?? []).some((e) => e.actions === 'execute');
  const product = productExecutes && mcp.authorizer === undefined;
  const devTools = resolveDevTools(mcp as never)?.actions === 'execute';
  if (!product && !devTools) {
    return {
      status: 'ok',
      message: productExecutes
        ? 'Action tools over MCP go through your authorizer.'
        : 'MCP clients cannot run action tools without a per-caller check.',
    };
  }
  const devFix =
    "Authorize dev tool actions per lib or tool: `devTools.actions: { payments: authorizeByRoles({ roles: ['ADMIN'] }) }`, or keep `'refuse'`.";
  if (!product) {
    return {
      status: 'warn',
      message:
        "`devTools.actions: 'execute'` lets every caller the libs' consoles admit run every dev action tool (refund, cancel, delete…).",
      fix: devFix,
      docs: `${DOCS}/dev-tools#actions`,
    };
  }
  return {
    status: 'warn',
    message: `\`actions: 'execute'\` lets MCP clients run action tools, checked only by roles (no \`authorizer\`)${devTools ? "; so does `devTools.actions: 'execute'` for the dev tools" : ''}.`,
    fix: `Set an \`authorizer\` in config/mcp.ts (e.g. an ability-based one), or keep \`actions: 'refuse'\`.${devTools ? ` ${devFix}` : ''}`,
    docs: `${DOCS}/mcp`,
  };
}

/** `agent.mcp-csrf`: every MCP path is exempt from shield's CSRF check. */
export function checkMcpCsrf(mcp: AnyConfig | undefined, shield: unknown): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
  const paths = [normalizeMcpPath(mcp.path as string | undefined)];
  for (const endpoint of (mcp.endpoints as AnyConfig[] | undefined) ?? []) {
    paths.push(normalizeMcpPath(endpoint.path as string | undefined));
  }
  const devTools = resolveDevTools(mcp as never);
  if (devTools !== null) paths.push(devTools.path);
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
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
  const devTools = resolveDevTools(mcp as never);
  if (devTools === null) {
    return { status: 'skip', message: 'The dev tools endpoint is off (`devTools: false`).' };
  }
  if (consoleless.length === 0) {
    return { status: 'skip', message: 'No lib without a console serves dev tools.' };
  }
  if (devTools.authorize !== undefined) {
    return { status: 'ok', message: 'devTools.authorize gates the libs without a console.' };
  }
  return {
    status: inProduction ? 'warn' : 'ok',
    message: `The dev tools of ${consoleless.join(', ')} have no authorize: open outside production, denied in production.`,
    fix: 'Set `devTools.authorize` in config/mcp.ts to reach them in production.',
    docs: `${DOCS}/dev-tools#libs-without-a-console`,
  };
}

/** Whether authkit lets MCP clients sign in, as the doctor reads it from `config/authkit.ts`. */
export type AuthkitMcpOption =
  | { installed: false }
  | { installed: true; mcpClients: boolean }
  | { installed: true; unresolved: string };

/**
 * MCP client login is automatic in authkit: on whenever an MCP resource is registered (the dev
 * tools hub registers itself), off only with `mcpClients: false`. Read structurally, without
 * importing authkit: the input `mcpClients: false`, or the resolved `{ allowed: false }`.
 */
function mcpClientsAllowed(config: AnyConfig | null | undefined): boolean {
  const value = config?.mcpClients;
  if (value === false) return false;
  if (typeof value === 'object' && value !== null) {
    return (value as { allowed?: unknown }).allowed !== false;
  }
  return true;
}

/**
 * Reads `mcpClients` from `config/authkit.ts` without importing authkit: the file's `defineConfig`
 * is a config provider (`{ type: 'provider', resolver }`), resolved here the way the authkit
 * provider resolves it; a plain object is read as is. No `config/authkit.ts` → authkit is not
 * installed.
 */
export async function readAuthkitMcpOption(app: ApplicationService): Promise<AuthkitMcpOption> {
  const raw = app.config.get<unknown>('authkit', undefined);
  if (raw === undefined || raw === null) return { installed: false };
  try {
    const provider = raw as { type?: unknown; resolver?: unknown };
    const config =
      provider.type === 'provider' && typeof provider.resolver === 'function'
        ? await (provider.resolver as (app: ApplicationService) => Promise<unknown>)(app)
        : raw;
    return { installed: true, mcpClients: mcpClientsAllowed(config as AnyConfig | null) };
  } catch (error) {
    return {
      installed: true,
      unresolved: error instanceof Error ? error.message : String(error),
    };
  }
}

/** `agent.dev-tools-authkit-mcp`: with authkit, MCP clients can sign in to the dev tools hub. */
export function checkDevToolsAuthkitMcp(
  mcp: AnyConfig | undefined,
  authkit: AuthkitMcpOption,
): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
  const devTools = resolveDevTools(mcp as never);
  if (devTools === null) {
    return { status: 'skip', message: 'The dev tools endpoint is off (`devTools: false`).' };
  }
  if (devTools.auth !== undefined) {
    return { status: 'skip', message: '`devTools.auth` signs MCP clients in, not authkit.' };
  }
  if (!authkit.installed) return { status: 'skip', message: 'authkit is not installed.' };
  if ('unresolved' in authkit) {
    return {
      status: 'skip',
      message: `config/authkit.ts could not be resolved: ${authkit.unresolved}`,
    };
  }
  if (authkit.mcpClients) {
    return {
      status: 'ok',
      message: `MCP clients can sign in to /${devTools.path} through authkit (automatic: the hub registers itself as an MCP resource).`,
    };
  }
  return {
    status: 'warn',
    message: `The dev tools hub at /${devTools.path} is on, but \`mcpClients: false\` in config/authkit.ts turns MCP client login off: MCP clients can't register.`,
    fix: 'Remove `mcpClients: false` from config/authkit.ts.',
    docs: `${DOCS}/dev-tools#connect-a-client`,
  };
}

/**
 * `agent.dev-tools-auth`: how MCP clients sign in to the dev tools hub — `devTools.auth` (any
 * authorization server), authkit, or header tokens only — and whether `devTools.auth` is usable.
 */
export function checkDevToolsAuth(
  mcp: AnyConfig | undefined,
  authkitInstalled: boolean,
): AgoraDoctorResult {
  if (mcp === undefined) return { status: 'skip', message: MCP_OFF };
  const devTools = resolveDevTools(mcp as never);
  if (devTools === null) {
    return { status: 'skip', message: 'The dev tools endpoint is off (`devTools: false`).' };
  }
  const where = `/${devTools.path}`;
  if (devTools.auth !== undefined) {
    const { errors, warnings } = devToolsAuthProblems(devTools.auth);
    const issuers = devToolsAuthIssuers(devTools.auth);
    const mode = `custom auth (${issuers.length > 0 ? issuers.join(', ') : 'no issuers'})`;
    if (errors.length > 0) {
      return {
        status: 'error',
        message: `${where} uses ${mode}: ${errors.join(' ')}`,
        fix: 'Use `jwtAuth({ issuer })` / `introspectionAuth(…)`, or give `devTools.auth` an `authorizationServers` list and a `verify(token, ctx)`.',
        docs: `${DOCS}/dev-tools#any-oauth-server`,
      };
    }
    if (warnings.length > 0) {
      return {
        status: 'warn',
        message: `${where} uses ${mode}: ${warnings.join(' ')}`,
        fix: 'List your issuer in `devTools.auth.authorizationServers`.',
        docs: `${DOCS}/dev-tools#any-oauth-server`,
      };
    }
    return {
      status: 'ok',
      message: `MCP clients sign in to ${where} with ${mode}${authkitInstalled ? '; authkit is installed but not used for the hub' : ''}.`,
    };
  }
  if (authkitInstalled) {
    return { status: 'ok', message: `MCP clients sign in to ${where} through authkit.` };
  }
  return {
    status: 'ok',
    message: `${where} is token-only: no OAuth sign-in, MCP clients send a header token checked by the consoles' authorize.`,
    fix: 'For browser sign-in from MCP clients, set `devTools.auth: jwtAuth({ issuer })` or install authkit.',
    docs: `${DOCS}/dev-tools#any-oauth-server`,
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
      id: 'agent.dev-tools-authkit-mcp',
      lib: 'agent',
      title: 'Dev tools sign-in through authkit',
      run: async (app) => {
        const mcp = mcpConfig(app);
        if (mcp === undefined || resolveDevTools(mcp as never) === null) {
          return checkDevToolsAuthkitMcp(mcp, { installed: false });
        }
        return checkDevToolsAuthkitMcp(mcp, await readAuthkitMcpOption(app));
      },
    },
    {
      id: 'agent.dev-tools-auth',
      lib: 'agent',
      title: 'Dev tools sign-in mode',
      run: async (app) => {
        const mcp = mcpConfig(app);
        if (mcp === undefined || resolveDevTools(mcp as never) === null) {
          return checkDevToolsAuth(mcp, false);
        }
        return checkDevToolsAuth(mcp, (await readAuthkitMcpOption(app)).installed);
      },
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
