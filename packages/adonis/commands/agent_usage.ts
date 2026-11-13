import { flags } from '@adonisjs/core/ace';
import { withActorLabels } from '../src/actor-labels.js';
import { AgentCommand, dayFlag, opt, today } from '../src/cli/agent_command.js';

const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;

/** The `--from`/`--to` day range every rollup takes (default: today). */
abstract class RangeCommand extends AgentCommand {
  @flags.string({ description: 'First UTC day, YYYY-MM-DD (default today)' })
  declare from?: string;

  @flags.string({ description: 'Last UTC day, YYYY-MM-DD (default --from)' })
  declare to?: string;

  @flags.string({ description: 'Only this organization (with tenancy on)' })
  declare tenant?: string;

  protected range() {
    const fromDay = dayFlag('from', this.from) ?? today();
    const toDay = dayFlag('to', this.to) ?? dayFlag('from', this.from) ?? today();
    return { fromDay, toDay };
  }
}

/** `agent:spend:show` — the console overview's token + cost rollup, by model, actor or feature. */
export class AgentSpendShow extends RangeCommand {
  static override commandName = 'agent:spend:show';
  static override description = 'Token and cost rollup over UTC days, by model, actor or feature';

  @flags.string({ description: 'Group by model (default), actor or feature' })
  declare by?: string;

  protected async execute() {
    const console = await this.governance();
    const gov = console.queries(opt(this.tenant));
    const range = this.range();
    const by = opt(this.by) ?? 'model';
    if (by === 'actor') {
      const rows = await withActorLabels(await gov.spendByActor(range), console.actorDirectory);
      return this.output(rows, (items) =>
        this.table(
          ['Actor', 'Requests', 'Tokens', 'Cost'],
          items.map((row) => [
            row.actorLabel ?? row.actorRef,
            row.requests,
            row.totalTokens,
            usd(row.costUsd),
          ]),
          'No spend in this range.',
        ),
      );
    }
    if (by === 'feature') {
      if (gov.spendByFeature === undefined) {
        return this.refuse('This governance adapter does not report spend by feature.');
      }
      const rows = await gov.spendByFeature(range);
      return this.output(rows, (items) =>
        this.table(
          ['Feature', 'Source', 'Requests', 'Input', 'Output', 'Cost'],
          items.map((row) => [
            row.feature,
            row.source,
            row.requests,
            row.inputTokens,
            row.outputTokens,
            usd(row.costUsd),
          ]),
          'No spend in this range.',
        ),
      );
    }
    if (by !== 'model') return this.refuse(`--by is model, actor or feature; got "${by}".`);
    const rows = await gov.spendByModel(range);
    return this.output(rows, (items) =>
      this.table(
        ['Model', 'Requests', 'Input', 'Output', 'Cost'],
        items.map((row) => [
          row.modelId,
          row.requests,
          row.inputTokens,
          row.outputTokens,
          usd(row.costUsd),
        ]),
        'No spend in this range.',
      ),
    );
  }
}

/** `agent:usage:trend` — the daily token + cost trend (the overview chart). */
export class AgentUsageTrend extends RangeCommand {
  static override commandName = 'agent:usage:trend';
  static override description = 'Daily token and cost trend over UTC days';

  protected async execute() {
    const gov = (await this.governance()).queries(opt(this.tenant));
    const rows = await gov.usageTrend(this.range());
    return this.output(rows, (items) =>
      this.table(
        ['Day', 'Tokens', 'Cost'],
        items.map((row) => [row.day, row.totalTokens, usd(row.costUsd)]),
        'No usage in this range.',
      ),
    );
  }
}

/** `agent:usage:breakdown` — spend per actor × feature ("cost by actor and by feature"). */
export class AgentUsageBreakdown extends RangeCommand {
  static override commandName = 'agent:usage:breakdown';
  static override description = 'Spend per actor and feature over UTC days or an instant window';

  @flags.string({
    description: 'Window start, an ISO instant (with --until, replaces --from/--to)',
  })
  declare since?: string;

  @flags.string({ description: 'Window end (exclusive), an ISO instant' })
  declare until?: string;

  @flags.string({ description: 'Only this actor ref' })
  declare actor?: string;

  @flags.string({ description: 'Only this feature' })
  declare feature?: string;

  @flags.boolean({
    description: 'Reprice unpriced rows against current prices (--no-reprice: recorded cost only)',
    default: true,
    showNegatedVariantInHelp: true,
  })
  declare reprice: boolean;

  protected async execute() {
    const console = await this.governance();
    const gov = console.queries(opt(this.tenant));
    if (gov.usageBreakdown === undefined) {
      return this.refuse('This governance adapter does not report a usage breakdown.');
    }
    const since = opt(this.since);
    const until = opt(this.until);
    if ((since === undefined) !== (until === undefined)) {
      return this.refuse('--since and --until go together: pass both, or neither (--from/--to).');
    }
    if (
      since !== undefined &&
      until !== undefined &&
      (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)))
    ) {
      return this.refuse('--since and --until must be ISO instants.');
    }
    const window =
      since !== undefined && until !== undefined ? { from: since, to: until } : this.range();
    const rows = await withActorLabels(
      await gov.usageBreakdown(window, {
        ...(opt(this.actor) !== undefined ? { actor: this.actor as string } : {}),
        ...(opt(this.feature) !== undefined ? { feature: this.feature as string } : {}),
        ...(this.reprice === false ? { reprice: false } : {}),
      }),
      console.actorDirectory,
    );
    return this.output(rows, (items) =>
      this.table(
        ['Actor', 'Feature', 'Source', 'Requests', 'Input', 'Output', 'Cost', 'Estimated'],
        items.map((row) => [
          row.actorLabel ?? row.actorRef,
          row.feature,
          row.source,
          row.requests,
          row.inputTokens,
          row.outputTokens,
          usd(row.costUsd),
          usd(row.estimatedCostUsd),
        ]),
        'No usage in this range.',
      ),
    );
  }
}

/** `agent:reliability:show` — run success/failure/cancel rates and the mean settled duration. */
export class AgentReliabilityShow extends AgentCommand {
  static override commandName = 'agent:reliability:show';
  static override description = 'Run success, failure and cancel rates';

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
    const stats = await gov.runReliability({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
    return this.output(stats, (value) => {
      this.pairs([
        ['Runs', value.runs],
        ['Completed', value.completed],
        ['Failed', value.failed],
        ['Cancelled', value.cancelled],
        ['Running', value.running],
        ['Success rate', pct(value.successRate)],
        ['Failure rate', pct(value.failureRate)],
        ['Cancel rate', pct(value.cancelRate)],
        ['Mean duration (ms)', value.avgDurationMs],
      ]);
      if (value.byAgent !== undefined && value.byAgent.length > 0) {
        this.table(
          ['Agent', 'Runs', 'Failed', 'Success'],
          value.byAgent.map((row) => [
            row.agentName ?? '—',
            row.runs,
            row.failed,
            pct(row.successRate),
          ]),
        );
      }
    });
  }
}

/** `agent:genui:show` — generative-UI telemetry (first-try success, errors, cost per turn). */
export class AgentGenuiShow extends RangeCommand {
  static override commandName = 'agent:genui:show';
  static override description = 'Generative UI telemetry over UTC days';

  protected async execute() {
    const gov = (await this.governance()).queries(opt(this.tenant));
    if (gov.genuiStats === undefined) {
      return this.refuse('This governance adapter does not record generative UI telemetry.');
    }
    const stats = await gov.genuiStats(this.range());
    return this.output(stats, (value) => {
      const { totals, costPerTurn } = value;
      this.pairs([
        ['UI calls', totals.calls],
        ['Turns', totals.turns],
        [
          'First-try rate',
          totals.firstTryRate === null ? null : `${(totals.firstTryRate * 100).toFixed(1)}%`,
        ],
        ['Retried', totals.retried],
        ['Failed', totals.failed],
        ['Cost', usd(totals.costUsd)],
        ['Avg cost per turn', usd(costPerTurn.avgUsd)],
      ]);
      if (value.errors.length > 0) {
        this.table(
          ['Tool', 'Category', 'Error', 'Count'],
          value.errors.map((row) => [row.toolName, row.category, row.message, row.count]),
        );
      }
    });
  }
}
