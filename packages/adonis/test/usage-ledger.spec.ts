import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, AgentGovernanceQueries, AgentStore } from '../src/index.js';
import {
  AGENT_TABLES,
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  LucidAgentStore,
  LucidGovernanceQueries,
  PLATFORM_ACTOR_REF,
  ToolRegistry,
} from '../src/index.js';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryGovernanceQueries,
  InMemoryQuotaStore,
} from '../src/testing/index.js';
import { asStoreDb, makeStoreDb } from './helpers/make-db.js';

const actor: Actor = { id: 'alice', roles: ['ADMIN'], tenantRef: 't1' };
const today = new Date().toISOString().slice(0, 10);
const range = { fromDay: today, toDay: today };

/**
 * `AgentService.recordUsage` writes the ledger the agent loop writes — so one cost, one quota and one
 * dashboard cover transcription, TTS and direct SDK calls too. Every case runs on both stores (and,
 * through `makeStoreDb`, on SQLite, Postgres and MySQL).
 */
const backends: {
  name: string;
  open: () => Promise<{
    store: AgentStore;
    gov: AgentGovernanceQueries;
    close: () => Promise<void>;
    raw?: Database;
  }>;
}[] = [
  {
    name: 'in-memory',
    open: async () => {
      const store = new InMemoryAgentStore();
      return { store, gov: new InMemoryGovernanceQueries(store), close: async () => undefined };
    },
  },
  {
    name: 'lucid',
    open: async () => {
      const db = await makeStoreDb();
      return {
        store: new LucidAgentStore(asStoreDb(db)),
        gov: new LucidGovernanceQueries(asStoreDb(db)),
        close: () => db.manager.closeAll(),
        raw: db,
      };
    },
  },
];

for (const backend of backends) {
  describe(`the usage ledger beyond agent turns [${backend.name}]`, () => {
    let store: AgentStore;
    let gov: AgentGovernanceQueries;
    let close: () => Promise<void>;
    let raw: Database | undefined;
    let quota: InMemoryQuotaStore;
    let service: AgentService;

    beforeEach(async () => {
      ({ store, gov, close, raw } = await backend.open());
      quota = new InMemoryQuotaStore(1_000_000);
      const factory = new AgentDepsFactory({
        model: new FakeModelProvider(() => ({ text: 'hello' })),
        store,
        sink: new InProcessTokenStreamSink(),
        rolesPolicy: new DefaultToolAuthorizer(),
        registry: new ToolRegistry(),
        agents: new AgentRegistry(),
        quota,
      });
      service = new AgentService(new InlineAgentRunner(factory, store), store, factory);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await close();
    });

    it('records usage with no thread, in any unit, and reports it by feature and actor', async () => {
      expect(
        await service.recordUsage({
          actorRef: 'alice',
          feature: 'transcription',
          modelId: 'whisper-1',
          provider: 'openai',
          audioSeconds: 90.5,
          costUsd: 0.009,
          tenantRef: 't1',
          metadata: { meetingId: 'm-1' },
        }),
      ).toEqual({ recorded: true });
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'embeddings',
        modelId: 'text-embedding-3-small',
        inputTokens: 1200,
        requests: 3,
        costUsd: 0.00002,
        costSource: 'estimate',
      });
      await service.recordUsage({
        actorRef: null,
        feature: 'tts',
        modelId: 'tts-1',
        characters: 5000,
        costUsd: 0.075,
      });

      const features = await gov.spendByFeature?.(range);
      expect(features?.map((row) => [row.feature, row.source])).toEqual([
        ['tts', 'external'],
        ['transcription', 'external'],
        ['embeddings', 'external'],
      ]);
      expect(features?.find((row) => row.feature === 'transcription')).toMatchObject({
        audioSeconds: 90.5,
        requests: 1,
        inputTokens: 0,
      });
      expect(features?.find((row) => row.feature === 'embeddings')?.requests).toBe(3);
      expect(features?.find((row) => row.feature === 'tts')?.characters).toBe(5000);

      const breakdown = await gov.usageBreakdown?.(range);
      expect(breakdown?.find((row) => row.feature === 'tts')?.actorRef).toBe(PLATFORM_ACTOR_REF);
      const embeddings = breakdown?.find((row) => row.feature === 'embeddings');
      expect(embeddings?.estimatedCostUsd).toBeCloseTo(0.00002, 8);
      expect(await gov.usageBreakdown?.(range, { actor: 'alice' })).toHaveLength(2);
      expect(await gov.usageBreakdown?.(range, { feature: 'tts' })).toHaveLength(1);

      // The platform's spend is its own actor: it never reaches a person's spend.
      const actors = await gov.spendByActor(range);
      expect(actors.map((row) => row.actorRef).sort()).toEqual([PLATFORM_ACTOR_REF, 'alice']);
    });

    it('stores the row as written', async () => {
      if (raw === undefined) return;
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'transcription',
        modelId: 'whisper-1',
        provider: 'openai',
        audioSeconds: 12,
        tenantRef: 't1',
        metadata: { meetingId: 'm-1' },
      });
      const row = await raw.from(AGENT_TABLES.tokenUsage).first();
      expect(row.thread_id).toBeNull();
      expect(row.purpose).toBe('external');
      expect(row.feature).toBe('transcription');
      expect(row.provider).toBe('openai');
      expect(row.tenant_ref).toBe('t1');
      expect(Number(row.audio_seconds)).toBe(12);
      expect(JSON.parse(row.metadata)).toEqual({ meetingId: 'm-1' });
      expect(row.cost_usd).toBeNull();
    });

    it('counts tokens in the token quota and cost in the USD windows; audio adds no tokens', async () => {
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'transcription',
        modelId: 'whisper-1',
        audioSeconds: 60,
        costUsd: 0.006,
      });
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'spellcheck',
        modelId: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.0001,
      });
      await service.recordUsage({
        actorRef: null,
        feature: 'moderation',
        modelId: 'omni-moderation',
        inputTokens: 999,
      });

      expect(await store.quotaToday('alice', today)).toEqual({ usedTokens: 120 });
      const between = await store.usageBetween?.('alice', today, today);
      expect(between?.usedTokens).toBe(120);
      expect(between?.costUsd).toBeCloseTo(0.0061, 8);
      // The QuotaStore counter the loop gates on moved by the same tokens; platform cost moved none.
      expect((await quota.check('alice', today)).usedTokens).toBe(120);
      expect((await quota.check(PLATFORM_ACTOR_REF, today)).usedTokens).toBe(0);
    });

    it('labels agent turns by agent, next to recorded usage', async () => {
      const { runId } = await service.chat({ actor, message: 'hi' });
      for await (const _frame of service.subscribe(runId)) {
        /* drain */
      }
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'transcription',
        modelId: 'whisper-1',
        audioSeconds: 5,
      });
      const features = await gov.spendByFeature?.(range);
      expect(features?.map((row) => [row.feature, row.source]).sort()).toEqual([
        ['agent:default', 'agent'],
        ['transcription', 'external'],
      ]);
      const detail = await gov.runDetail(runId);
      expect(detail?.usage[0]?.feature).toBe('agent:default');
    });

    it('publishes every ledger row — agent turn and recorded — as usage.recorded, without content', async () => {
      const slot = Symbol.for('@agora/diagnostics:emit');
      const events: { event: string; payload: Record<string, unknown> }[] = [];
      (globalThis as Record<symbol, unknown>)[slot] = (
        lib: string,
        event: string,
        payload: unknown,
      ) => {
        if (lib === 'agent') events.push({ event, payload: payload as Record<string, unknown> });
      };
      try {
        const { runId } = await service.chat({ actor, message: 'hi' });
        for await (const _frame of service.subscribe(runId)) {
          /* drain */
        }
        await service.recordUsage({
          actorRef: 'alice',
          feature: 'transcription',
          modelId: 'whisper-1',
          provider: 'openai',
          audioSeconds: 30,
          costUsd: 0.003,
          metadata: { secret: 'never on the event' },
        });
      } finally {
        delete (globalThis as Record<symbol, unknown>)[slot];
      }
      const usage = events
        .filter((each) => each.event === 'usage.recorded')
        .map((each) => each.payload);
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({
        feature: 'agent:default',
        purpose: 'chat',
        actorRef: 'alice',
      });
      expect(usage[0]?.runId).toBeTypeOf('string');
      expect(usage[1]).toEqual({
        actorRef: 'alice',
        feature: 'transcription',
        purpose: 'external',
        modelId: 'whisper-1',
        provider: 'openai',
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 30,
        costUsd: 0.003,
        costSource: 'provider',
      });
      const finished = events.find((each) => each.event === 'run.finished')?.payload;
      expect(finished).toMatchObject({ modelCalls: 1, toolCalls: 0 });
      expect(finished?.queueMs).toBeTypeOf('number');
    });

    it('never throws into the caller by default, and does with throwOnError', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(store, 'recordUsage').mockRejectedValue(new Error('database is down'));
      const result = await service.recordUsage({
        actorRef: 'alice',
        feature: 'tts',
        modelId: 'tts-1',
        characters: 10,
      });
      expect(result.recorded).toBe(false);
      expect(result.recorded === false && result.error.message).toBe('database is down');
      expect(warn).toHaveBeenCalled();
      await expect(
        service.recordUsage(
          { actorRef: 'alice', feature: 'tts', modelId: 'tts-1', characters: 10 },
          { throwOnError: true },
        ),
      ).rejects.toThrow('database is down');
    });

    it('refuses an invalid row without writing it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const write = vi.spyOn(store, 'recordUsage');
      const result = await service.recordUsage({
        actorRef: 'alice',
        feature: '',
        modelId: 'm',
      });
      expect(result.recorded).toBe(false);
      await expect(
        service.recordUsage(
          { actorRef: 'alice', feature: 'f', modelId: 'm', audioSeconds: -1 },
          { throwOnError: true },
        ),
      ).rejects.toThrow(/audioSeconds/);
      for (const bad of [
        { actorRef: '   ', feature: 'f', modelId: 'm' },
        { actorRef: 'alice', feature: 'f', modelId: 'm', requests: 0 },
      ]) {
        await expect(service.recordUsage(bad, { throwOnError: true })).rejects.toThrow(TypeError);
      }
      expect(write).not.toHaveBeenCalled();
    });

    it('counts a row’s own requests the same way in every rollup', async () => {
      await service.recordUsage({
        actorRef: 'alice',
        feature: 'embeddings',
        modelId: 'text-embedding-3-small',
        inputTokens: 10,
        requests: 12,
      });
      expect((await gov.spendByModel(range))[0]?.requests).toBe(12);
      expect((await gov.spendByActor(range))[0]?.requests).toBe(12);
      expect((await gov.spendByFeature?.(range))?.[0]?.requests).toBe(12);
    });
  });
}
