import type { CostSource } from '../spi/agent-store.js';
import {
  type AgentPricingStore,
  estimateCost,
  type ModelPriceInput,
  resolveModelPrice,
} from '../spi/pricing-store.js';
import type { MessageUsage } from '../types.js';
import {
  awsPartitionOfRegion,
  bedrockPriceCandidates,
  builtinBedrockPrice,
  isBedrockModel,
  parseBedrockModelId,
} from './bedrock.js';
import {
  type BootPricingLog,
  CATALOG_TIMEOUT_MS,
  ensureModelPricing,
  normalizePriceEntries,
  type PriceCatalogOptions,
} from './boot-pricing.js';
import { lookupModelsDevPricesEach, modelsDevRefsFor } from './models-dev.js';

/**
 * The cost a usage row persists: the provider's figure (`'provider'`), else the estimate off the
 * model's price row (`'estimate'`), else nothing (`cost_usd` NULL). The one rule every engine
 * records usage by, so the ledger, a USD quota and the message carry the same figure.
 */
export function resolveUsageCost(
  usage: MessageUsage,
  reportedCostUsd: number | undefined,
  price: ModelPriceInput | undefined,
): { costUsd?: number; costSource?: CostSource } {
  if (reportedCostUsd !== undefined) return { costUsd: reportedCostUsd, costSource: 'provider' };
  if (price === undefined) return {};
  return { costUsd: estimateCost(usage, { ...price, effectiveFrom: '' }), costSource: 'estimate' };
}

/** A model to price, as an engine knows it. */
export interface PricedModelRef {
  /** The id usage is recorded under. */
  modelId: string;
  /** Its provider family (`amazon-bedrock`, `openai`, `openrouter`, …), when known. */
  provider?: string;
  /**
   * Other ids the same model is known by, tried after `modelId` (e.g. the bare model id of a
   * `provider/model` label, or the Bedrock id behind a gateway's alias).
   */
  aliases?: readonly string[];
}

export interface ModelPriceResolverOptions {
  /** The configured pricing store (`pricingStore`). Omit → prices resolve in memory only. */
  pricingStore?: AgentPricingStore | undefined;
  /** `priceCatalog` in `config/agent.ts`; `false` → no app prices, never fetch models.dev. */
  catalog?: PriceCatalogOptions | false | undefined;
  log?: BootPricingLog;
  /** How long the store's current prices are reused before they are read again. Default 60s. */
  cacheMs?: number;
}

const DEFAULT_CACHE_MS = 60_000;

/**
 * The price of a model an engine only learns about at run time (OpenCode reports the model each step
 * ran on), resolved the way boot pricing does it for configured models:
 *
 * 1. the pricing store's current row (by the id, then its normalized Bedrock candidates);
 * 2. once per model and process, the boot seed (`ensureModelPricing`): the app's
 *    `priceCatalog.prices`, then the built-in GovCloud Bedrock table, then models.dev — written to
 *    the store as a row, so the dashboard and a later run read the same price;
 * 3. without a pricing store, the same three sources, kept in memory.
 *
 * Never throws: pricing is bookkeeping, and an unpriced step is recorded without a cost.
 */
export class ModelPriceResolver {
  private rows: Map<string, ModelPriceInput> | undefined;
  private rowsAt = 0;
  private readonly seeded = new Map<string, Promise<ModelPriceInput | undefined>>();

  constructor(private readonly options: ModelPriceResolverOptions = {}) {}

  async priceFor(model: PricedModelRef): Promise<ModelPriceInput | undefined> {
    const ids = [...new Set([model.modelId, ...(model.aliases ?? [])])].filter(Boolean);
    try {
      const found = matchIn(await this.currentRows(), ids);
      if (found !== undefined) return found;
      const key = `${model.provider ?? ''}|${ids.join('|')}`;
      let seeding = this.seeded.get(key);
      if (seeding === undefined) {
        seeding = this.seed(ids, model.provider);
        this.seeded.set(key, seeding);
      }
      return await seeding;
    } catch {
      return undefined;
    }
  }

  private catalog(): PriceCatalogOptions | false {
    const catalog = this.options.catalog;
    if (catalog !== undefined) return catalog;
    // As boot pricing: no network catalog in tests unless the app asked for one.
    return env('NODE_ENV') === 'test' ? { modelsDev: false } : {};
  }

  private async currentRows(force = false): Promise<Map<string, ModelPriceInput>> {
    const store = this.options.pricingStore;
    if (store === undefined) return new Map();
    const ttl = this.options.cacheMs ?? DEFAULT_CACHE_MS;
    if (force || this.rows === undefined || Date.now() - this.rowsAt > ttl) {
      const rows = await store.listCurrentPrices();
      this.rows = new Map(rows.map((row) => [row.modelId, row]));
      this.rowsAt = Date.now();
    }
    return this.rows;
  }

  private async seed(ids: string[], provider: string | undefined) {
    const store = this.options.pricingStore;
    const catalog = this.catalog();
    if (store === undefined) return this.inMemory(ids, provider, catalog);
    // A label that wraps a Bedrock id (`amazon-bedrock/us-gov.…`) does not say its partition, so it
    // would be looked up as a commercial model: only the Bedrock-shaped ids are seeded then.
    const bedrock = ids.filter((id) => parseBedrockModelId(id) !== undefined);
    const seedIds = bedrock.length > 0 ? bedrock : ids;
    // The boot seed, for this model only. Its "no cost will be recorded" warning names every id it
    // was given, so it is held back until it is known that none of them got a price.
    const warnings: string[] = [];
    await ensureModelPricing({
      models: seedIds.map((modelId) => ({
        modelId,
        ...(provider !== undefined ? { provider } : {}),
        reportsCost: false,
      })),
      pricingStore: store,
      catalog,
      log: {
        info: (message) => this.options.log?.info(message),
        warn: (message) => warnings.push(message),
      },
    });
    const found = matchIn(await this.currentRows(true), ids);
    if (found === undefined) for (const message of warnings) this.options.log?.warn(message);
    return found;
  }

  /** No pricing store: the app's prices, the built-in Bedrock table, then models.dev. */
  private async inMemory(
    ids: string[],
    provider: string | undefined,
    catalog: PriceCatalogOptions | false,
  ): Promise<ModelPriceInput | undefined> {
    const options = catalog === false ? undefined : catalog;
    const app = matchIn(normalizePriceEntries(options?.prices ?? [], this.options.log), ids);
    if (app !== undefined) return app;
    const region = options?.region ?? env('AWS_REGION') ?? env('AWS_DEFAULT_REGION');
    const bedrock = ids.filter((id) => isBedrockModel(id, provider));
    const partition =
      bedrock.map((id) => parseBedrockModelId(id)?.partition).find((p) => p !== undefined) ??
      (bedrock.length > 0 ? awsPartitionOfRegion(region) : undefined);
    if (partition !== undefined && partition !== 'aws') {
      // Never models.dev here: its Bedrock prices are the commercial ones.
      for (const id of bedrock) {
        const price = builtinBedrockPrice(id, partition);
        if (price !== undefined) return { ...price, modelId: ids[0] as string };
      }
      return undefined;
    }
    if (options === undefined || options.modelsDev === false) return undefined;
    const { prices: _p, region: _r, modelsDev: _m, ...modelsDev } = options;
    const refs = [...new Set(ids.flatMap((id) => modelsDevRefsFor(id, provider)))];
    const [price] = await lookupModelsDevPricesEach(
      [refs],
      modelsDev.signal !== undefined
        ? modelsDev
        : { ...modelsDev, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) },
    );
    return price !== undefined ? { ...price, modelId: ids[0] as string } : undefined;
  }
}

/** The first price for any of `ids`: exact, then its normalized Bedrock candidates. */
function matchIn(
  prices: ReadonlyMap<string, ModelPriceInput>,
  ids: readonly string[],
): ModelPriceInput | undefined {
  for (const id of ids) {
    const exact = prices.get(id);
    if (exact !== undefined) return exact;
  }
  const rows = new Map([...prices].map(([id, p]) => [id, { ...p, effectiveFrom: '' }]));
  for (const id of ids) {
    const price = resolveModelPrice(rows, id);
    if (price !== undefined) return price;
  }
  for (const id of ids) {
    for (const candidate of bedrockPriceCandidates(id)) {
      const price = prices.get(candidate);
      if (price !== undefined) return price;
    }
  }
  return undefined;
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}
