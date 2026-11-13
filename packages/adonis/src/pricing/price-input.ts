import type { ModelPriceInput } from '../spi/pricing-store.js';

/** What a price write must look like — named by the refusal of the console route and the CLI. */
export const PRICE_INPUT_SHAPE =
  '{modelId: string, inputPricePer1m: number, outputPricePer1m: number, cacheWritePricePer1m?: number, cacheReadPricePer1m?: number}';

const rate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Read one model's per-1M rates out of an untrusted body (`POST <path>/governance/pricing`, or the
 * flags of `agent:pricing:set`). `null` when it is not a price: no model id, or a missing or
 * non-numeric input/output rate. Optional cache rates that are not numbers are dropped.
 */
export function parseModelPriceInput(body: unknown): ModelPriceInput | null {
  const input = (body ?? {}) as Record<string, unknown>;
  if (
    typeof input.modelId !== 'string' ||
    input.modelId.length === 0 ||
    !rate(input.inputPricePer1m) ||
    !rate(input.outputPricePer1m)
  ) {
    return null;
  }
  return {
    modelId: input.modelId,
    inputPricePer1m: input.inputPricePer1m,
    outputPricePer1m: input.outputPricePer1m,
    ...(rate(input.cacheWritePricePer1m)
      ? { cacheWritePricePer1m: input.cacheWritePricePer1m }
      : {}),
    ...(rate(input.cacheReadPricePer1m) ? { cacheReadPricePer1m: input.cacheReadPricePer1m } : {}),
  };
}
