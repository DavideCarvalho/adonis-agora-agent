import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentPendingApprovalsCountProvider,
  agentPendingApprovalsTableProvider,
  agentRecentRunsTableProvider,
  agentRecentThreadsTableProvider,
  agentRecentToolCallsTableProvider,
  agentRunsByAgentTableProvider,
  agentRunsDurationProvider,
  agentRunsFailedProvider,
  agentRunsSuccessRateProvider,
  agentRunsTotalProvider,
  agentRunsTrendProvider,
  agentSpendByActorProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentTokensTotalProvider,
  agentToolStatsTableProvider,
  agentUsageTrendProvider,
} from './agent-governance-providers.js';
import { type AgentDashboardOptions, agentDashboard } from './dashboard.js';
import {
  agentActiveRunsProvider,
  agentDelegationsOverTimeProvider,
  agentRecentApprovalsProvider,
  agentRecentDelegationsProvider,
  agentRecentRunsProvider,
  agentRecentToolCallsProvider,
  agentRunsOverTimeProvider,
  agentTokensOverTimeProvider,
  agentTokenUsageProvider,
  agentToolCallSuccessRateProvider,
  agentToolCallsOverTimeProvider,
} from './data-providers.js';
import {
  ragChunksProvider,
  ragRetrievalsProvider,
  ragTrendProvider,
  ragZeroHitRateProvider,
} from './rag-data-providers.js';
import type { DataProvider, TelescopeExtension } from './telescope-sdk.js';

/** The provider-name prefix this extension owns. A host contribution may not claim a name under it. */
const RESERVED_PROVIDER_PREFIX = 'agent.';

export interface AgentTelescopeExtensionOptions extends AgentDashboardOptions {
  /**
   * HOST-contributed data providers, registered alongside the built-in ones. A panel on this
   * dashboard cannot bind to a provider a DIFFERENT extension contributes — the registry namespaces
   * providers by owning extension (`agentTelescopeExtension`'s registered `name: 'agent'`), so a
   * host that wants its own panel on the "Agent" tab must register the provider THROUGH this option
   * to make this extension its owner. Name them under your own prefix (`myapp.rag.collections`);
   * anything starting with `agent.` is refused at construction time.
   */
  providers?: DataProvider[];
}

/**
 * The first-class `@adonis-agora/telescope` extension for `@adonis-agora/agent` (the "Agent" tab):
 * the overview dashboard (`dashboard.ts`) plus every data provider its panels bind to, from three
 * sources:
 *
 *  - **Entry-backed** (`data-providers.ts`) — aggregates the `agora:agent:*` events Telescope's
 *    generic diagnostics bridge records as `type: 'diagnostic'`, `tag: 'lib:agent'`. Ephemeral
 *    (bounded by Telescope's own retention/entry cap), but needs zero host configuration.
 *  - **Governance-backed** (`agent-governance-providers.ts`) — reads `AgentGovernanceQueries`, the
 *    authoritative, restart-surviving read-model `AgentProvider#boot()` already builds from
 *    `config.governanceQueries` (the SAME read-model the `/agent/governance/*` routes and the
 *    standalone `@adonis-agora/agent-dashboard` SPA use). Degrades to an empty-but-valid shape when
 *    governance isn't configured.
 *  - **RAG** (`rag-data-providers.ts`) — entry-backed like the first group, scoped to what
 *    `agent-loop.ts`'s inject-mode retrieval actually publishes (`{ runId, queryLength, count }`).
 *    See that file's header for the FULL list of Nest-reference RAG panels this does NOT cover
 *    (latency, scores, store/collection breakdown) and why.
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope'
 * import { agentTelescopeExtension } from '@adonis-agora/agent/telescope'
 *
 * export default defineConfig({ extensions: [agentTelescopeExtension()] })
 * ```
 *
 * ## No watcher, no `entryTypes` — a confirmed SDK constraint, not an oversight
 *
 * The Nest reference registers a LIVE watcher (`AgentTelescopeWatcher`/`RagTelescopeWatcher`) and two
 * bespoke entry types (`agent`, `agent-rag`), because Nest's `TelescopeExtension` supports a
 * `watchers` hook that lets an extension record entries under its OWN `type`. Checked against the
 * REAL, current `@adonis-agora/telescope` contract (`~/adonis-telescope/packages/core/src/extension/types.ts`,
 * mirrored in `telescope-sdk.ts`): `TelescopeExtension` exposes only `entryTypes` / `dashboards` /
 * `dataProviders` — no `watchers` field exists AT ALL. Every `agora:agent:*` event (including
 * `retrieved`) is captured by Telescope's ONE generic `DiagnosticsWatcher`, which ALWAYS records
 * every library's events under the same `type: 'diagnostic'` — an extension has no way to make its
 * own entries land under a different `type`, so contributing `entryTypes: () => [{ id: 'agent', ... }]`
 * would add a nav filter that never matches anything real. Same reasoning `@adonis-agora/media`'s and
 * `@adonis-agora/durable`'s telescope extensions already document for their own "no watcher"
 * comments — extended here to also cover why RAG can't get its own entry type either, which the Nest
 * reference relies on specifically so a busy retrieval stream can't crowd `run.*` entries out of the
 * shared window (see `rag-data-providers.ts`'s header for the consequence: RAG and everything else
 * share ONE capped `lib:agent` slice here).
 *
 * ## Governance wiring is a package-internal registry, not container DI
 *
 * The Nest reference resolves `AGENT_GOVERNANCE_QUERIES` from the host's DI container
 * (`ctx.moduleRef.get`). `ExtensionContext.container` exists on the Adonis side too, but
 * `AgentProvider#boot()` doesn't bind `AgentGovernanceQueries` into AdonisJS's container — see
 * `governance-registry.ts`'s header for exactly why, and for the smaller alternative it uses instead
 * (`AgentProvider#boot()` pushes the resolved read-model into a package-internal registry;
 * `agent-governance-providers.ts` reads it back out — no `ctx.container` involved).
 *
 * `threadHref`/`runHref` deep-link a table row's `threadId`/`runId` cell to a HOST's own thread/run
 * viewer — passed straight through to {@link agentDashboard}. `providers`/`sections` let a host
 * append its own panels to this dashboard (see {@link AgentTelescopeExtensionOptions.providers} and
 * `AgentDashboardOptions.sections`).
 */
export function agentTelescopeExtension(
  opts: AgentTelescopeExtensionOptions = {},
): TelescopeExtension {
  const hostProviders = opts.providers ?? [];
  const reserved = hostProviders.filter((provider) =>
    provider.name.startsWith(RESERVED_PROVIDER_PREFIX),
  );
  if (reserved.length > 0) {
    throw new Error(
      `agentTelescopeExtension: host-contributed data providers may not use the reserved "${RESERVED_PROVIDER_PREFIX}" prefix — ` +
        `rename ${reserved.map((provider) => `"${provider.name}"`).join(', ')} to your own namespace.`,
    );
  }
  const dashboardOpts: AgentDashboardOptions = {
    ...(opts.runHref !== undefined ? { runHref: opts.runHref } : {}),
    ...(opts.threadHref !== undefined ? { threadHref: opts.threadHref } : {}),
    ...(opts.sections !== undefined ? { sections: opts.sections } : {}),
  };
  return {
    name: 'agent',
    dashboards: () => [agentDashboard(dashboardOpts)],
    dataProviders: () => [
      // Entry-backed (data-providers.ts).
      agentActiveRunsProvider(),
      agentTokenUsageProvider(),
      agentToolCallSuccessRateProvider(),
      agentRunsOverTimeProvider(),
      agentTokensOverTimeProvider(),
      agentRecentRunsProvider(),
      agentToolCallsOverTimeProvider(),
      agentRecentToolCallsProvider(),
      agentRecentApprovalsProvider(),
      agentDelegationsOverTimeProvider(),
      agentRecentDelegationsProvider(),
      // Governance-backed (agent-governance-providers.ts).
      agentSpendTotalProvider(),
      agentTokensTotalProvider(),
      agentSpendByModelProvider(),
      agentModelSpendTableProvider(),
      agentUsageTrendProvider(),
      agentActorSpendTableProvider(),
      agentSpendByActorProvider(),
      agentRunsTotalProvider(),
      agentRunsSuccessRateProvider(),
      agentRunsFailedProvider(),
      agentRunsDurationProvider(),
      agentRunsByAgentTableProvider(),
      agentRunsTrendProvider(),
      agentRecentRunsTableProvider(),
      agentRecentToolCallsTableProvider(),
      agentRecentThreadsTableProvider(),
      agentPendingApprovalsCountProvider(),
      agentPendingApprovalsTableProvider(),
      agentToolStatsTableProvider(),
      // RAG (rag-data-providers.ts) — partial scope, see that file's header.
      ragRetrievalsProvider(),
      ragZeroHitRateProvider(),
      ragChunksProvider(),
      ragTrendProvider(),
      // Host-contributed.
      ...hostProviders,
    ],
  };
}
