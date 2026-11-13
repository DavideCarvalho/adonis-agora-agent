import type { ResolvedAgentTenancy } from './agora/tenancy.js';
import { resolveConsoleTenantScope } from './dashboard/tenant-scope.js';
import type { ActorDirectory } from './spi/actor-directory.js';
import type { AgentGovernanceQueries } from './spi/governance-queries.js';
import type { AgentPricingStore } from './spi/pricing-store.js';

/** Why the operator surface cannot answer: the read-model or store it needs is not configured. */
export class GovernanceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceUnavailableError';
  }
}

/**
 * What the governance console reads and writes, as the provider resolved it at boot: the read-model
 * (`governanceQueries`), the pricing store, the actor directory and the tenancy. Bound in the
 * container (`app.container.make(AgentGovernanceConsole)`) so the `agent:*` ace commands work on the
 * very instances the `/agent/governance/*` routes and the MCP dev tools use.
 *
 * The routes scope each read to what the console's `authorize` granted the viewer; a command runs
 * with shell access to the app, so it reads every organization unless `--tenant` narrows it.
 */
export class AgentGovernanceConsole {
  constructor(
    private readonly options: {
      queries: AgentGovernanceQueries | undefined;
      pricing: AgentPricingStore | undefined;
      actorDirectory: ActorDirectory | null;
      tenancy: ResolvedAgentTenancy;
    },
  ) {}

  get actorDirectory(): ActorDirectory | null {
    return this.options.actorDirectory;
  }

  get tenancyEnabled(): boolean {
    return this.options.tenancy.enabled;
  }

  /**
   * The read-model, narrowed to `tenant` when one is named. Throws {@link GovernanceUnavailableError}
   * with no read-model (`governanceQueries: false`), with a tenant while tenancy is off, or when the
   * read-model cannot be scoped by organization.
   */
  queries(tenant?: string): AgentGovernanceQueries {
    const queries = this.options.queries;
    if (queries === undefined) {
      throw new GovernanceUnavailableError(
        'The agent has no governance read-model (`governanceQueries` is off in config/agent.ts).',
      );
    }
    if (tenant === undefined || tenant === '') return queries;
    if (!this.options.tenancy.enabled) {
      throw new GovernanceUnavailableError(
        'Tenancy is off for the agent: there is no organization to narrow to (drop --tenant).',
      );
    }
    const { scope } = resolveConsoleTenantScope({
      granted: '*',
      own: { mode: 'all' },
      selected: tenant,
      nullRows: this.options.tenancy.nullRows,
    });
    if (scope === undefined) return queries;
    const view = queries.forTenants?.(scope);
    if (view === undefined) {
      throw new GovernanceUnavailableError(
        'The bound governance read-model cannot be scoped by organization (no forTenants).',
      );
    }
    return view;
  }

  /** The pricing store; throws {@link GovernanceUnavailableError} when none is bound. */
  pricing(): AgentPricingStore {
    const pricing = this.options.pricing;
    if (pricing === undefined)
      throw new GovernanceUnavailableError('No pricing store is configured.');
    return pricing;
  }
}
