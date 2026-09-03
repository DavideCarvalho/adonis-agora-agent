import type { MessageUsage } from '../types.js';

/**
 * The WRITE side of the model pricing table the loop's cost fold prices token usage against. Cost is
 * `null` (not `0`) for an unpriced model, so an app seeds its models' per-1M rates once (and
 * re-`upsert`s when a provider changes prices). An adapter implements this — `LucidPricingStore`
 * (production, over the `agent_model_pricing` table) and `InMemoryPricingStore` (testing) ship. Wire
 * it in `config/agent.ts` via `pricingStore: pricingStores.lucid()`; use {@link seedModelPrices} for a
 * one-shot batch. Mirrors the reference `AgentPricingStore` contract exactly.
 */

/** A per-1M-token price for one model. Cache rates fall back to the input rate when omitted. */
export interface ModelPriceInput {
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  /** Per-1M price for cache-write (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheWritePricePer1m?: number;
  /** Per-1M price for cache-read (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheReadPricePer1m?: number;
}

/** A current price row as read back, with the ISO timestamp it took effect. */
export interface CurrentModelPrice extends ModelPriceInput {
  effectiveFrom: string;
}

export interface AgentPricingStore {
  /**
   * Set the current price for a model. Atomic supersede: the model's prior `is_current` row (if any)
   * is retired and this one is inserted as current, effective now — so the cost fold always joins to
   * exactly one live price per model, with no window where two rows race for `is_current`.
   */
  upsertModelPrice(input: ModelPriceInput): Promise<void>;
  /** The current price row per model (`is_current`), fetched ONCE per run for the loop's cost fold. */
  listCurrentPrices(): Promise<CurrentModelPrice[]>;
}

/** Seed (or refresh) a batch of model prices — one `upsertModelPrice` per row, in order. */
export async function seedModelPrices(
  store: AgentPricingStore,
  prices: ModelPriceInput[],
): Promise<void> {
  for (const price of prices) {
    await store.upsertModelPrice(price);
  }
}

/**
 * Token-ledger estimate for one turn against a pricing row: the uncached input at the input rate,
 * cache-write/cache-read tokens at their own rates (falling back to the input rate when unpriced),
 * plus output at the output rate. Reasoning tokens are a subset of output and are billed at the
 * output rate, so they don't change the estimate. Cache token counts are subsets of `inputTokens`,
 * so the uncached remainder is the difference. Pure — the SQL and in-memory adapters share it, so
 * every surface reports identical numbers.
 */
export function estimateCost(usage: MessageUsage, price: CurrentModelPrice): number {
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const uncachedInputTokens = usage.inputTokens - cacheWriteTokens - cacheReadTokens;
  return (
    (uncachedInputTokens / 1_000_000) * price.inputPricePer1m +
    (cacheWriteTokens / 1_000_000) * (price.cacheWritePricePer1m ?? price.inputPricePer1m) +
    (cacheReadTokens / 1_000_000) * (price.cacheReadPricePer1m ?? price.inputPricePer1m) +
    (usage.outputTokens / 1_000_000) * price.outputPricePer1m
  );
}

/**
 * The forms of a model id we will accept a price under, most specific first.
 *
 * Exists because the ledger and the price table are filled by two different parties. The ledger gets
 * what the PROVIDER reports (`finalStep.response.modelId`), and OpenAI answers a request for
 * `gpt-4o-mini` with the dated snapshot `gpt-4o-mini-2024-07-18`. The price table gets what an
 * OPERATOR typed — and every example in these docs, and every published rate card, uses the alias.
 * Matched by raw equality, those two never meet: the fold misses and the dashboard prints `$0.00`
 * next to a real token count.
 *
 * Only DATE-shaped suffixes are stripped, and only from the end. That is the conservative line: a
 * date suffix is unambiguously a snapshot of the same model, whereas a trailing `-002` or `-v2`
 * could be a genuinely different model with a different price. Mispricing silently is worse than
 * not pricing — so anything we are not sure about stays unpriced and stays visible.
 *
 * The exact id is always tried FIRST, so an operator who deliberately prices one snapshot
 * differently from its alias keeps that.
 */
export function modelPriceCandidates(modelId: string): string[] {
  const candidates: string[] = [modelId];

  const add = (candidate: string): void => {
    if (candidate.length > 0 && !candidates.includes(candidate)) candidates.push(candidate);
  };

  // `openai/gpt-4o-mini`, `bedrock/us.anthropic.claude-…` — the route prefix is addressing, not
  // identity. Same shape the dashboard's `formatModelLabel` drops for display.
  const withoutRoute = modelId.includes('/')
    ? modelId.slice(modelId.lastIndexOf('/') + 1)
    : modelId;
  const withoutRegion = withoutRoute.replace(/^[a-z]{2}[a-z-]*\.[a-z0-9]+\./, '');

  for (const base of [modelId, withoutRoute, withoutRegion]) {
    // OpenAI: `gpt-4o-mini-2024-07-18`. Anthropic: `claude-3-5-sonnet-20241022`.
    add(base.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, ''));
  }

  return candidates;
}

/**
 * The price to use for `modelId`, or `undefined` when the model is genuinely unpriced.
 *
 * `undefined` is the honest answer for "we don't know", and callers must keep it distinguishable
 * from zero: a run that cost nothing and a run nobody priced are different facts, and collapsing
 * them is what made a whole dashboard read `$0.00` while tokens were being burned.
 */
export function resolveModelPrice(
  pricing: ReadonlyMap<string, CurrentModelPrice>,
  modelId: string,
): CurrentModelPrice | undefined {
  for (const candidate of modelPriceCandidates(modelId)) {
    const price = pricing.get(candidate);
    if (price !== undefined) return price;
  }
  return undefined;
}
