import type { DescribedModel } from '../spi/model-provider.js';
import {
  type AgentPricingStore,
  type CurrentModelPrice,
  type ModelPriceInput,
  resolveModelPrice,
} from '../spi/pricing-store.js';
import {
  type AwsPartition,
  awsPartitionOfRegion,
  bedrockPriceCandidates,
  builtinBedrockPrice,
  isBedrockModel,
  parseBedrockModelId,
} from './bedrock.js';
import {
  lookupModelsDevPricesEach,
  type ModelsDevOptions,
  modelsDevRefsFor,
} from './models-dev.js';

/** How long the boot check waits for the models.dev catalog when no `signal` is given. */
export const CATALOG_TIMEOUT_MS = 15_000;

/** Where boot pricing logs. Both are one line each, at most once per boot. */
export interface BootPricingLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * One app-supplied price, as a rate card states it. `input`/`output`/`cacheRead`/`cacheWrite` are in
 * `currency` per `unit` of tokens. Only USD is recorded (the ledger column is `cost_usd`); a row in
 * another currency is refused with a warning rather than recorded as dollars.
 */
export interface PriceCatalogEntry {
  /**
   * The model id the price is for. A Bedrock id matches by normalized candidates, so one entry for the
   * base id (`anthropic.claude-sonnet-4-5-20250929-v1:0`) or the profile id (`us-gov.anthropic.…`)
   * also prices the ARN a turn reports (`arn:aws-us-gov:bedrock:…:inference-profile/us-gov.anthropic.…`).
   */
  model: string;
  input: number;
  output: number;
  /** Cache-read (prompt-cache hit) input tokens. Omit → priced at `input`. */
  cacheRead?: number;
  /** Cache-write input tokens. Omit → priced at `input`. */
  cacheWrite?: number;
  /** Default `'USD'`, the only one accepted. */
  currency?: 'USD';
  /** Default `'1M tokens'`. */
  unit?: '1M tokens' | '1K tokens';
}

/** The `priceCatalog` option: where boot seeds missing price rows from. */
export interface PriceCatalogOptions extends ModelsDevOptions {
  /**
   * Prices the app supplies. Seeded at boot for any model that has NO row yet (an existing row is
   * never overwritten), and before models.dev or the built-in Bedrock table are consulted — so they
   * win over both. Use it for GovCloud / China Bedrock, negotiated rates, or a model models.dev lacks.
   */
  prices?: readonly PriceCatalogEntry[];
  /**
   * The AWS region Bedrock runs in, for a Bedrock model id that does not name one (a base or `us.`
   * profile id; an ARN or a `us-gov.` id already does). Omit → `AWS_REGION` / `AWS_DEFAULT_REGION`.
   * A GovCloud (`us-gov-*`) or China (`cn-*`) region is never seeded with models.dev's commercial price.
   */
  region?: string;
  /** `false` → never fetch models.dev (app prices and the built-in Bedrock table still apply). */
  modelsDev?: boolean;
}

export interface EnsureModelPricingArgs {
  /** The configured models (`ModelProvider.describeModels()`). */
  models: readonly DescribedModel[];
  /** The bound pricing store; `undefined` → nothing to seed, every non-gateway model is unpriced. */
  pricingStore: AgentPricingStore | undefined;
  /** Where to seed missing rows from; `false` → no app prices, never fetch models.dev. */
  catalog: PriceCatalogOptions | false;
  log: BootPricingLog;
}

export interface EnsureModelPricingResult {
  /** Models a price row was written for (from app prices, the built-in Bedrock table or models.dev). */
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
 * with no row there would record `cost_usd = NULL` on every turn, silently. For each such model a row
 * is written — only when it has NONE, so a price an operator set is never overwritten — from, in order:
 *
 * 1. the app's `priceCatalog.prices`;
 * 2. for a Bedrock model in GovCloud / China, the built-in table (`BEDROCK_BUILTIN_PRICES`) — never
 *    models.dev, whose Bedrock prices are the commercial ones;
 * 3. models.dev's current list price.
 *
 * The row is keyed by the exact id the model is configured with (an ARN stays an ARN), which is the id
 * a turn reports and is priced under. Gateway models are seeded too, as the estimate a call that comes
 * back without a cost falls back to.
 *
 * A model still unpriced after that gets one warning line naming it, why, and the `priceCatalog`
 * entry that fixes it. Never throws: this runs at boot, and pricing is bookkeeping, not a reason for
 * the app to stay down.
 */
export async function ensureModelPricing(
  args: EnsureModelPricingArgs,
): Promise<EnsureModelPricingResult> {
  const models = dedupe(args.models);
  const catalog = args.catalog === false ? undefined : args.catalog;
  const seeded: string[] = [];
  const reasons = new Map<string, string>();
  let current = new Map<string, CurrentModelPrice>();
  const store = args.pricingStore;

  if (store !== undefined) {
    let needing: DescribedModel[];
    try {
      const rows = await store.listCurrentPrices();
      current = new Map(rows.map((row) => [row.modelId, row]));
      needing = models.filter((model) => resolveModelPrice(current, model.modelId) === undefined);
    } catch (error) {
      args.log.warn(`${PREFIX} Could not read the pricing table at boot: ${messageOf(error)}`);
      needing = [];
    }
    const effectiveFrom = new Date().toISOString();
    const write = async (price: ModelPriceInput): Promise<boolean> => {
      if (current.has(price.modelId)) return false;
      try {
        await store.upsertModelPrice(price);
      } catch (error) {
        args.log.warn(
          `${PREFIX} Could not write the price of ${price.modelId}: ${messageOf(error)}`,
        );
        return false;
      }
      current.set(price.modelId, { ...price, effectiveFrom });
      return true;
    };
    const stillNeeding = () =>
      needing.filter((model) => resolveModelPrice(current, model.modelId) === undefined);

    // 1. The app's own prices: every entry gets its row, and a configured model matching one by id.
    const appPrices = normalizePriceEntries(catalog?.prices ?? [], args.log);
    if (appPrices.size > 0) {
      const before = stillNeeding();
      for (const price of appPrices.values()) await write(price);
      // Keyed by the configured id too, so the id a turn reports finds it by exact match.
      for (const model of before) {
        const price = matchPrice(appPrices, model.modelId);
        if (price !== undefined) await write({ ...price, modelId: model.modelId });
      }
      const fromApp = before
        .filter((model) => resolveModelPrice(current, model.modelId) !== undefined)
        .map((model) => model.modelId);
      if (fromApp.length > 0) {
        seeded.push(...fromApp);
        args.log.info(
          `${PREFIX} Seeded prices from \`priceCatalog.prices\` for ${fromApp.join(', ')}.`,
        );
      }
    }

    // 2. Bedrock outside the commercial partition: the built-in table, never models.dev.
    const region = catalog?.region ?? defaultAwsRegion();
    const fromBuiltin: string[] = [];
    const commercial: DescribedModel[] = [];
    for (const model of stillNeeding()) {
      const partition = bedrockPartitionOf(model, region);
      if (partition === undefined || partition === 'aws') {
        commercial.push(model);
        continue;
      }
      const price = builtinBedrockPrice(model.modelId, partition);
      if (price !== undefined && (await write(price))) fromBuiltin.push(model.modelId);
      else {
        reasons.set(
          model.modelId,
          `no price for AWS partition ${partition}${regionNote(model, region)} — models.dev lists commercial Bedrock prices only, and the built-in table has none for it`,
        );
      }
    }
    if (fromBuiltin.length > 0) {
      seeded.push(...fromBuiltin);
      args.log.info(
        `${PREFIX} Seeded built-in AWS GovCloud Bedrock prices for ${fromBuiltin.join(', ')} (from the AWS Price List; may go stale). Set \`priceCatalog.prices\` to override.`,
      );
    }

    // 3. models.dev, for the rest.
    if (commercial.length > 0) {
      if (catalog === undefined || catalog.modelsDev === false) {
        for (const model of commercial) {
          reasons.set(model.modelId, 'no price row, and models.dev lookups are off');
        }
      } else {
        try {
          const refs = commercial.map((model) => modelsDevRefsFor(model.modelId, model.provider));
          const { prices: _p, region: _r, modelsDev: _m, ...modelsDev } = catalog;
          const found = await lookupModelsDevPricesEach(
            refs,
            // Bounded: a hung catalog must not hold a shutdown (which awaits this) open forever.
            modelsDev.signal !== undefined
              ? modelsDev
              : { ...modelsDev, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) },
          );
          const fromModelsDev: string[] = [];
          for (const [i, model] of commercial.entries()) {
            const price = found[i];
            if (price === undefined) {
              reasons.set(model.modelId, 'unknown model — models.dev does not list a price for it');
            } else if (await write({ ...price, modelId: model.modelId })) {
              fromModelsDev.push(model.modelId);
            }
          }
          if (fromModelsDev.length > 0) {
            seeded.push(...fromModelsDev);
            const bedrock = commercial.some((model) =>
              isBedrockModel(model.modelId, model.provider),
            );
            args.log.info(
              `${PREFIX} Seeded list prices from models.dev for ${fromModelsDev.join(', ')} — an estimate, used when the provider reports no cost.${
                bedrock
                  ? ' Bedrock rows are COMMERCIAL-region prices: for GovCloud or China set `priceCatalog.region` (or `AWS_REGION`).'
                  : ''
              } Set your own with \`priceCatalog.prices\`, \`upsertModelPrice\` to override.`,
            );
          }
        } catch (error) {
          args.log.warn(`${PREFIX} Could not seed prices from models.dev: ${messageOf(error)}`);
          for (const model of commercial) reasons.set(model.modelId, 'models.dev was unreachable');
        }
      }
    }
  }

  const unpriced = models
    .filter((model) => !model.reportsCost)
    .filter((model) => resolveModelPrice(current, model.modelId) === undefined)
    .map((model) => model.modelId);
  if (unpriced.length > 0) {
    // Grouped by reason: `a, b (unknown model …); c (no price for AWS partition …)`.
    const groups = new Map<string, string[]>();
    for (const id of unpriced) {
      const reason = reasons.get(id) ?? '';
      groups.set(reason, [...(groups.get(reason) ?? []), id]);
    }
    const named = [...groups]
      .map(([reason, ids]) => `${ids.join(', ')}${reason !== '' ? ` (${reason})` : ''}`)
      .join('; ');
    const example = exampleModelFor(unpriced[0] as string);
    args.log.warn(
      `${PREFIX} No cost will be recorded for ${named}: the provider reports no cost and ${
        store === undefined
          ? 'no `pricingStore` is configured. Configure one, then '
          : 'the pricing table has no row for it. '
      }Add the price to \`priceCatalog.prices\`, e.g. \`{ model: '${example}', input: <USD per 1M>, output: <USD per 1M>, cacheRead?, cacheWrite? }\`, or seed a row with \`seedModelPrices(store, [...])\`, or route through a gateway that reports cost (OpenRouter, Vercel AI Gateway).`,
    );
  }
  return { seeded, unpriced };
}

/** The partition a Bedrock model runs in: its id says, else the configured region; `undefined` → not Bedrock / unknown. */
function bedrockPartitionOf(
  model: DescribedModel,
  region: string | undefined,
): AwsPartition | undefined {
  if (!isBedrockModel(model.modelId, model.provider)) return undefined;
  return parseBedrockModelId(model.modelId)?.partition ?? awsPartitionOfRegion(region);
}

function regionNote(model: DescribedModel, region: string | undefined): string {
  const fromId = parseBedrockModelId(model.modelId);
  const r = fromId?.region ?? (fromId?.partition === undefined ? region : undefined);
  return r !== undefined ? ` (region ${r})` : '';
}

/** The id to put in the warning's example entry: the shortest id that still prices the model. */
function exampleModelFor(modelId: string): string {
  const parsed = parseBedrockModelId(modelId);
  return parsed?.isArn ? parsed.profileId : modelId;
}

function defaultAwsRegion(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const region = env?.AWS_REGION ?? env?.AWS_DEFAULT_REGION;
  return region !== undefined && region.length > 0 ? region : undefined;
}

/** A model's app price: by its exact id, then its normalized Bedrock candidates. */
function matchPrice(
  prices: ReadonlyMap<string, ModelPriceInput>,
  modelId: string,
): ModelPriceInput | undefined {
  for (const candidate of bedrockPriceCandidates(modelId)) {
    const price = prices.get(candidate);
    if (price !== undefined) return price;
  }
  return undefined;
}

/** `priceCatalog.prices` as per-1M USD rows, keyed by model. Invalid entries are warned about and skipped. */
export function normalizePriceEntries(
  entries: readonly PriceCatalogEntry[],
  log?: BootPricingLog,
): Map<string, ModelPriceInput> {
  const out = new Map<string, ModelPriceInput>();
  const rejected: string[] = [];
  for (const entry of entries) {
    const label = typeof entry?.model === 'string' && entry.model.length > 0 ? entry.model : '?';
    const currency = entry?.currency ?? 'USD';
    const unit = entry?.unit ?? '1M tokens';
    const scale = unit === '1M tokens' ? 1 : unit === '1K tokens' ? 1000 : undefined;
    const rates = [entry?.input, entry?.output, entry?.cacheRead, entry?.cacheWrite];
    const bad = rates.some(
      (rate, i) =>
        (i < 2 || rate !== undefined) &&
        (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0),
    );
    if (label === '?' || currency !== 'USD' || scale === undefined || bad) {
      rejected.push(
        `${label} (${
          currency !== 'USD'
            ? `currency ${String(currency)} — only USD is recorded`
            : scale === undefined
              ? `unit ${String(unit)} — use '1M tokens' or '1K tokens'`
              : 'needs a model and non-negative numeric input/output'
        })`,
      );
      continue;
    }
    if (out.has(entry.model)) continue; // first entry for a model wins
    out.set(entry.model, {
      modelId: entry.model,
      inputPricePer1m: entry.input * scale,
      outputPricePer1m: entry.output * scale,
      ...(entry.cacheRead !== undefined ? { cacheReadPricePer1m: entry.cacheRead * scale } : {}),
      ...(entry.cacheWrite !== undefined ? { cacheWritePricePer1m: entry.cacheWrite * scale } : {}),
    });
  }
  if (rejected.length > 0) {
    log?.warn(`${PREFIX} Ignored \`priceCatalog.prices\` entries: ${rejected.join('; ')}.`);
  }
  return out;
}

function dedupe(models: readonly DescribedModel[]): DescribedModel[] {
  const seen = new Map<string, DescribedModel>();
  for (const model of models) if (!seen.has(model.modelId)) seen.set(model.modelId, model);
  return [...seen.values()];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
