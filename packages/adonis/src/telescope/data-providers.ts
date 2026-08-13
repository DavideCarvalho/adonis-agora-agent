import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

/**
 * The agent "Agent" dashboard data providers. Every provider here is ENTRY-BACKED: it aggregates the
 * `agora:agent:*` lifecycle events that `@adonis-agora/agent` emits through `@adonis-agora/diagnostics`
 * (via `src/diagnostics.ts`'s `publishAgent`) and that `@adonis-agora/telescope`'s generic diagnostics
 * watcher records — one entry per publish, stored as `type: 'diagnostic'`, `tag: 'lib:agent'`, with the
 * agent payload preserved verbatim under `content.payload`.
 *
 * No agent-specific watcher is contributed: capture is entirely handled by the generic bridge, so the
 * extension only has to SURFACE the recorded history. This mirrors `@adonis-agora/media/telescope`'s
 * entry-backed providers, and needs zero coupling to the agent container internals — no NestJS-style
 * DI/read-model resolution.
 */

/**
 * Newest-first cap on how many recorded agent entries a provider scans. Shared by every
 * `lib:agent` consumer of `fetchEntries` — including `rag-data-providers.ts`, since retrieval
 * events are recorded on this SAME generic slice (Adonis's diagnostics bridge has no per-event
 * entry type to give RAG its own window; see that file's header for what this implies).
 */
export const ENTRY_LIMIT = 5_000;

/** Default rollup window: 24h. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Telescope diagnostic-entry `content` the generic watcher produces for an agent event. `event` is
 * the agent event name (e.g. `run.finished`); the agent library's own payload is nested under `payload`.
 */
interface AgentEntryContent {
  event?: string;
  payload?: {
    runId?: string;
    threadId?: string;
    actorId?: string;
    persona?: string;
    toolName?: string;
    toolType?: 'read' | 'action';
    status?: string;
    durationMs?: number;
    steps?: number;
    inputTokens?: number;
    outputTokens?: number;
    fromAgent?: string;
    toAgent?: string;
    count?: number;
    usedTokens?: number;
    limitTokens?: number;
  };
}

const contentOf = (e: TelescopeEntryLike): AgentEntryContent =>
  (e.content ?? {}) as AgentEntryContent;

/** Epoch millis of an entry's `createdAt`, or `0` when absent. Exported for `rag-data-providers.ts`. */
export const atOf = (e: TelescopeEntryLike): number => (e.createdAt ? +new Date(e.createdAt) : 0);

const isoTime = (ms: number): string =>
  ms ? `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}Z` : '';

/** Fetch captured `agora:agent:*` entries from Telescope storage (newest-first). */
export async function fetchEntries(
  ctx: ExtensionContext,
  limit = ENTRY_LIMIT,
): Promise<TelescopeEntryLike[]> {
  return ctx.store.list({ type: 'diagnostic', tag: 'lib:agent', limit });
}

function countEvent(entries: TelescopeEntryLike[], event: string): number {
  let n = 0;
  for (const e of entries) if (contentOf(e).event === event) n += 1;
  return n;
}

/** Split entries into current `(now-window, now]` and previous `(now-2window, now-window]`. */
function splitWindows(
  entries: TelescopeEntryLike[],
  windowMs: number,
  now: number,
): { current: TelescopeEntryLike[]; previous: TelescopeEntryLike[] } {
  if (windowMs <= 0) return { current: entries, previous: [] };
  const start = now - windowMs;
  const prevStart = start - windowMs;
  return {
    current: entries.filter((e) => atOf(e) > start && atOf(e) <= now),
    previous: entries.filter((e) => atOf(e) > prevStart && atOf(e) <= start),
  };
}

/**
 * Build N equal-width time buckets spanning from the oldest entry to now, each starting empty.
 * Exported so `rag-data-providers.ts` buckets retrieval entries the same way the agent providers
 * bucket everything else, instead of a second, drifting bucketing scheme.
 */
export function timeBuckets<TRow extends Record<string, number>>(
  entries: TelescopeEntryLike[],
  count: number,
  emptyRow: () => TRow,
): { rows: Array<{ label: string } & TRow>; minTime: number; bucketSize: number } {
  const now = Date.now();
  let minTime = now;
  for (const e of entries) {
    const at = atOf(e) || now;
    if (at < minTime) minTime = at;
  }
  const span = Math.max(now - minTime, 1);
  const bucketSize = span / count;
  const rows = Array.from({ length: count }, (_, i) => ({
    label: new Date(minTime + i * bucketSize).toISOString().slice(11, 16),
    ...emptyRow(),
  }));
  return { rows, minTime, bucketSize };
}

/** Which of `timeBuckets`'s N buckets `e` falls into, clamped to `[0, count-1]`. */
export function bucketIndexFor(
  e: TelescopeEntryLike,
  minTime: number,
  bucketSize: number,
  count: number,
): number {
  const at = atOf(e) || minTime;
  return Math.min(count - 1, Math.max(0, Math.floor((at - minTime) / bucketSize)));
}

// ─── Runs ───────────────────────────────────────────────────────────────────

/**
 * Net in-flight runs = `run.started` − `run.finished` over the window (default 24h; `windowMs: 0` =
 * all-time). Floored at 0. A cheap "how many agent runs are live right now" stat derived purely from the
 * captured event stream — no live run store is consulted.
 */
export function agentActiveRunsProvider(): DataProvider {
  return {
    name: 'agent.activeRuns',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const { current } = splitWindows(await fetchEntries(ctx), windowMs, Date.now());
      const started = countEvent(current, 'run.started');
      const finished = countEvent(current, 'run.finished');
      return { value: Math.max(0, started - finished) };
    },
  };
}

/**
 * Token usage = total (input + output) tokens summed from `run.finished` over the window (default 24h),
 * with `delta` vs the prior window and an 8-point spark. The entry-backed proxy for "spend/usage" — no
 * pricing read-model is joined (that would need host DI, which this extension deliberately avoids).
 */
export function agentTokenUsageProvider(): DataProvider {
  return {
    name: 'agent.tokenUsage',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const now = Date.now();
      const { current, previous } = splitWindows(await fetchEntries(ctx), windowMs, now);
      const tokensOf = (list: TelescopeEntryLike[]): number => {
        let total = 0;
        for (const e of list) {
          if (contentOf(e).event !== 'run.finished') continue;
          const p = contentOf(e).payload ?? {};
          total += (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
        }
        return total;
      };
      const value = tokensOf(current);
      const delta = previous.length > 0 ? value - tokensOf(previous) : undefined;
      const sparkBuckets = 8;
      const bucketMs = (windowMs > 0 ? windowMs : Math.max(now, 1)) / sparkBuckets;
      const start = now - (windowMs > 0 ? windowMs : now);
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const from = start + i * bucketMs;
        return tokensOf(current.filter((e) => atOf(e) > from && atOf(e) <= from + bucketMs));
      });
      return delta === undefined ? { value, spark } : { value, delta, spark };
    },
  };
}

/**
 * Tool-call success rate = executed / (executed + rejected + failed) over the window; 1 when no data.
 * `rejected` counts an approval that was denied — a first-class governance signal, not a crash.
 */
export function agentToolCallSuccessRateProvider(): DataProvider {
  return {
    name: 'agent.toolCallSuccessRate',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const { current } = splitWindows(await fetchEntries(ctx), windowMs, Date.now());
      let executed = 0;
      let other = 0;
      for (const e of current) {
        if (contentOf(e).event !== 'tool-call') continue;
        const status = contentOf(e).payload?.status;
        if (status === 'executed') executed += 1;
        else if (status === 'rejected' || status === 'failed') other += 1;
      }
      const total = executed + other;
      return { value: total === 0 ? 1 : executed / total, min: 0, max: 1 };
    },
  };
}

/** Runs over time — `run.started` (started) vs `run.finished` (finished) per bucket. */
export function agentRunsOverTimeProvider(): DataProvider {
  return {
    name: 'agent.runsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        started: 0,
        finished: 0,
      }));
      for (const e of entries) {
        const event = contentOf(e).event;
        if (event !== 'run.started' && event !== 'run.finished') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        if (event === 'run.started') row.started += 1;
        else row.finished += 1;
      }
      return { rows };
    },
  };
}

/** Token throughput over time — input/output tokens per bucket, summed from `run.finished`. */
export function agentTokensOverTimeProvider(): DataProvider {
  return {
    name: 'agent.tokensOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        input: 0,
        output: 0,
      }));
      for (const e of entries) {
        if (contentOf(e).event !== 'run.finished') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        const p = contentOf(e).payload ?? {};
        row.input += p.inputTokens ?? 0;
        row.output += p.outputTokens ?? 0;
      }
      return { rows };
    },
  };
}

/** Recent finished runs (newest first) as table rows: time, run, thread, steps, tokens. */
export function agentRecentRunsProvider(): DataProvider {
  return {
    name: 'agent.recentRuns',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter((e) => contentOf(e).event === 'run.finished')
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: isoTime(atOf(e)),
            runId: p.runId ?? '',
            thread: p.threadId ?? '',
            steps: p.steps ?? 0,
            tokens: (p.inputTokens ?? 0) + (p.outputTokens ?? 0),
          };
        });
      return { rows };
    },
  };
}

// ─── Tools & approvals ────────────────────────────────────────────────────────

/** Tool calls over time — executed/rejected/failed per bucket (the `tool-call` event). */
export function agentToolCallsOverTimeProvider(): DataProvider {
  return {
    name: 'agent.toolCallsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        executed: 0,
        rejected: 0,
        failed: 0,
      }));
      for (const e of entries) {
        if (contentOf(e).event !== 'tool-call') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        const status = contentOf(e).payload?.status;
        if (status === 'executed') row.executed += 1;
        else if (status === 'rejected') row.rejected += 1;
        else if (status === 'failed') row.failed += 1;
      }
      return { rows };
    },
  };
}

/** Recent tool calls (newest first) as table rows: time, run, tool, type, status. */
export function agentRecentToolCallsProvider(): DataProvider {
  return {
    name: 'agent.recentToolCalls',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter((e) => contentOf(e).event === 'tool-call')
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: isoTime(atOf(e)),
            runId: p.runId ?? '',
            tool: p.toolName ?? '',
            type: p.toolType ?? '',
            status: p.status ?? '',
          };
        });
      return { rows };
    },
  };
}

/**
 * Recent approval decisions (newest first): the `action`-type tool calls — the ones that pass through
 * the human-approval gate — surfaced with their outcome (`executed` = approved/auto, `rejected` =
 * denied). Read-type tool calls never require approval and are excluded.
 */
export function agentRecentApprovalsProvider(): DataProvider {
  return {
    name: 'agent.recentApprovals',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter(
          (e) => contentOf(e).event === 'tool-call' && contentOf(e).payload?.toolType === 'action',
        )
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: isoTime(atOf(e)),
            runId: p.runId ?? '',
            tool: p.toolName ?? '',
            status: p.status ?? '',
          };
        });
      return { rows };
    },
  };
}

// ─── Delegations ────────────────────────────────────────────────────────────

/** Sub-agent delegations over time — the `delegated` event per bucket. */
export function agentDelegationsOverTimeProvider(): DataProvider {
  return {
    name: 'agent.delegationsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        delegations: 0,
      }));
      for (const e of entries) {
        if (contentOf(e).event !== 'delegated') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (row) row.delegations += 1;
      }
      return { rows };
    },
  };
}

/** Recent delegations (newest first) as table rows: time, run, from, to. */
export function agentRecentDelegationsProvider(): DataProvider {
  return {
    name: 'agent.recentDelegations',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter((e) => contentOf(e).event === 'delegated')
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: isoTime(atOf(e)),
            runId: p.runId ?? '',
            from: p.fromAgent ?? '',
            to: p.toAgent ?? '',
          };
        });
      return { rows };
    },
  };
}
