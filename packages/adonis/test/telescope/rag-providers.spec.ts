import { describe, expect, it } from 'vitest';
import {
  meanChunks,
  ragChunksProvider,
  ragRetrievalsProvider,
  ragTrendProvider,
  ragZeroHitRateProvider,
  zeroHitRate,
} from '../../src/telescope/rag-data-providers.js';
import type { ExtensionContext, TelescopeEntryLike } from '../../src/telescope/telescope-sdk.js';

/**
 * A captured `agora:agent:retrieved` diagnostic entry, exactly as Telescope's generic diagnostics
 * watcher records it (same envelope shape `extension.spec.ts` uses for the entry-backed providers).
 */
function retrievedEntry(
  payload: { runId?: string; queryLength?: number; count?: number } = {},
  createdAt = new Date(),
): TelescopeEntryLike {
  return {
    content: { v: 1, lib: 'agent', event: 'retrieved', ts: +createdAt, payload },
    createdAt,
  };
}

/** A non-retrieval entry, to prove the RAG providers filter the shared `lib:agent` slice down. */
function otherEntry(event: string, createdAt = new Date()): TelescopeEntryLike {
  return { content: { v: 1, lib: 'agent', event, ts: +createdAt, payload: {} }, createdAt };
}

function makeCtx(entries: TelescopeEntryLike[] = []): ExtensionContext {
  return {
    store: {
      list: async (query) => {
        // RAG providers read the SAME `lib:agent` slice everything else does — no dedicated entry type.
        expect(query).toMatchObject({ type: 'diagnostic', tag: 'lib:agent' });
        return entries;
      },
    },
    container: { make: async () => undefined as never },
    config: {},
  };
}

describe('zeroHitRate', () => {
  it('is 0 over an empty window', () => {
    expect(zeroHitRate([])).toBe(0);
  });

  it('is the fraction of retrievals with count === 0', () => {
    expect(
      zeroHitRate([
        { at: 0, queryLength: 1, count: 0 },
        { at: 0, queryLength: 1, count: 3 },
        { at: 0, queryLength: 1, count: 0 },
        { at: 0, queryLength: 1, count: 1 },
      ]),
    ).toBe(0.5);
  });
});

describe('meanChunks', () => {
  it('is 0 over an empty window', () => {
    expect(meanChunks([])).toBe(0);
  });

  it('is the mean `count` across retrievals, rounded to 2 places', () => {
    expect(
      meanChunks([
        { at: 0, queryLength: 1, count: 1 },
        { at: 0, queryLength: 1, count: 2 },
        { at: 0, queryLength: 1, count: 2 },
      ]),
    ).toBeCloseTo(1.67, 2);
  });
});

describe('rag data providers read only `retrieved` entries out of the shared lib:agent slice', () => {
  it('ragRetrievals counts only retrieved entries, ignoring other agent events', async () => {
    const ctx = makeCtx([
      retrievedEntry({ count: 3 }),
      retrievedEntry({ count: 0 }),
      otherEntry('run.started'),
      otherEntry('tool-call'),
    ]);
    expect(await ragRetrievalsProvider().resolve(undefined, ctx)).toEqual({ value: 2 });
  });

  it('ragZeroHitRate reads count === 0 as a zero-hit', async () => {
    const ctx = makeCtx([retrievedEntry({ count: 0 }), retrievedEntry({ count: 5 })]);
    expect(await ragZeroHitRateProvider().resolve(undefined, ctx)).toEqual({ value: 0.5 });
  });

  it('ragChunks is the mean passage count', async () => {
    const ctx = makeCtx([retrievedEntry({ count: 2 }), retrievedEntry({ count: 4 })]);
    expect(await ragChunksProvider().resolve(undefined, ctx)).toEqual({ value: 3 });
  });

  it('degrade to zero over an empty/non-retrieval window', async () => {
    const ctx = makeCtx([otherEntry('run.finished')]);
    expect(await ragRetrievalsProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await ragZeroHitRateProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
    expect(await ragChunksProvider().resolve(undefined, ctx)).toEqual({ value: 0 });
  });

  it('ragTrend buckets retrievals and zero-hits together, mirroring the agent timeseries providers', async () => {
    const ctx = makeCtx([
      retrievedEntry({ count: 0 }),
      retrievedEntry({ count: 1 }),
      retrievedEntry({ count: 2 }),
      otherEntry('run.started'),
    ]);
    const res = (await ragTrendProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ retrievals: number; zeroHits: number }>;
    };
    expect(res.rows[0]).toMatchObject({ retrievals: 3, zeroHits: 1 });
  });

  it('ragTrend is empty (all-zero buckets) over an empty window', async () => {
    const ctx = makeCtx([]);
    const res = (await ragTrendProvider().resolve({ buckets: 4 }, ctx)) as {
      rows: Array<{ retrievals: number; zeroHits: number }>;
    };
    expect(res.rows).toHaveLength(4);
    expect(res.rows.every((r) => r.retrievals === 0 && r.zeroHits === 0)).toBe(true);
  });
});
