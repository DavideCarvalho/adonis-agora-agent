import type { ModelPriceInput } from '../spi/pricing-store.js';

/**
 * AWS Bedrock model ids, and what they say about where (and so at what price) a model runs.
 *
 * Bedrock reports no cost, so a Bedrock turn is priced off a price row looked up by the id the turn
 * reports, and that id comes in several shapes for the same model:
 *
 * - a base (foundation-model) id: `anthropic.claude-sonnet-4-5-20250929-v1:0`
 * - a cross-region inference profile: `us.anthropic.…`, `eu.…`, `apac.…`, `us-gov.…`, `global.…`
 * - an ARN of either: `arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.…`
 *
 * The price also depends on the AWS partition. GovCloud (`aws-us-gov`) and China (`aws-cn`) are not
 * priced like the commercial regions models.dev lists (GovCloud Claude Sonnet 4.5 costs 20% more), so
 * a commercial list price must never be applied there silently.
 */

/** The AWS partitions. Prices in `aws` are what models.dev lists; the others differ. */
export type AwsPartition = 'aws' | 'aws-us-gov' | 'aws-cn';

/** What a Bedrock model id says about itself. */
export interface BedrockModelId {
  /** The id as given. */
  modelId: string;
  /** The id inside the ARN (or `modelId` when it is no ARN): a profile id or a base id. */
  profileId: string;
  /** The foundation-model id, geo prefix stripped. `undefined` for an application inference profile. */
  baseId: string | undefined;
  /** The cross-region profile's geo prefix (`us`, `us-gov`, `eu`, `global`, …), if any. */
  geo: string | undefined;
  /** The ARN's region, when the id is an ARN that names one. */
  region: string | undefined;
  /** The partition the id implies (ARN partition, region, or `us-gov.` prefix); `undefined` → it does not say. */
  partition: AwsPartition | undefined;
  /** It is an ARN (`arn:aws…:bedrock:…`). */
  isArn: boolean;
}

const ARN =
  /^arn:(aws|aws-us-gov|aws-cn):bedrock:([a-z0-9-]*):(\d*):(inference-profile|foundation-model|application-inference-profile)\/(.+)$/;

/** Cross-region inference profile prefixes. `us-gov` before `us`: the alternation is ordered. */
const GEO = /^(us-gov|us|eu|apac|au|jp|ca|in|global)\.(?=[a-z0-9-]+\.)/;

/** The partition an AWS region belongs to; `undefined` for an empty / missing region. */
export function awsPartitionOfRegion(region: string | undefined): AwsPartition | undefined {
  if (region === undefined || region.length === 0) return undefined;
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}

/**
 * Parse a Bedrock model id: an ARN (`arn:aws[-us-gov|-cn]:bedrock:<region>:<acct>:(inference-profile|
 * foundation-model|application-inference-profile)/<id>`), a geo-prefixed inference profile, or a base
 * id. Returns `undefined` for an id that is not Bedrock-shaped (no ARN, no geo prefix) — a plain
 * `gpt-4o-mini` is not guessed at.
 */
export function parseBedrockModelId(modelId: string): BedrockModelId | undefined {
  const arn = ARN.exec(modelId);
  const profileId = arn !== null ? (arn[5] as string) : modelId;
  const geo = GEO.exec(profileId)?.[1];
  if (arn === null && geo === undefined) return undefined;
  const region = arn !== null && arn[2] !== '' ? arn[2] : undefined;
  const isAppProfile = arn?.[4] === 'application-inference-profile';
  const baseId = isAppProfile
    ? undefined
    : geo !== undefined
      ? profileId.slice(geo.length + 1)
      : profileId;
  const partition =
    (arn?.[1] as AwsPartition | undefined) ??
    awsPartitionOfRegion(region) ??
    (geo === 'us-gov' ? 'aws-us-gov' : undefined);
  return { modelId, profileId, baseId, geo, region, partition, isArn: arn !== null };
}

/** Whether a model is reached through Bedrock: its provider says so, or its id is Bedrock-shaped. */
export function isBedrockModel(modelId: string, provider: string | undefined): boolean {
  if (provider !== undefined && /bedrock/i.test(provider)) return true;
  return parseBedrockModelId(modelId) !== undefined;
}

/**
 * The ids to look a Bedrock model's price up under, most specific first: the full id, the profile id
 * (the ARN's resource), then the base foundation-model id. Deduplicated. A non-Bedrock-shaped id is
 * its own only candidate.
 */
export function bedrockPriceCandidates(modelId: string): string[] {
  const parsed = parseBedrockModelId(modelId);
  const out = [modelId];
  if (parsed === undefined) return out;
  for (const id of [parsed.profileId, parsed.baseId]) {
    if (id !== undefined && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Where the built-in prices below come from, for the log and the docs. */
export const BEDROCK_BUILTIN_PRICES_SOURCE =
  'AWS Price List, AmazonBedrockFoundationModels, us-gov-west-1, published 2026-10-08 (on-demand, standard context)';

/**
 * Built-in Bedrock prices (USD per 1M tokens) for partitions models.dev does not cover, keyed by base
 * foundation-model id. Small and curated on purpose — it goes stale, so an app's own
 * `priceCatalog.prices` (or a row it set) always wins over it. Commercial (`aws`) is not listed: it
 * comes from models.dev. China (`aws-cn`) bills in CNY and is not covered: such a model is warned
 * about and left unpriced until the app supplies a price.
 */
export const BEDROCK_BUILTIN_PRICES: Readonly<
  Partial<Record<AwsPartition, Readonly<Record<string, Omit<ModelPriceInput, 'modelId'>>>>>
> = {
  'aws-us-gov': {
    'anthropic.claude-3-haiku-20240307-v1:0': { inputPricePer1m: 0.3, outputPricePer1m: 1.5 },
    'anthropic.claude-3-5-sonnet-20240620-v1:0': { inputPricePer1m: 3.6, outputPricePer1m: 18 },
    'anthropic.claude-3-7-sonnet-20250219-v1:0': {
      inputPricePer1m: 3.6,
      outputPricePer1m: 18,
      cacheReadPricePer1m: 0.36,
      cacheWritePricePer1m: 4.5,
    },
    'anthropic.claude-sonnet-4-5-20250929-v1:0': {
      inputPricePer1m: 3.6,
      outputPricePer1m: 18,
      cacheReadPricePer1m: 0.36,
      cacheWritePricePer1m: 4.5,
    },
    'anthropic.claude-sonnet-5': {
      inputPricePer1m: 2.4,
      outputPricePer1m: 12,
      cacheReadPricePer1m: 0.24,
      cacheWritePricePer1m: 3,
    },
    'anthropic.claude-sonnet-5-5': {
      inputPricePer1m: 2.4,
      outputPricePer1m: 12,
      cacheReadPricePer1m: 0.12,
      cacheWritePricePer1m: 3,
    },
    'anthropic.claude-opus-4-8': {
      inputPricePer1m: 6,
      outputPricePer1m: 30,
      cacheReadPricePer1m: 0.6,
      cacheWritePricePer1m: 7.5,
    },
    'anthropic.claude-opus-5': {
      inputPricePer1m: 6,
      outputPricePer1m: 30,
      cacheReadPricePer1m: 0.6,
      cacheWritePricePer1m: 7.5,
    },
    'anthropic.claude-opus-5-5': {
      inputPricePer1m: 4.8,
      outputPricePer1m: 24,
      cacheReadPricePer1m: 0.24,
      cacheWritePricePer1m: 6,
    },
    'anthropic.claude-haiku-5-5': {
      inputPricePer1m: 0.12,
      outputPricePer1m: 0.6,
      cacheReadPricePer1m: 0.012,
      cacheWritePricePer1m: 0.15,
    },
    'anthropic.claude-fable-5-1': {
      inputPricePer1m: 12,
      outputPricePer1m: 60,
      cacheReadPricePer1m: 0.3,
      cacheWritePricePer1m: 15,
    },
  },
};

/** The built-in price for a Bedrock model in a non-commercial partition, keyed by `modelId`. */
export function builtinBedrockPrice(
  modelId: string,
  partition: AwsPartition,
): ModelPriceInput | undefined {
  const table = BEDROCK_BUILTIN_PRICES[partition];
  if (table === undefined) return undefined;
  for (const candidate of bedrockPriceCandidates(modelId)) {
    const price = table[candidate];
    if (price !== undefined) return { modelId, ...price };
  }
  return undefined;
}
