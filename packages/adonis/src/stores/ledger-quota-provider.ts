import type { AgentStore } from '../spi/agent-store.js';
import {
  exhaustedWindow,
  type QuotaPeriod,
  type QuotaProvider,
  type QuotaQuery,
  type QuotaReport,
  type QuotaWindow,
  quotaPeriodRange,
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

/**
 * A {@link QuotaProvider} over the usage ledger: a day window (tokens from `quotaToday`, spend from
 * `usageBetween` when the store has it), and a month window when the store implements
 * `usageBetween`. Ceilings come from `limits`; a {@link QuotaStore} passed alongside lends the day
 * window its own token ceiling when `limits.day.tokens` does not set one.
 *
 * Spend is what the usage rows recorded — the provider-reported cost of a gateway — so a USD ceiling
 * only binds where the provider reports cost.
 */
export class LedgerQuotaProvider implements QuotaProvider {
  constructor(
    private readonly store: AgentStore,
    private readonly quota?: QuotaStore,
    private readonly limits: QuotaLimits = {},
  ) {}

  async report(query: QuotaQuery): Promise<QuotaReport> {
    const now = query.now ?? new Date();
    const actorRef = query.actor.id;
    const windows: QuotaWindow[] = [await this.dayWindow(actorRef, now)];
    if (this.store.usageBetween !== undefined) {
      const range = quotaPeriodRange('month', now);
      const used = await this.store.usageBetween(actorRef, range.fromDay, range.toDay);
      windows.push(this.window('month', used.usedTokens, used.costUsd, range.resetsAt));
    }
    const blocked = exhaustedWindow(windows);
    return { windows, ...(blocked !== undefined ? { blocked } : {}) };
  }

  private async dayWindow(actorRef: string, now: Date): Promise<QuotaWindow> {
    const range = quotaPeriodRange('day', now);
    const used =
      this.store.usageBetween !== undefined
        ? await this.store.usageBetween(actorRef, range.fromDay, range.toDay)
        : { ...(await this.store.quotaToday(actorRef, range.fromDay)), costUsd: 0 };
    const window = this.window('day', used.usedTokens, used.costUsd, range.resetsAt);
    if (this.quota !== undefined && window.limitTokens === undefined) {
      window.limitTokens = (await this.quota.check(actorRef, range.fromDay)).limitTokens;
    }
    return window;
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
    };
  }
}
