import { atOf, bucketIndexFor, ENTRY_LIMIT, fetchEntries, timeBuckets } from './data-providers.js';
import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

/**
 * RAG data providers for the "Agent" Telescope tab — a DELIBERATELY PARTIAL port of the Nest
 * reference's `rag-data-providers.ts`.
 *
 * ## What Adonis's retrieval instrumentation actually publishes
 *
 * `@adonis-agora/agent` has exactly ONE retrieval telemetry point today: `agent-loop.ts`'s
 * inject-mode retrieval path (`deps.retriever` configured) publishes `agora:agent:retrieved` via
 * `publishAgentRetrieved` (`src/diagnostics.ts`) with payload `{ runId, queryLength, count }` —
 * nothing else. Telescope's generic diagnostics bridge records it as any other `lib:agent` event:
 * `type: 'diagnostic'`, `tag: 'lib:agent'`, `content: { event: 'retrieved', payload: {...} }`.
 *
 * That payload has NO `store`, `collection`, `retriever` kind, `topScore`, or `durationMs` — unlike
 * `@dudousxd/nestjs-agent-rag`'s dedicated `aviary:rag:retrieval` channel, which is what lets the
 * Nest reference build latency histograms, score distributions, and store/collection breakdowns.
 * `agent-loop.ts` DOES span the retrieval (`spannedAgent('retrieval', ...)`, which carries `topK` and
 * a `count` result on its `asyncEnd`), but those spans ride raw `node:diagnostics_channel` sub-channels
 * (`agora:agent:retrieval:start/end/asyncStart/asyncEnd/error`) that NOTHING in `@adonis-agora/telescope`
 * subscribes to today — confirmed by reading its `diagnostics_watcher.ts` and every `metrics/*.ts` file:
 * the generic bridge only auto-subscribes to POINT channels a producer registers via
 * `@adonis-agora/diagnostics`'s `registry.channels`, and `spannedAgent` publishes on ad-hoc sub-channel
 * names it never registers there (by design — it avoids importing `@adonis-agora/diagnostics` at all).
 * So the span data is not lost, exactly, but nothing today turns it into a recorded Telescope entry;
 * building that bridge is a `@adonis-agora/telescope` (or `@adonis-agora/diagnostics`) change, not
 * something this file can conjure from the entries Telescope already has.
 *
 * ## What that leaves portable
 *
 * From `{ runId, queryLength, count }` alone: how many retrievals happened, what fraction came back
 * empty (`count === 0`), the mean passage count, and a retrievals/zero-hits trend. That is FOUR of the
 * Nest reference's ten RAG providers. The other six — latency distribution, score distribution,
 * store breakdown, retriever breakdown, per-collection table, slowest-retrievals table — are NOT
 * ported: there is no field in the recorded entry for any of them, and faking one (e.g. a
 * `durationMs` of 0 for every row) would render a chart that looks real and lies. Widening
 * `AgentRetrieved`'s payload (and `agent-loop.ts`'s publish call) to carry that data is the real fix;
 * it's a `src/diagnostics.ts`/`src/agent-loop.ts` instrumentation change, out of scope for a telescope
 * extension change, and is called out as the recommended follow-up.
 *
 * ## Shares the SAME 5,000-entry window as every other agent provider
 *
 * Unlike the Nest reference — where `RagTelescopeWatcher` gives retrieval events their OWN entry type
 * (`agent-rag`) specifically so a busy retrieval stream can never crowd `run.finished` out of the
 * agent window — Adonis has no per-extension entry-type/watcher mechanism (see `extension.ts`'s
 * header for why), so `retrieved` entries live in the exact same capped `lib:agent` slice
 * `data-providers.ts` reads. A retrieval-heavy deployment can push older `run.*`/`tool-call` entries
 * out of that window, and vice versa. This is an accepted, documented limitation, not an oversight.
 */

/** One retrieval, normalized out of an entry's `content.payload`. */
interface RagRetrieval {
  at: number;
  queryLength: number;
  count: number;
}

interface RetrievedEntryContent {
  event?: string;
  payload?: { runId?: string; queryLength?: number; count?: number };
}

const contentOf = (e: TelescopeEntryLike): RetrievedEntryContent =>
  (e.content ?? {}) as RetrievedEntryContent;

/** Read every recorded `retrieved` entry (newest first, capped at {@link ENTRY_LIMIT}). */
async function readRetrievals(ctx: ExtensionContext): Promise<RagRetrieval[]> {
  const entries = await fetchEntries(ctx, ENTRY_LIMIT);
  const retrievals: RagRetrieval[] = [];
  for (const entry of entries) {
    const content = contentOf(entry);
    if (content.event !== 'retrieved') continue;
    retrievals.push({
      at: atOf(entry),
      queryLength: content.payload?.queryLength ?? 0,
      count: content.payload?.count ?? 0,
    });
  }
  return retrievals;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Fraction (0–1) of retrievals that came back with nothing. `0` over an empty window. */
export function zeroHitRate(retrievals: RagRetrieval[]): number {
  if (retrievals.length === 0) return 0;
  const zeroHits = retrievals.filter((r) => r.count === 0).length;
  return round(zeroHits / retrievals.length, 4);
}

/** Mean passages returned per retrieval. `0` over an empty window. */
export function meanChunks(retrievals: RagRetrieval[]): number {
  if (retrievals.length === 0) return 0;
  return round(retrievals.reduce((sum, r) => sum + r.count, 0) / retrievals.length, 2);
}

/** Build a provider from one shaping step over every recorded retrieval. */
function retrievalProvider(
  name: string,
  format: (retrievals: RagRetrieval[]) => unknown,
): DataProvider {
  return {
    name,
    async resolve(_query, ctx) {
      return format(await readRetrievals(ctx));
    },
  };
}

/** stat → retrievals recorded in the current window. */
export function ragRetrievalsProvider(): DataProvider {
  return retrievalProvider('agent.rag.retrievals', (retrievals) => ({ value: retrievals.length }));
}

/** stat (percent) → share of retrievals that returned nothing. */
export function ragZeroHitRateProvider(): DataProvider {
  return retrievalProvider('agent.rag.zeroHitRate', (retrievals) => ({
    value: zeroHitRate(retrievals),
  }));
}

/** stat → mean passages returned per retrieval. */
export function ragChunksProvider(): DataProvider {
  return retrievalProvider('agent.rag.chunks', (retrievals) => ({ value: meanChunks(retrievals) }));
}

/** timeseries → retrievals and zero-hits per bucket, using the same bucketing every other agent
 * timeseries provider uses (`data-providers.ts`'s `timeBuckets`), not a second bucketing scheme. */
export function ragTrendProvider(): DataProvider {
  return {
    name: 'agent.rag.trend',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx, ENTRY_LIMIT);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const retrievedEntries = entries.filter((e) => contentOf(e).event === 'retrieved');
      const { rows, minTime, bucketSize } = timeBuckets(retrievedEntries, buckets, () => ({
        retrievals: 0,
        zeroHits: 0,
      }));
      for (const entry of retrievedEntries) {
        const row = rows[bucketIndexFor(entry, minTime, bucketSize, buckets)];
        if (!row) continue;
        row.retrievals += 1;
        if ((contentOf(entry).payload?.count ?? 0) === 0) row.zeroHits += 1;
      }
      return { rows };
    },
  };
}
