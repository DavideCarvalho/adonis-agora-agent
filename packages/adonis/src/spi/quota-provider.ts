import type { Actor } from '../types.js';

/** The span a quota window counts over, in UTC. */
export type QuotaPeriod = 'day' | 'month';

/** One budget window: what was spent in it, and the ceiling when there is one. */
export interface QuotaWindow {
  period: QuotaPeriod;
  /**
   * Tokens used in the window. Absent → the budget does not count tokens (a USD-only spend cap, such
   * as an AI gateway's) — never a fabricated `0`.
   */
  usedTokens?: number;
  /** Absent → no token ceiling on this window. */
  limitTokens?: number;
  usedUsd: number;
  /** Absent → no spend ceiling on this window. */
  limitUsd?: number;
  /** ISO-8601 instant the window starts over (next UTC midnight, first of next month). */
  resetsAt?: string;
  /**
   * The soft limit: the share of a ceiling (`0..1`, e.g. `0.8`) past which a client should warn
   * that the budget is running out. Absent → no warning for this window.
   */
  warnAt?: number;
}

/** Which window stopped the actor, when one did. */
export interface QuotaBlock {
  period: QuotaPeriod;
  /** Words a client can show ("Monthly AI budget reached"). */
  reason?: string;
}

/** A window past its soft limit ({@link QuotaWindow.warnAt}) but not exhausted. */
export interface QuotaWarning {
  period: QuotaPeriod;
  /** How much of the window's ceiling is used, `0..1` (the larger of spend and tokens). */
  ratio: number;
  /** Words a client can show ("80% of your monthly AI budget used"). */
  reason?: string;
}

/** What `GET <base>/quota` answers. */
export interface QuotaReport {
  windows: QuotaWindow[];
  /** Present when a window is exhausted — a send will be refused until it resets. */
  blocked?: QuotaBlock;
  /**
   * Present when a window crossed its `warnAt` and none is exhausted — the fullest one. A client
   * may also derive it from the windows ({@link quotaWarning}); the server's wins.
   */
  warning?: QuotaWarning;
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
    const tokensOut =
      window.limitTokens !== undefined && (window.usedTokens ?? 0) >= window.limitTokens;
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

/** How much of `window`'s ceilings is used, `0..1+` (the larger of spend and tokens), or `null`. */
export function quotaUsedRatio(window: QuotaWindow): number | null {
  const ratios: number[] = [];
  if (window.limitUsd !== undefined && window.limitUsd > 0) {
    ratios.push(window.usedUsd / window.limitUsd);
  }
  if (
    window.limitTokens !== undefined &&
    window.limitTokens > 0 &&
    window.usedTokens !== undefined
  ) {
    ratios.push(window.usedTokens / window.limitTokens);
  }
  return ratios.length === 0 ? null : Math.max(...ratios);
}

/**
 * The fullest window past its `warnAt`, as a {@link QuotaWarning} — `undefined` when none is, or
 * when one is exhausted (that is `blocked`, not a warning).
 */
export function quotaWarning(windows: readonly QuotaWindow[]): QuotaWarning | undefined {
  if (exhaustedWindow(windows) !== undefined) return undefined;
  let fullest: QuotaWarning | undefined;
  for (const window of windows) {
    if (window.warnAt === undefined) continue;
    const ratio = quotaUsedRatio(window);
    if (ratio === null || ratio < window.warnAt) continue;
    if (fullest === undefined || ratio > fullest.ratio) {
      fullest = { period: window.period, ratio };
    }
  }
  return fullest;
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
