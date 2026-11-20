import type { AgentPricingStore, CurrentModelPrice, ModelPriceInput } from '../index.js';

/**
 * A fully in-memory {@link AgentPricingStore} for unit tests and the offline demo. Keyed by
 * `modelId`, so an `upsert` supersedes the model's prior price (the same "one current row per model"
 * invariant the SQL adapter enforces). Omit a model to leave it unpriced — the loop then reports
 * `costUsd: null` for it (never a fabricated `0`).
 */
export class InMemoryPricingStore implements AgentPricingStore {
  private readonly prices = new Map<string, CurrentModelPrice>();

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    // A new current row, like the SQL adapter's supersede: written (and last changed) now.
    const now = new Date();
    this.prices.set(input.modelId, {
      modelId: input.modelId,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      effectiveFrom: now.toISOString(),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ...(input.cacheWritePricePer1m !== undefined
        ? { cacheWritePricePer1m: input.cacheWritePricePer1m }
        : {}),
      ...(input.cacheReadPricePer1m !== undefined
        ? { cacheReadPricePer1m: input.cacheReadPricePer1m }
        : {}),
    });
  }

  async listCurrentPrices(): Promise<CurrentModelPrice[]> {
    return [...this.prices.values()].map((price) => ({
      ...price,
      ...(price.createdAt ? { createdAt: new Date(price.createdAt) } : {}),
      ...(price.updatedAt ? { updatedAt: new Date(price.updatedAt) } : {}),
    }));
  }
}
