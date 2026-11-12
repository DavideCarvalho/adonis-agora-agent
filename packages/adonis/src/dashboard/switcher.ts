import type { HttpContext } from '@adonisjs/core/http';
import {
  type AgoraConsoleDecision,
  type AgoraConsoleEntry,
  type AgoraConsoleSearchHit,
  countOtherConsoles,
  readAgoraConsoles,
  registerAgoraConsole,
} from '../console-switcher.js';
import type { ActorResolver } from '../spi/actor-resolver.js';
import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import { getTelescopeGovernanceQueries } from '../telescope/governance-registry.js';
import type { AgentDashboardAuthorize } from './define_config.js';
import { evaluateDashboardGate } from './gate.js';

/** The agent console's id in the shared `'agora.consoles'` registry. */
export const AGENT_CONSOLE_ID = 'agent';

/** The part of an Adonis application the switcher helpers touch. */
export interface SwitcherAppLike {
  container: {
    hasBinding(binding: string): boolean;
    bindValue(binding: string, value: unknown): void;
    make(binding: string): Promise<unknown>;
  };
  inProduction: boolean;
}

/** What the agent console needs to register itself into the switcher. */
export interface AgentConsoleRegistration {
  /** Where the SPA shell is mounted (`/agent/dashboard`). */
  mount: string;
  actorResolver?: ActorResolver | undefined;
  authorize?: AgentDashboardAuthorize | undefined;
  /** The governance read-model the search reads; defaults to the one the agent provider resolved. */
  governance?: () => AgentGovernanceQueries | undefined;
}

/**
 * Register the agent governance console into the shared `'agora.consoles'` registry, so every other
 * Agora console's switcher can link to it and its global search can find runs and threads here.
 * Call from the provider that mounts the console shell, after the routes are registered.
 */
export async function registerAgentConsole(
  app: SwitcherAppLike,
  options: AgentConsoleRegistration,
  logger: { warn(message: string): void; debug?(message: string): void } = console,
): Promise<boolean> {
  const governance = options.governance ?? getTelescopeGovernanceQueries;
  const entry: AgoraConsoleEntry = {
    id: AGENT_CONSOLE_ID,
    title: 'Agents',
    package: '@adonis-agora/agent',
    icon: 'agent',
    path: options.mount,
    order: 30,
    authorize: (ctx) => agentConsoleDecision(ctx, app, options),
    search: (_ctx, query, limit) => {
      const queries = governance();
      return queries === undefined
        ? Promise.resolve([])
        : searchAgentConsole(queries, options.mount, query, limit);
    },
  };
  return registerAgoraConsole(app, entry, logger);
}

/** The agent console's own gate, as a switcher decision. Never throws. */
export async function agentConsoleDecision(
  ctx: HttpContext,
  app: Pick<SwitcherAppLike, 'inProduction'>,
  options: Pick<AgentConsoleRegistration, 'actorResolver' | 'authorize'>,
): Promise<AgoraConsoleDecision> {
  try {
    const verdict = await evaluateDashboardGate(ctx, {
      actorResolver: options.actorResolver,
      authorize: options.authorize,
      inProduction: app.inProduction,
    });
    if (verdict.ok) return { allowed: true };
    return {
      allowed: false,
      reason: verdict.error,
      ...(verdict.redirectTo !== undefined ? { redirectTo: verdict.redirectTo } : {}),
    };
  } catch {
    return { allowed: false, reason: 'forbidden' };
  }
}

/**
 * The agent console's search provider: a run id or a thread id opens it directly; otherwise the
 * query is read as an actor ref or an agent name and their latest runs are listed.
 */
export async function searchAgentConsole(
  governance: AgentGovernanceQueries,
  mount: string,
  query: string,
  limit: number,
): Promise<AgoraConsoleSearchHit[]> {
  const q = query.trim();
  if (q === '') return [];
  const hits: AgoraConsoleSearchHit[] = [];
  const seen = new Set<string>();
  const push = (hit: AgoraConsoleSearchHit) => {
    if (seen.has(hit.href) || hits.length >= limit) return;
    seen.add(hit.href);
    hits.push(hit);
  };
  const runHref = (id: string) => `${mount}#runs/${encodeURIComponent(id)}`;
  const quiet = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  const [run, thread, byActor, byAgent] = await Promise.all([
    quiet(() => governance.runDetail(q)),
    governance.threadDetail !== undefined
      ? quiet(() => (governance.threadDetail as (id: string) => Promise<unknown>)(q))
      : Promise.resolve(undefined),
    quiet(() => governance.listRuns({ actor: q, first: limit })),
    quiet(() => governance.listRuns({ agent: q, first: limit })),
  ]);

  if (run) {
    push({
      title: `Run ${q}`,
      subtitle: [run.run.agentName, run.run.status, run.run.actorRef].filter(Boolean).join(' · '),
      href: runHref(q),
    });
  }
  if (thread) {
    push({ title: `Thread ${q}`, href: `${mount}#threads/${encodeURIComponent(q)}` });
  }
  for (const list of [byActor, byAgent]) {
    for (const row of list?.items ?? []) {
      push({
        title: `${row.agentName ?? 'run'} · ${row.status}`,
        subtitle: `${row.actorRef} · ${row.startedAt}`,
        href: runHref(row.runId),
      });
    }
  }
  return hits;
}

/** The `switcher` and `search` fields of the shell's data block, or `{}` when nothing to show. */
export async function switcherShellConfig(
  app: SwitcherAppLike,
  apiBase: string,
): Promise<{ switcher?: { endpoint: string; others: number }; search?: { endpoint: string } }> {
  let registry: Awaited<ReturnType<typeof readAgoraConsoles>>;
  try {
    registry = await readAgoraConsoles(app);
  } catch {
    return {};
  }
  if (registry === null) return {};
  const base = apiBase === '/' ? '' : apiBase;
  const others = countOtherConsoles(registry, AGENT_CONSOLE_ID);
  const searchable = registry.entries.some((entry) => typeof entry.search === 'function');
  return {
    ...(others > 0 ? { switcher: { endpoint: `${base}/governance/consoles`, others } } : {}),
    ...(searchable ? { search: { endpoint: `${base}/governance/consoles/search` } } : {}),
  };
}
