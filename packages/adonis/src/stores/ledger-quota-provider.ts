import type { AgentStore, UsageTotals } from '../spi/agent-store.js';
import {
  exhaustedWindow,
  type QuotaPeriod,
  type QuotaProvider,
  type QuotaQuery,
  type QuotaReport,
  type QuotaWindow,
  quotaPeriodRange,
  quotaWarning,
} from '../spi/quota-provider.js';
import type { QuotaStore } from '../spi/quota-store.js';

/** Ceilings for one window. Either, both or neither. */
export interface QuotaWindowLimits {
  tokens?: number;
  usd?: number;
}

/** Ceilings per window — what `quotas.windows({ … })` takes. */
export interface QuotaLimits {
  day?: QuotaWindowLimits;
  month?: QuotaWindowLimits;
}

/** {@link LedgerQuotaProvider}'s tuning beyond the ceilings. */
export interface LedgerQuotaOptions {
  /**
   * The soft limit: the share of a ceiling (`0..1`) past which the report carries a `warning`.
   * Stamped on every window that has a ceiling. Omit → no warnings.
   */
  warnAt?: number;
  /**
   * Whether the USD windows count ESTIMATED cost (tokens × the price row, for a provider that reports
   * none, e.g. Bedrock, OpenAI or Anthropic direct) as well as provider-reported cost. Default `true`:
   * a USD ceiling that ignored estimates would read $0 and never block for every such provider, which
   * is a budget that does not enforce. Set `false` to budget on provider-reported (gateway) cost only.
   */
  countEstimatedCost?: boolean;
}

/**
 * A {@link QuotaProvider} over the usage ledger: a day window (tokens from `quotaToday`, spend from
 * `usageBetween` when the store has it), and a month window when the store implements
 * `usageBetween`. Ceilings come from `limits`; a {@link QuotaStore} passed alongside lends the day
 * window its own token ceiling when `limits.day.tokens` does not set one.
 *
 * Spend is what the usage rows recorded: the provider-reported cost of a gateway, plus the loop's
 * estimate for a provider that reports none (unless `countEstimatedCost: false`).
 */
export class LedgerQuotaProvider implements QuotaProvider {
  constructor(
    private readonly store: AgentStore,
    private readonly quota?: QuotaStore,
    private readonly limits: QuotaLimits = {},
    private readonly options: LedgerQuotaOptions = {},
  ) {}

  async report(query: QuotaQuery): Promise<QuotaReport> {
    const now = query.now ?? new Date();
    const actorRef = query.actor.id;
    const windows: QuotaWindow[] = [await this.dayWindow(actorRef, now)];
    if (this.store.usageBetween !== undefined) {
      const range = quotaPeriodRange('month', now);
      const used = await this.store.usageBetween(actorRef, range.fromDay, range.toDay);
      windows.push(this.window('month', used.usedTokens, this.usd(used), range.resetsAt));
    }
    const blocked = exhaustedWindow(windows);
    const warning = quotaWarning(windows);
    return {
      windows,
      ...(blocked !== undefined ? { blocked } : {}),
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  private async dayWindow(actorRef: string, now: Date): Promise<QuotaWindow> {
    const range = quotaPeriodRange('day', now);
    const used: UsageTotals =
      this.store.usageBetween !== undefined
        ? await this.store.usageBetween(actorRef, range.fromDay, range.toDay)
        : { ...(await this.store.quotaToday(actorRef, range.fromDay)), costUsd: 0 };
    const window = this.window('day', used.usedTokens, this.usd(used), range.resetsAt);
    if (this.quota !== undefined && window.limitTokens === undefined) {
      window.limitTokens = (await this.quota.check(actorRef, range.fromDay)).limitTokens;
    }
    return window;
  }

  /** The window's USD: every priced row, or (with `countEstimatedCost: false`) reported cost only. */
  private usd(used: UsageTotals): number {
    if (this.options.countEstimatedCost === false) {
      return Math.max(0, used.costUsd - (used.estimatedCostUsd ?? 0));
    }
    return used.costUsd;
  }

  private window(
    period: QuotaPeriod,
    usedTokens: number,
    usedUsd: number,
    resetsAt: string,
  ): QuotaWindow {
    const limits = this.limits[period] ?? {};
    return {
      period,
      usedTokens,
      ...(limits.tokens !== undefined ? { limitTokens: limits.tokens } : {}),
      usedUsd,
      ...(limits.usd !== undefined ? { limitUsd: limits.usd } : {}),
      resetsAt,
      ...(this.options.warnAt !== undefined &&
      (limits.tokens !== undefined || limits.usd !== undefined)
        ? { warnAt: this.options.warnAt }
        : {}),
    };
  }
}
