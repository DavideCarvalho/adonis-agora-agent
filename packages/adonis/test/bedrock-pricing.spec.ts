import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bedrockPriceCandidates,
  builtinBedrockPrice,
  DefaultRolesPolicy,
  type DescribedModel,
  ensureModelPricing,
  isBedrockModel,
  type ModelProvider,
  modelsDevRefsFor,
  normalizePriceEntries,
  type PriceCatalogEntry,
  parseBedrockModelId,
  runAgentLoop,
  ToolRegistry,
} from '../src/index.js';
import {
  InMemoryAgentStore,
  InMemoryPricingStore,
  InMemoryTokenStreamSink,
} from '../src/testing/index.js';

const BASE = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const GOV_PROFILE = `us-gov.${BASE}`;
const GOV_ARN = `arn:aws-us-gov:bedrock:us-gov-west-1:358252705848:inference-profile/${GOV_PROFILE}`;

/** The published GovCloud (us-gov-west-1) price of Claude Sonnet 4.5, USD per 1M tokens. */
const GOV_SONNET_45: PriceCatalogEntry = {
  model: GOV_PROFILE,
  input: 3.6,
  output: 18,
  cacheRead: 0.36,
  cacheWrite: 4.5,
};

/** models.dev's (commercial) Bedrock listing. */
const CATALOG = {
  'amazon-bedrock': {
    models: {
      [BASE]: { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      [`us.${BASE}`]: { cost: { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 } },
    },
  },
};

function fakeFetch(body: unknown = CATALOG) {
  return vi.fn(
    async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response,
  );
}

function log() {
  return { info: vi.fn(), warn: vi.fn() };
}

const bedrock = (modelId: string): DescribedModel => ({
  modelId,
  provider: 'amazon-bedrock',
  reportsCost: false,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseBedrockModelId', () => {
  it('parses inference-profile, foundation-model and application-inference-profile ARNs', () => {
    expect(parseBedrockModelId(GOV_ARN)).toEqual({
      modelId: GOV_ARN,
      profileId: GOV_PROFILE,
      baseId: BASE,
      geo: 'us-gov',
      region: 'us-gov-west-1',
      partition: 'aws-us-gov',
      isArn: true,
    });
    expect(
      parseBedrockModelId(`arn:aws:bedrock:us-east-1::foundation-model/${BASE}`),
    ).toMatchObject({ profileId: BASE, baseId: BASE, geo: undefined, partition: 'aws' });
    expect(
      parseBedrockModelId(
        'arn:aws-cn:bedrock:cn-north-1:123456789012:application-inference-profile/abc123',
      ),
    ).toMatchObject({ profileId: 'abc123', baseId: undefined, partition: 'aws-cn' });
  });

  it('strips geo prefixes, us-gov before us', () => {
    for (const geo of ['us', 'eu', 'apac', 'global', 'jp', 'au']) {
      expect(parseBedrockModelId(`${geo}.${BASE}`)).toMatchObject({ geo, baseId: BASE });
    }
    expect(parseBedrockModelId(GOV_PROFILE)).toMatchObject({
      geo: 'us-gov',
      baseId: BASE,
      partition: 'aws-us-gov',
    });
    expect(parseBedrockModelId(`us.${BASE}`)?.partition).toBeUndefined();
  });

  it('does not guess at ids that are not Bedrock-shaped', () => {
    expect(parseBedrockModelId(BASE)).toBeUndefined();
    expect(parseBedrockModelId('gpt-4o-mini')).toBeUndefined();
    expect(parseBedrockModelId('deepseek/deepseek-v4.1-flash')).toBeUndefined();
    expect(isBedrockModel(BASE, 'amazon-bedrock')).toBe(true);
    expect(isBedrockModel('gpt-4o-mini', 'openai')).toBe(false);
  });

  it('yields the full id, the profile id, then the base id', () => {
    expect(bedrockPriceCandidates(GOV_ARN)).toEqual([GOV_ARN, GOV_PROFILE, BASE]);
    expect(bedrockPriceCandidates(`us.${BASE}`)).toEqual([`us.${BASE}`, BASE]);
    expect(bedrockPriceCandidates(BASE)).toEqual([BASE]);
  });

  it('modelsDevRefsFor: no OpenRouter (or verbatim) ref for an ARN', () => {
    expect(modelsDevRefsFor(GOV_ARN, 'amazon-bedrock')).toEqual([
      `amazon-bedrock/${GOV_PROFILE}`,
      `amazon-bedrock/${BASE}`,
    ]);
    expect(modelsDevRefsFor(`us.${BASE}`, 'amazon-bedrock')).toEqual([
      `amazon-bedrock/us.${BASE}`,
      `amazon-bedrock/${BASE}`,
    ]);
  });

  it('has the published GovCloud price of Claude Sonnet 4.5 built in', () => {
    expect(builtinBedrockPrice(GOV_ARN, 'aws-us-gov')).toEqual({
      modelId: GOV_ARN,
      inputPricePer1m: 3.6,
      outputPricePer1m: 18,
      cacheReadPricePer1m: 0.36,
      cacheWritePricePer1m: 4.5,
    });
    expect(builtinBedrockPrice(GOV_ARN, 'aws-cn')).toBeUndefined();
  });
});

describe('ensureModelPricing on Bedrock', () => {
  it('never seeds a GovCloud model at the commercial models.dev price', async () => {
    const store = new InMemoryPricingStore();
    const fetch = fakeFetch();
    const result = await ensureModelPricing({
      models: [bedrock(GOV_ARN), bedrock(GOV_PROFILE)],
      pricingStore: store,
      catalog: { fetch },
      log: log(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.unpriced).toEqual([]);
    const rows = await store.listCurrentPrices();
    expect(rows.map((r) => [r.modelId, r.inputPricePer1m, r.outputPricePer1m])).toEqual([
      [GOV_ARN, 3.6, 18],
      [GOV_PROFILE, 3.6, 18],
    ]);
  });

  it('a bare base id in a GovCloud region (priceCatalog.region / AWS_REGION) is not priced commercially', async () => {
    for (const setup of [
      { catalog: { region: 'us-gov-east-1' } },
      { catalog: {}, env: 'us-gov-west-1' },
    ]) {
      if (setup.env !== undefined) vi.stubEnv('AWS_REGION', setup.env);
      const store = new InMemoryPricingStore();
      const fetch = fakeFetch();
      await ensureModelPricing({
        models: [bedrock(BASE)],
        pricingStore: store,
        catalog: { ...setup.catalog, fetch },
        log: log(),
      });
      expect(fetch).not.toHaveBeenCalled();
      expect((await store.listCurrentPrices())[0]?.inputPricePer1m).toBe(3.6);
      vi.unstubAllEnvs();
    }
  });

  it('warns, naming the partition and the fix, for a model with no price there', async () => {
    const l = log();
    const store = new InMemoryPricingStore();
    const cn =
      'arn:aws-cn:bedrock:cn-north-1:123456789012:inference-profile/apac.anthropic.claude-x';
    const result = await ensureModelPricing({
      models: [bedrock(cn)],
      pricingStore: store,
      catalog: { fetch: fakeFetch() },
      log: l,
    });
    expect(result.unpriced).toEqual([cn]);
    expect(await store.listCurrentPrices()).toEqual([]);
    const line = String(l.warn.mock.calls[0]?.[0]);
    expect(line).toContain('no price for AWS partition aws-cn (region cn-north-1)');
    expect(line).toContain("`priceCatalog.prices`, e.g. `{ model: 'apac.anthropic.claude-x'");
  });

  it('names an unknown model as such', async () => {
    const l = log();
    await ensureModelPricing({
      models: [bedrock('us.anthropic.claude-nope-v1:0')],
      pricingStore: new InMemoryPricingStore(),
      catalog: { fetch: fakeFetch() },
      log: l,
    });
    expect(String(l.warn.mock.calls[0]?.[0])).toContain(
      'us.anthropic.claude-nope-v1:0 (unknown model — models.dev does not list a price for it)',
    );
  });

  it('commercial Bedrock still comes from models.dev, profile price first, keyed by the configured id', async () => {
    const store = new InMemoryPricingStore();
    const arn = `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.${BASE}`;
    const l = log();
    await ensureModelPricing({
      models: [bedrock(arn), bedrock(BASE)],
      pricingStore: store,
      catalog: { fetch: fakeFetch() },
      log: l,
    });
    const rows = await store.listCurrentPrices();
    expect(rows.map((r) => [r.modelId, r.inputPricePer1m])).toEqual([
      [arn, 3.3],
      [BASE, 3],
    ]);
    expect(String(l.info.mock.calls[0]?.[0])).toContain('COMMERCIAL-region prices');
  });

  it('seeds app-supplied prices, matching the ARN by profile id, without overwriting', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({ modelId: 'kept', inputPricePer1m: 9, outputPricePer1m: 9 });
    const fetch = fakeFetch();
    const result = await ensureModelPricing({
      models: [bedrock(GOV_ARN), { modelId: 'kept', provider: 'acme', reportsCost: false }],
      pricingStore: store,
      catalog: {
        fetch,
        prices: [
          { ...GOV_SONNET_45, input: 4, output: 20 }, // app's rate beats the built-in table
          { model: 'kept', input: 1, output: 1 },
          { model: 'per-1k', input: 0.0036, output: 0.018, unit: '1K tokens' },
          { model: 'eur', input: 1, output: 1, currency: 'EUR' as 'USD' },
        ],
      },
      log: log(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.seeded).toEqual([GOV_ARN]);
    const rows = new Map((await store.listCurrentPrices()).map((r) => [r.modelId, r]));
    expect(rows.get(GOV_ARN)?.inputPricePer1m).toBe(4);
    expect(rows.get(GOV_PROFILE)?.outputPricePer1m).toBe(20);
    expect(rows.get('kept')?.inputPricePer1m).toBe(9);
    expect(rows.get('per-1k')?.inputPricePer1m).toBeCloseTo(3.6);
    expect(rows.has('eur')).toBe(false);
  });

  it('normalizePriceEntries refuses non-USD, unknown units and bad rates', () => {
    const l = log();
    const out = normalizePriceEntries(
      [
        GOV_SONNET_45,
        { model: 'a', input: -1, output: 1 },
        { model: 'b', input: 1, output: 1, unit: 'tokens' as '1M tokens' },
      ],
      l,
    );
    expect([...out.keys()]).toEqual([GOV_PROFILE]);
    expect(String(l.warn.mock.calls[0]?.[0])).toContain('a (needs a model');
  });
});

/** One loop turn on `GOV_ARN`, priced off a store seeded the way boot seeds it. */
async function bedrockTurn(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  options: { reportedCostUsd?: number; priced?: boolean } = {},
) {
  const pricingStore = new InMemoryPricingStore();
  if (options.priced !== false) {
    await ensureModelPricing({
      models: [bedrock(GOV_ARN)],
      pricingStore,
      catalog: { prices: [GOV_SONNET_45], modelsDev: false },
      log: log(),
    });
  }
  const model: ModelProvider = {
    async runTurn() {
      return {
        text: 'ok',
        toolCalls: [],
        modelId: GOV_ARN,
        usage,
        ...(options.reportedCostUsd !== undefined ? { costUsd: options.reportedCostUsd } : {}),
      };
    },
  };
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const actor = { id: 'u1', roles: ['ADMIN'] };
  const thread = await store.createThread({ actor, persona: 'default' });
  await runAgentLoop(
    {
      model,
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: GOV_ARN,
      day: '2026-10-08',
      systemPrompt: 'test',
      pricingStore,
    },
    { threadId: thread.id, actor, userText: 'hi' },
    {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    },
  );
  for await (const _ of sink.subscribe('run-1')) {
    // drain
  }
  const detail = await store.getThread(thread.id);
  const assistant = detail?.messages.find((m) => m.role === 'assistant');
  const [row] = store.governanceUsage();
  const day = new Date().toISOString().slice(0, 10);
  const totals = await store.usageBetween('u1', day, day);
  return { assistant, row, totals };
}

describe('a Bedrock turn reporting the full ARN', () => {
  it('records a non-NULL, plausible cost through the seeded row', async () => {
    const { assistant } = await bedrockTurn({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 200_000,
    });
    // 0.8M uncached × $3.60 + 0.2M cache-read × $0.36 + 0.1M output × $18 = $2.88 + $0.072 + $1.80
    expect(assistant?.usage?.costUsd).toBeCloseTo(4.752, 6);
  });

  it('persists the estimate to the usage ledger, marked as one, and the quota totals count it', async () => {
    // squid-nestjs#35: 10,605 in / 5 out on the GovCloud ARN.
    const { assistant, row, totals } = await bedrockTurn({ inputTokens: 10_605, outputTokens: 5 });
    expect(assistant?.usage?.costUsd).toBeCloseTo(0.038268, 9);
    expect(row).toMatchObject({ modelId: GOV_ARN, costSource: 'estimate' });
    expect(row?.costUsd).toBeCloseTo(0.038268, 9);
    expect(totals.costUsd).toBeCloseTo(0.038268, 9);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.038268, 9);
  });

  it('a provider-reported cost still wins, marked provider, and is not counted as an estimate', async () => {
    const { row, totals } = await bedrockTurn(
      { inputTokens: 10_605, outputTokens: 5 },
      { reportedCostUsd: 0.05 },
    );
    expect(row).toMatchObject({ costUsd: 0.05, costSource: 'provider' });
    expect(totals).toEqual({ usedTokens: 10_610, costUsd: 0.05, estimatedCostUsd: 0 });
  });

  it('an unpriced turn persists no cost and no source (never a fabricated 0)', async () => {
    const { assistant, row, totals } = await bedrockTurn(
      { inputTokens: 10_605, outputTokens: 5 },
      { priced: false },
    );
    expect(assistant?.usage?.costUsd).toBeNull();
    expect(row?.costUsd).toBeUndefined();
    expect(row?.costSource).toBeUndefined();
    expect(totals.costUsd).toBe(0);
  });
});
