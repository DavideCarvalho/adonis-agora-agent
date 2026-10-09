import { InMemoryStateStore, WorkflowEngine } from '@adonis-agora/durable';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCost, type RecordUsageInput } from '../../src/index.js';
import { openCodeDurable } from '../../src/opencode/durable/index.js';
import { openCode } from '../../src/opencode/engine.js';
import type { OpenCodeRunResult } from '../../src/opencode/host.js';
import type { OpenCodeEngineSettings } from '../../src/opencode/turns.js';
import { InMemoryPricingStore } from '../../src/testing/index.js';
import type { FakeScript, FakeTurn } from '../helpers/fake-opencode.js';
import {
  actor,
  approve,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  type Harness,
} from '../helpers/opencode-harness.js';

const GOV_SONNET = 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0';
/** What OpenCode reports for a step: the uncached input, and the cache beside it. */
const TOKENS = { input: 3, output: 217, reasoning: 0, cache: { read: 1000, write: 10085 } };
/** The same step as the library counts it: the whole input side, cache included. */
const USAGE = {
  inputTokens: 3 + 1000 + 10085,
  outputTokens: 217,
  cacheReadTokens: 1000,
  cacheWriteTokens: 10085,
};
/** At the published us-gov-west-1 price of Claude Sonnet 4.5 (the built-in table). */
const GOV_COST = (3 * 3.6 + 217 * 18 + 1000 * 0.36 + 10085 * 4.5) / 1_000_000;

function bedrockStep(t: FakeTurn, cost: number, tokens: Record<string, unknown> = TOKENS) {
  t.emit('session.step.started', { model: { providerID: 'amazon-bedrock', id: GOV_SONNET } });
  t.emit('session.step.ended', { tokens, cost });
}

/** Every usage row the engine writes. */
function ledger(h: Harness): RecordUsageInput[] {
  const rows: RecordUsageInput[] = [];
  const record = h.store.recordUsage.bind(h.store);
  h.store.recordUsage = async (input) => {
    rows.push(input);
    await record(input);
  };
  return rows;
}

const GOV_CATALOG = { region: 'us-gov-west-1', modelsDev: false } as const;

describe('OpenCode turns: cost and usage', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function boot(
    script: FakeScript,
    settings: Partial<OpenCodeEngineSettings> = {},
    extra: { pricing?: InMemoryPricingStore; settled?: OpenCodeRunResult[] } = {},
  ): Promise<Harness> {
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host: Object.assign(host, {
            onSettled: async (r: OpenCodeRunResult) => {
              extra.settled?.push(r);
            },
          }),
          ...settings,
        }),
      script,
      priceCatalog: GOV_CATALOG,
      ...(extra.pricing ? { pricingStore: extra.pricing } : {}),
    });
    return h;
  }

  it('estimates a step OpenCode priced at 0 at the GovCloud price, cache tokens included', async () => {
    const pricing = new InMemoryPricingStore();
    const settled: OpenCodeRunResult[] = [];
    const h = await boot(
      async (t) => {
        t.emit('session.text.delta', { delta: 'Hi.' });
        bedrockStep(t, 0);
        t.succeed();
      },
      {},
      { pricing, settled },
    );
    const rows = ledger(h);
    const { runId, threadId } = await h.service.chat({ actor, message: 'hi' });
    const fs = await frames(h.service, runId);
    await eventually(() => settled.length === 1, 'settled');

    expect(rows).toEqual([
      expect.objectContaining({
        purpose: 'chat',
        runId,
        modelId: `amazon-bedrock/${GOV_SONNET}`,
        usage: USAGE,
        costSource: 'estimate',
        costUsd: expect.closeTo(GOV_COST, 12),
      }),
    ]);
    expect(
      estimateCost(USAGE, {
        modelId: GOV_SONNET,
        inputPricePer1m: 3.6,
        outputPricePer1m: 18,
        cacheReadPricePer1m: 0.36,
        cacheWritePricePer1m: 4.5,
        effectiveFrom: '',
      }),
    ).toBeCloseTo(GOV_COST, 12);
    expect(fs.find((f) => f.kind === 'step-finish')).toMatchObject({
      costUsd: expect.closeTo(GOV_COST, 12),
      model: `amazon-bedrock/${GOV_SONNET}`,
    });
    expect((await pricing.listCurrentPrices()).map((p) => p.modelId)).toContain(GOV_SONNET);
    const answer = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answer?.usage).toMatchObject({ ...USAGE, costUsd: expect.closeTo(GOV_COST, 12) });
    expect(settled[0]?.usage).toMatchObject({
      ...USAGE,
      costUsd: expect.closeTo(GOV_COST, 12),
      steps: 1,
    });
  });

  it('records the cost OpenCode reported as the provider figure', async () => {
    const h = await boot(async (t) => {
      bedrockStep(t, 0.05);
      t.succeed();
    });
    const rows = ledger(h);
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    expect(rows).toEqual([expect.objectContaining({ costUsd: 0.05, costSource: 'provider' })]);
  });

  it("`cost: 'estimate'` prices at the library's price even when OpenCode reported one", async () => {
    const h = await boot(
      async (t) => {
        bedrockStep(t, 0.05);
        t.succeed();
      },
      { cost: 'estimate' },
    );
    const rows = ledger(h);
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    expect(rows).toEqual([
      expect.objectContaining({ costSource: 'estimate', costUsd: expect.closeTo(GOV_COST, 12) }),
    ]);
  });

  it("keeps OpenCode's 0 for a model the library has no price for", async () => {
    const h = await boot(async (t) => {
      t.emit('session.step.started', { model: { providerID: 'opencode-go', id: 'free-model' } });
      t.emit('session.step.ended', { tokens: { input: 10, output: 5 }, cost: 0 });
      t.succeed();
    });
    const rows = ledger(h);
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    expect(rows).toEqual([
      expect.objectContaining({
        modelId: 'opencode-go/free-model',
        costUsd: 0,
        costSource: 'provider',
      }),
    ]);
  });

  it('records the title and compaction calls OpenCode makes, and counts them in the run', async () => {
    const settled: OpenCodeRunResult[] = [];
    const h = await boot(
      async (t) => {
        bedrockStep(t, 0.01, {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        });
        t.emit('session.usage.recorded', {
          source: 'title',
          tokens: { input: 568, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        });
        t.emit('session.usage.recorded', {
          source: 'compaction',
          tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.002,
        });
        t.succeed();
      },
      {},
      { settled },
    );
    const rows = ledger(h);
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    await eventually(() => settled.length === 1, 'settled');
    const titleCost = (568 * 3.6 + 4 * 18) / 1_000_000;
    expect(rows.map((r) => [r.purpose, r.costSource])).toEqual([
      ['chat', 'provider'],
      ['title', 'estimate'],
      ['summary', 'provider'],
    ]);
    expect(rows[1]).toMatchObject({
      modelId: `amazon-bedrock/${GOV_SONNET}`,
      usage: { inputTokens: 568, outputTokens: 4 },
      costUsd: expect.closeTo(titleCost, 12),
    });
    expect(settled[0]?.usage).toMatchObject({
      inputTokens: 100 + 568 + 50,
      outputTokens: 10 + 4 + 20,
      costUsd: expect.closeTo(0.01 + titleCost + 0.002, 12),
      steps: 1,
    });
  });
});

describe('OpenCode turns: usage across a durable resume', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('adds up what every process saw, cache tokens included, without reading the store', async () => {
    const settled: OpenCodeRunResult[] = [];
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    h = await bootEngine({
      engine: (host) =>
        openCodeDurable({
          host: Object.assign(host, {
            onSettled: async (r: OpenCodeRunResult) => {
              settled.push(r);
            },
          }),
          workflowEngine: engine,
        }),
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Sending.' });
        bedrockStep(t, 0.03);
        t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
        await t.next('permission.reply');
        t.emit('session.text.delta', { delta: 'Sent.' });
        bedrockStep(t, 0.02, {
          input: 2,
          output: 5,
          reasoning: 0,
          cache: { read: 11088, write: 0 },
        });
        t.succeed();
      },
      priceCatalog: GOV_CATALOG,
    });
    const harness = h;
    const { runId, threadId } = await harness.service.chat({ actor, message: 'send it' });
    await framesUntil(harness.service, runId, (f) => f.kind === 'approval-requested');
    // What a restart leaves: no live turn, no listener — only the journal.
    harness.turns.drop(runId);
    // And a store that cannot tell the run's usage: the figure must not come from it.
    const getThread = harness.store.getThread.bind(harness.store);
    harness.store.getThread = (async (id: string) => {
      const thread = await getThread(id);
      return thread && { ...thread, messages: thread.messages.map(({ usage: _u, ...m }) => m) };
    }) as typeof harness.store.getThread;
    await approve(harness.service, 'per_1');
    await frames(harness.service, runId);
    await eventually(() => settled.length === 1, 'settled');

    const expected = {
      inputTokens: USAGE.inputTokens + 2 + 11088,
      outputTokens: 217 + 5,
      cacheReadTokens: 1000 + 11088,
      cacheWriteTokens: 10085,
      costUsd: expect.closeTo(0.05, 12),
    };
    expect(settled[0]?.usage).toMatchObject({ ...expected, steps: 2 });
    const answer = (await getThread(threadId))?.messages.at(-1);
    expect(answer?.usage).toMatchObject(expected);
  });
});
