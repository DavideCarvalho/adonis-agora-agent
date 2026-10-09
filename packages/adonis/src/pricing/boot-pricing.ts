import type { DescribedModel } from '../spi/model-provider.js';
import {
  type AgentPricingStore,
  type CurrentModelPrice,
  resolveModelPrice,
} from '../spi/pricing-store.js';
import { lookupModelsDevPrices, type ModelsDevOptions, modelsDevRefsFor } from './models-dev.js';

/** Where boot pricing logs. Both are one line each, at most once per boot. */
export interface BootPricingLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface EnsureModelPricingArgs {
  /** The configured models (`ModelProvider.describeModels()`). */
  models: readonly DescribedModel[];
  /** The bound pricing store; `undefined` → nothing to seed, every non-gateway model is unpriced. */
  pricingStore: AgentPricingStore | undefined;
  /** The models.dev catalog to seed missing rows from; `false` → never fetch. */
  catalog: ModelsDevOptions | false;
  log: BootPricingLog;
}

export interface EnsureModelPricingResult {
  /** Models a price row was written for, from models.dev. */
  seeded: string[];
  /** Models that will record a `null` cost: no gateway cost and no price row. */
  unpriced: string[];
}

const PREFIX = '[@adonis-agora/agent]';

/**
 * Make sure every configured model records a cost, and say so when one will not.
 *
 * A model needs nothing when its provider reports the real cost (a gateway: OpenRouter, the Vercel AI
 * Gateway) — that figure always wins. Every other model is priced off the pricing store, so a model
 * with no row there would record `cost_usd = NULL` on every turn, silently. For each such model the
 * current models.dev list price is written as its row — only when it has NONE, so a price an operator
 * set is never overwritten. Gateway models are seeded too, as the estimate a call that comes back
 * without a cost falls back to.
 *
 * A model still unpriced after that (models.dev does not list it, the catalog was unreachable, or no
 * pricing store is bound) gets one warning line naming it and the fix. Never throws: this runs at
 * boot, and pricing is bookkeeping, not a reason for the app to stay down.
 */
export async function ensureModelPricing(
  args: EnsureModelPricingArgs,
): Promise<EnsureModelPricingResult> {
  const models = dedupe(args.models);
  const seeded: string[] = [];
  let current = new Map<string, CurrentModelPrice>();
  let needing = models;

  if (args.pricingStore !== undefined) {
    try {
      const rows = await args.pricingStore.listCurrentPrices();
      current = new Map(rows.map((row) => [row.modelId, row]));
      needing = models.filter((model) => resolveModelPrice(current, model.modelId) === undefined);
    } catch (error) {
      args.log.warn(`${PREFIX} Could not read the pricing table at boot: ${messageOf(error)}`);
      needing = [];
    }

    if (args.catalog !== false && needing.length > 0) {
      try {
        const { prices } = await lookupModelsDevPrices(
          needing.map((model) => modelsDevRefsFor(model.modelId, model.provider)),
          args.catalog,
        );
        const effectiveFrom = new Date().toISOString();
        for (const price of prices) {
          if (current.has(price.modelId)) continue;
          await args.pricingStore.upsertModelPrice(price);
          current.set(price.modelId, { ...price, effectiveFrom });
        }
        for (const model of needing) {
          if (resolveModelPrice(current, model.modelId) !== undefined) seeded.push(model.modelId);
        }
        if (seeded.length > 0) {
          args.log.info(
            `${PREFIX} Seeded list prices from models.dev for ${seeded.join(', ')} — an estimate, ` +
              'used when the provider reports no cost. Set your own with `upsertModelPrice` to override.',
          );
        }
      } catch (error) {
        args.log.warn(`${PREFIX} Could not seed prices from models.dev: ${messageOf(error)}`);
      }
    }
  }

  const unpriced = models
    .filter((model) => !model.reportsCost)
    .filter((model) => resolveModelPrice(current, model.modelId) === undefined)
    .map((model) => model.modelId);
  if (unpriced.length > 0) {
    args.log.warn(
      `${PREFIX} No cost will be recorded for ${unpriced.join(', ')}: the provider reports no cost and ` +
        (args.pricingStore === undefined
          ? 'no `pricingStore` is configured. '
          : 'the pricing table has no row for it. ') +
        'Seed one with `seedModelPrices(store, [...])` / `seedPricesFromModelsDev(store, [...])`, ' +
        'or route through a gateway that reports cost (OpenRouter, Vercel AI Gateway).',
    );
  }
  return { seeded, unpriced };
}

function dedupe(models: readonly DescribedModel[]): DescribedModel[] {
  const seen = new Map<string, DescribedModel>();
  for (const model of models) if (!seen.has(model.modelId)) seen.set(model.modelId, model);
  return [...seen.values()];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
