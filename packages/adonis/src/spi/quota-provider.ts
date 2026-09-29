import type { Actor } from '../types.js';

/** The span a quota window counts over, in UTC. */
export type QuotaPeriod = 'day' | 'month';

/** One budget window: what was spent in it, and the ceiling when there is one. */
export interface QuotaWindow {
  period: QuotaPeriod;
  usedTokens: number;
  /** Absent → no token ceiling on this window. */
  limitTokens?: number;
  usedUsd: number;
  /** Absent → no spend ceiling on this window. */
  limitUsd?: number;
  /** ISO-8601 instant the window starts over (next UTC midnight, first of next month). */
  resetsAt?: string;
}

/** Which window stopped the actor, when one did. */
export interface QuotaBlock {
  period: QuotaPeriod;
  /** Words a client can show ("Monthly AI budget reached"). */
  reason?: string;
}

/** What `GET <base>/quota` answers. */
export interface QuotaReport {
  windows: QuotaWindow[];
  /** Present when a window is exhausted — a send will be refused until it resets. */
  blocked?: QuotaBlock;
}

export interface QuotaQuery {
  actor: Actor;
  /** The instant to report for; defaults to now. */
  now?: Date;
}

/**
 * The actor's budget across windows — the read behind `GET <path>/quota` and, when `quota` in
 * `config/agent.ts` resolves to one (`quotas.windows({ … })`, or your own), the gate a send passes: a
 * report with `blocked` refuses the turn with `429` before it starts.
 *
 * Without one the provider reports from the usage ledger (`LedgerQuotaProvider`), informational
 * only. A host with its own budget (an AI-gateway spend cap, a plan's monthly allowance) implements
 * this. The shape is `@dudousxd/nestjs-agent-core`'s, copied.
 */
export interface QuotaProvider {
  report(query: QuotaQuery): Promise<QuotaReport>;
}

/** The first window whose token or spend ceiling is reached, as a {@link QuotaBlock}. */
export function exhaustedWindow(windows: readonly QuotaWindow[]): QuotaBlock | undefined {
  for (const window of windows) {
    const tokensOut = window.limitTokens !== undefined && window.usedTokens >= window.limitTokens;
    const spendOut = window.limitUsd !== undefined && window.usedUsd >= window.limitUsd;
    if (tokensOut || spendOut) {
      return {
        period: window.period,
        reason: `${window.period === 'day' ? 'Daily' : 'Monthly'} ${spendOut ? 'spend' : 'token'} limit reached`,
      };
    }
  }
  return undefined;
}

/** The UTC day range (`YYYY-MM-DD`, inclusive) and reset instant of `period` around `now`. */
export function quotaPeriodRange(
  period: QuotaPeriod,
  now: Date,
): { fromDay: string; toDay: string; resetsAt: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.toISOString().slice(0, 10);
  if (period === 'day') {
    const next = new Date(Date.UTC(year, month, now.getUTCDate() + 1));
    return { fromDay: day, toDay: day, resetsAt: next.toISOString() };
  }
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return {
    fromDay: first.toISOString().slice(0, 10),
    toDay: last.toISOString().slice(0, 10),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

/** Is this a {@link QuotaProvider} (rather than a daily `QuotaStore`)? */
export function isQuotaProvider(value: unknown): value is QuotaProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as QuotaProvider).report === 'function'
  );
}

/** A send refused because a budget window is exhausted — the chat route's `429 quota_exceeded`. */
export class QuotaBlockedError extends Error {
  constructor(
    readonly period: QuotaPeriod,
    message: string,
  ) {
    super(message);
    this.name = 'QuotaBlockedError';
  }
}
