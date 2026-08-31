import type {
  AgentPricingStore,
  CurrentModelPrice,
  ModelPriceInput,
} from '../spi/pricing-store.js';
import type { LucidDatabaseLike } from './lucid.js';
import { AGENT_TABLES, ensureAgentTables } from './lucid-schema.js';

/** Options for {@link LucidPricingStore}. */
export interface LucidPricingStoreOptions {
  /**
   * Provision the shared agent tables on first use. Default `true` (the ecosystem convention). The
   * pricing store writes to `agent_model_pricing`, one of the six shared tables; auto-provisioning
   * here is what lets a pricing seed run before the first agent run. Set `false` to run the migration.
   */
  autoCreateTables?: boolean;
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseFloat(value) || 0;
  return 0;
}

/**
 * A production {@link AgentPricingStore} backed by AdonisJS **Lucid** (Knex) over the
 * `agent_model_pricing` table — the write side the loop's cost fold prices token usage against. Like
 * {@link import('./lucid.js').LucidAgentStore} it touches only the structural {@link LucidDatabaseLike}
 * slice, so `@adonisjs/lucid` stays an optional peer (the factory casts the real `db` in).
 *
 * Atomic supersede (mirrors the reference Drizzle/MikroORM stores): `upsertModelPrice` retires the
 * model's prior `is_current` row and inserts a fresh current one, so exactly one live price exists
 * per model. `effective_from` is stored as epoch-ms (matching the rest of the schema) and read back
 * as an ISO string. Booleans are `INTEGER` 0/1 for cross-dialect portability.
 */
export class LucidPricingStore implements AgentPricingStore {
  private readonly autoCreateTables: boolean;

  constructor(
    private readonly db: LucidDatabaseLike,
    options: LucidPricingStoreOptions = {},
  ) {
    this.autoCreateTables = options.autoCreateTables ?? true;
  }

  /** Provision the shared schema on first use (no-op when disabled), memoized across the stores. */
  private ready(): Promise<void> {
    return this.autoCreateTables ? ensureAgentTables(this.db) : Promise.resolve();
  }

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    await this.ready();
    // Atomic supersede in a transaction: retire the model's current row, then insert the new one.
    await this.db.transaction(async (trx) => {
      await trx
        .from(AGENT_TABLES.modelPricing)
        .where('model_id', input.modelId)
        .where('is_current', 1)
        .update({ is_current: 0 });
      await trx.table(AGENT_TABLES.modelPricing).insert({
        id: crypto.randomUUID(),
        model_id: input.modelId,
        input_price_per_1m: input.inputPricePer1m,
        output_price_per_1m: input.outputPricePer1m,
        cache_write_price_per_1m: input.cacheWritePricePer1m ?? null,
        cache_read_price_per_1m: input.cacheReadPricePer1m ?? null,
        effective_from: Date.now(),
        is_current: 1,
      });
    });
  }

  async listCurrentPrices(): Promise<CurrentModelPrice[]> {
    await this.ready();
    const rows = await this.db.from(AGENT_TABLES.modelPricing).where('is_current', 1).select('*');
    return rows.map((row) => {
      const cacheWrite = row.cache_write_price_per_1m;
      const cacheRead = row.cache_read_price_per_1m;
      return {
        modelId: String(row.model_id),
        inputPricePer1m: toNum(row.input_price_per_1m),
        outputPricePer1m: toNum(row.output_price_per_1m),
        effectiveFrom: new Date(toNum(row.effective_from)).toISOString(),
        ...(cacheWrite !== null && cacheWrite !== undefined
          ? { cacheWritePricePer1m: toNum(cacheWrite) }
          : {}),
        ...(cacheRead !== null && cacheRead !== undefined
          ? { cacheReadPricePer1m: toNum(cacheRead) }
          : {}),
      };
    });
  }
}
