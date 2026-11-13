import { args, flags } from '@adonisjs/core/ace';
import { AgentRegistry } from '../src/agent-registry.js';
import { AgentCommand, dayFlag, opt } from '../src/cli/agent_command.js';
import { PRICE_INPUT_SHAPE, parseModelPriceInput } from '../src/pricing/price-input.js';
import type { Actor } from '../src/types.js';

const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;

/** `--actor`, `--role`, `--tenant`: the actor a per-actor read is answered for. */
abstract class AsActorCommand extends AgentCommand {
  @flags.string({ description: 'The actor ref to answer for' })
  declare actor?: string;

  @flags.array({ description: 'A role the actor holds (repeat for more)' })
  declare role?: string[];

  @flags.string({ description: "The actor's organization (with tenancy on)" })
  declare tenant?: string;

  protected asActor(): Actor {
    const id = opt(this.actor);
    if (id === undefined) return this.refuse('Name the actor: --actor <ref>.');
    const roles = (this.role ?? []).flatMap((role) => role.split(',')).filter(Boolean);
    const tenant = opt(this.tenant);
    return {
      id,
      ...(roles.length > 0 ? { roles } : {}),
      ...(tenant !== undefined ? { tenantRef: tenant } : {}),
    };
  }
}

/** `agent:quota:show --actor <ref>` — an actor's budget windows (`GET <path>/quota` for them). */
export class AgentQuotaShow extends AsActorCommand {
  static override commandName = 'agent:quota:show';
  static override description = "Show an actor's budget windows and what was spent in each";

  protected async execute() {
    const report = await (await this.agentService()).quotaReport(this.asActor());
    return this.output(report, (value) => {
      this.table(
        ['Window', 'Tokens', 'Token limit', 'Spent', 'Spend limit', 'Resets'],
        value.windows.map((window) => [
          window.period,
          window.usedTokens ?? '—',
          window.limitTokens ?? '—',
          usd(window.usedUsd),
          window.limitUsd === undefined ? '—' : usd(window.limitUsd),
          window.resetsAt ?? '—',
        ]),
        'No budget windows.',
      );
      if (value.blocked !== undefined)
        this.logger.warning(`Blocked: ${value.blocked.period} window`);
    });
  }
}

/** `agent:tools:list --actor <ref>` — the tool catalog an actor reaches through an agent. */
export class AgentToolsList extends AsActorCommand {
  static override commandName = 'agent:tools:list';
  static override description = 'List the tools an actor can reach through an agent';

  @flags.string({ description: 'The agent (default: the default agent; * for every agent)' })
  declare agent?: string;

  protected async execute() {
    const service = await this.agentService();
    const actor = this.asActor();
    const agent = opt(this.agent);
    // An unknown name is refused, not answered with the widest catalog (the route's `404`).
    if (agent !== undefined && agent !== '*') {
      const agents = await this.app.container.make(AgentRegistry);
      if (agents.get(agent) === undefined) return this.refuse(`No agent named "${agent}".`);
    }
    const rows =
      agent === '*'
        ? await service.toolCatalogForAllAgents(actor)
        : await service.toolCatalog(actor, agent);
    return this.output(rows, (items) =>
      this.table(
        ['Tool', 'Kind', 'Label'],
        items.map((tool) => [tool.name, tool.kind, tool.presentation?.label ?? '']),
        'No tools.',
      ),
    );
  }
}

/** `agent:tools:stats` — per-tool calls, failures, rejections and latency (the Tools tab). */
export class AgentToolsStats extends AgentCommand {
  static override commandName = 'agent:tools:stats';
  static override description = 'Per-tool calls, failures, rejections and latency';

  @flags.string({ description: 'First UTC day, YYYY-MM-DD (default: all time)' })
  declare from?: string;

  @flags.string({ description: 'Last UTC day, YYYY-MM-DD' })
  declare to?: string;

  @flags.string({ description: 'Only this organization (with tenancy on)' })
  declare tenant?: string;

  protected async execute() {
    const gov = (await this.governance()).queries(opt(this.tenant));
    const from = dayFlag('from', this.from);
    const to = dayFlag('to', this.to);
    const rows = await gov.perToolStats({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    const ms = (value: number | null | undefined) =>
      value === null || value === undefined ? '—' : `${Math.round(value)}ms`;
    return this.output(rows, (items) =>
      this.table(
        ['Tool', 'Type', 'Calls', 'Failed', 'Rejected', 'Avg', 'p50', 'p95'],
        items.map((row) => [
          row.toolName,
          row.toolType,
          row.calls,
          row.failed,
          row.rejected,
          ms(row.avgDurationMs),
          ms(row.p50ExecutionMs),
          ms(row.p95ExecutionMs),
        ]),
        'No tool calls.',
      ),
    );
  }
}

/** `agent:pricing:list` — every model's current per-1M rates (the Pricing tab). */
export class AgentPricingList extends AgentCommand {
  static override commandName = 'agent:pricing:list';
  static override description = "List every model's current per-1M token prices";

  protected async execute() {
    const rows = await (await this.governance()).pricing().listCurrentPrices();
    return this.output(rows, (items) =>
      this.table(
        ['Model', 'Input /1M', 'Output /1M', 'Cache write /1M', 'Cache read /1M', 'Since'],
        items.map((row) => [
          row.modelId,
          row.inputPricePer1m,
          row.outputPricePer1m,
          row.cacheWritePricePer1m ?? '—',
          row.cacheReadPricePer1m ?? '—',
          row.effectiveFrom,
        ]),
        'No prices.',
      ),
    );
  }
}

/**
 * `agent:pricing:set <model> --input <usd> --output <usd>` — set a model's current price (atomic
 * supersede, the console's Pricing form). Replacing an existing price asks first.
 */
export class AgentPricingSet extends AgentCommand {
  static override commandName = 'agent:pricing:set';
  static override description = "Set a model's per-1M token prices";

  @args.string({ description: 'Model id' })
  declare modelId: string;

  @flags.number({ flagName: 'input', description: 'USD per 1M input tokens' })
  declare inputPrice?: number;

  @flags.number({ flagName: 'output', description: 'USD per 1M output tokens' })
  declare outputPrice?: number;

  @flags.number({ description: 'USD per 1M cache-write tokens (default: the input rate)' })
  declare cacheWrite?: number;

  @flags.number({ description: 'USD per 1M cache-read tokens (default: the input rate)' })
  declare cacheRead?: number;

  @flags.boolean({ description: 'Skip the confirmation when a price is replaced' })
  declare force: boolean;

  @flags.boolean({ description: 'Show what would change, change nothing' })
  declare dryRun: boolean;

  protected async execute() {
    const pricing = (await this.governance()).pricing();
    const price = parseModelPriceInput({
      modelId: this.modelId,
      inputPricePer1m: this.inputPrice,
      outputPricePer1m: this.outputPrice,
      cacheWritePricePer1m: this.cacheWrite,
      cacheReadPricePer1m: this.cacheRead,
    });
    if (price === null) {
      return this.refuse(`A price needs a model, --input and --output (${PRICE_INPUT_SHAPE}).`);
    }
    const current =
      (await pricing.listCurrentPrices()).find((row) => row.modelId === price.modelId) ?? null;
    const result = { dryRun: this.dryRun === true, previous: current, price };
    if (this.dryRun) {
      return this.output(result, () => {
        this.logger.info(
          `${current === null ? 'Would set' : 'Would replace'} the price of ${price.modelId}: input ${price.inputPricePer1m}, output ${price.outputPricePer1m} per 1M.`,
        );
      });
    }
    if (
      current !== null &&
      !(await this.confirmed(
        this.force,
        `Replace the price of ${price.modelId} (input ${current.inputPricePer1m}, output ${current.outputPricePer1m} per 1M)?`,
      ))
    ) {
      return this.refuse('Cancelled.');
    }
    await pricing.upsertModelPrice(price);
    return this.output(result, () => this.logger.success(`Price of ${price.modelId} set.`));
  }
}

/** `agent:tenants:list` — the organizations agent data belongs to (the console's picker). */
export class AgentTenantsList extends AgentCommand {
  static override commandName = 'agent:tenants:list';
  static override description = 'List the organizations that have agent data';

  protected async execute() {
    const console = await this.governance();
    if (!console.tenancyEnabled) return this.refuse('Tenancy is off for the agent.');
    const gov = console.queries();
    if (gov.listTenants === undefined) {
      return this.refuse('This governance adapter cannot list organizations.');
    }
    const ids = await gov.listTenants();
    return this.output(ids, (items) =>
      this.table(
        ['Organization'],
        items.map((id) => [id]),
        'No organizations.',
      ),
    );
  }
}
