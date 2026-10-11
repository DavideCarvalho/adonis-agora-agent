import type { GenuiErrorCategory } from './genui/sandbox-validate.js';
/**
 * Generative-UI telemetry: one row per UI tool call (`ui__render`, `ui__sandbox`, `ui__show_*`,
 * `ui__show`), recorded by the loop through `AgentStore.recordGenuiCalls` and read back by the
 * dashboard's "Generative UI" page through `AgentGovernanceQueries.genuiStats`.
 *
 * PRIVACY: a row is metadata — names, counts, timings, an error's category and a scrubbed message.
 * The generated HTML/JSX and props are stored only when the tool was built with
 * `telemetry: { samplePayloads: true }` (off by default).
 */
import type { AgentStore, CostSource } from './spi/agent-store.js';
import type { GovernanceRange } from './spi/governance-queries.js';
import type { SinkWriter, StreamFrame } from './spi/token-stream-sink.js';
import type { GenuiToolMarker } from './types.js';

export type { GenuiErrorCategory } from './genui/sandbox-validate.js';

/**
 * How a call fared: `first_try` — accepted on the turn's first UI attempt; `retried` — accepted
 * after one or more refused attempts; `failed` — refused (the model was handed the error).
 */
export type GenuiValidity = 'first_try' | 'retried' | 'failed';

/** One UI tool call, as the loop records it. */
export interface RecordGenuiCallInput {
  /** The tool call's id — the row's key (a replayed record overwrites, never duplicates). */
  toolCallId: string;
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
  /** The model step (0-based) that wrote the call. */
  step: number;
  toolName: string;
  /** The turn's channel (`web`, `whatsapp`, …). */
  channel: string;
  mode: GenuiToolMarker['mode'];
  modelId: string;
  /** 1 + the UI calls refused since the turn's last accepted one. */
  attempt: number;
  outcome: 'ok' | 'error';
  validity: GenuiValidity;
  errorCategory?: GenuiErrorCategory;
  /** The error, with quoted values replaced by `"…"` (verbatim with `samplePayloads`). At most 300 chars. */
  errorMessage?: string;
  /**
   * The call's share of the step that wrote it — the step's tokens and cost split by the characters
   * each tool call's arguments (and the step's text) took.
   */
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  costSource?: CostSource;
  /** Turn start → the call's first `ui` frame (a streaming preview or the pushed component), in ms. */
  firstFrameMs?: number;
  /** Turn start → the call's final (non-partial) `ui` frame, in ms. Absent for a refused call. */
  completeFrameMs?: number;
  /** Size of the call's arguments, as JSON. */
  payloadBytes: number;
  /** The call's arguments as JSON — ONLY with `telemetry.samplePayloads`. */
  payload?: string;
}

/** A stored {@link RecordGenuiCallInput}. */
export interface GenuiCallRow extends RecordGenuiCallInput {
  createdAt: Date;
}

/** First-try success for one tool and model. */
export interface GenuiToolModelRow {
  toolName: string;
  modelId: string;
  mode: string;
  calls: number;
  /** Turns whose first UI attempt used this tool. */
  firstAttempts: number;
  firstTrySuccesses: number;
  /** `firstTrySuccesses / firstAttempts`; null when there is none. */
  firstTryRate: number | null;
  retried: number;
  failed: number;
  costUsd: number | null;
}

export interface GenuiErrorRow {
  category: string;
  /** The (scrubbed) message, as recorded. */
  message: string;
  toolName: string;
  count: number;
  lastAt: string;
}

export interface GenuiDayRow {
  day: string;
  calls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  firstTryRate: number | null;
}

export interface GenuiLatency {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** What the dashboard's Generative UI page shows. */
export interface GenuiStats {
  totals: {
    calls: number;
    turns: number;
    firstAttempts: number;
    firstTrySuccesses: number;
    firstTryRate: number | null;
    retried: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
  byToolModel: GenuiToolModelRow[];
  /** Most frequent first, at most 20. */
  errors: GenuiErrorRow[];
  byDay: GenuiDayRow[];
  /** UI cost per turn (turns with at least one UI call). */
  costPerTurn: {
    turns: number;
    avgUsd: number | null;
    p50Usd: number | null;
    p95Usd: number | null;
  };
  /**
   * Per turn: turn start → its first UI frame, and → the first complete UI frame of an accepted call.
   */
  latency: { firstFrame: GenuiLatency; complete: GenuiLatency };
}

/** Which kind of mistake a UI tool's error message is (what the genui tools and the registry throw). */
export function classifyGenuiError(message: string): GenuiErrorCategory {
  const code = /^invalid .+? code: (.*)$/s.exec(message);
  if (code !== null) {
    const first = code[1] ?? '';
    if (/the bridge (is|has one method)/.test(first)) return 'bridge';
    if (/: no `App`/.test(first)) return 'missing-app';
    if (/is not a kit component|does not exist here/.test(first)) return 'unknown-component';
    return 'syntax';
  }
  if (/is not available here|not available (on this channel|in this conversation)/i.test(message))
    return 'unavailable';
  if (/^invalid (UI tree|.+ props|.+ call): /.test(message)) return 'shape';
  if (/^Invalid input for tool "/.test(message)) return 'shape';
  return 'other';
}

/** An error message without the values it quotes (a schema's "received 'Jane'"), at most 300 chars. */
export function scrubGenuiError(message: string): string {
  const scrubbed = message
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '"…"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "'…'");
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 299)}…` : scrubbed;
}

// ─── Aggregation (every store's `genuiStats`) ───────────────────────────────────────────────────

/** Rows created within the (inclusive, UTC) day range. */
export function genuiRowsInRange<T extends { createdAt: Date }>(
  rows: readonly T[],
  range: GovernanceRange,
): T[] {
  const start = new Date(`${range.fromDay}T00:00:00.000Z`);
  const end = new Date(`${range.toDay}T23:59:59.999Z`);
  return rows.filter((row) => row.createdAt >= start && row.createdAt <= end);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

function rate(successes: number, attempts: number): number | null {
  return attempts === 0 ? null : successes / attempts;
}

function addCost(total: number | null, cost: number | undefined | null): number | null {
  if (cost === undefined || cost === null) return total;
  return (total ?? 0) + cost;
}

/** {@link GenuiStats} from the rows of a range — the same numbers whichever store holds them. */
export function summarizeGenuiCalls(rows: readonly GenuiCallRow[]): GenuiStats {
  const byRun = new Map<string, GenuiCallRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  const toolModel = new Map<string, GenuiToolModelRow>();
  const keyOf = (row: GenuiCallRow) => `${row.toolName}\u0000${row.modelId}`;
  const groupOf = (row: GenuiCallRow): GenuiToolModelRow => {
    let group = toolModel.get(keyOf(row));
    if (group === undefined) {
      group = {
        toolName: row.toolName,
        modelId: row.modelId,
        mode: row.mode,
        calls: 0,
        firstAttempts: 0,
        firstTrySuccesses: 0,
        firstTryRate: null,
        retried: 0,
        failed: 0,
        costUsd: null,
      };
      toolModel.set(keyOf(row), group);
    }
    return group;
  };
  const totals: GenuiStats['totals'] = {
    calls: rows.length,
    turns: byRun.size,
    firstAttempts: 0,
    firstTrySuccesses: 0,
    firstTryRate: null,
    retried: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };
  const errors = new Map<string, GenuiErrorRow>();
  const days = new Map<
    string,
    GenuiDayRow & { runs: Set<string>; attempts: number; successes: number }
  >();
  for (const row of rows) {
    const group = groupOf(row);
    group.calls += 1;
    group.costUsd = addCost(group.costUsd, row.costUsd);
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd = addCost(totals.costUsd, row.costUsd);
    const first = row.attempt === 1;
    if (first) {
      group.firstAttempts += 1;
      totals.firstAttempts += 1;
    }
    if (row.validity === 'first_try') {
      group.firstTrySuccesses += 1;
      totals.firstTrySuccesses += 1;
    } else if (row.validity === 'retried') {
      group.retried += 1;
      totals.retried += 1;
    } else {
      group.failed += 1;
      totals.failed += 1;
      const category = row.errorCategory ?? 'other';
      const message = row.errorMessage ?? '';
      const key = `${category}\u0000${row.toolName}\u0000${message}`;
      const at = row.createdAt.toISOString();
      const entry = errors.get(key) ?? {
        category,
        message,
        toolName: row.toolName,
        count: 0,
        lastAt: at,
      };
      entry.count += 1;
      if (at > entry.lastAt) entry.lastAt = at;
      errors.set(key, entry);
    }
    const day = row.createdAt.toISOString().slice(0, 10);
    const bucket = days.get(day) ?? {
      day,
      calls: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      firstTryRate: null,
      runs: new Set<string>(),
      attempts: 0,
      successes: 0,
    };
    bucket.calls += 1;
    bucket.runs.add(row.runId);
    bucket.inputTokens += row.inputTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.costUsd = addCost(bucket.costUsd, row.costUsd);
    if (first) bucket.attempts += 1;
    if (row.validity === 'first_try') bucket.successes += 1;
    days.set(day, bucket);
  }
  totals.firstTryRate = rate(totals.firstTrySuccesses, totals.firstAttempts);
  for (const group of toolModel.values()) {
    group.firstTryRate = rate(group.firstTrySuccesses, group.firstAttempts);
  }
  const turnCosts: number[] = [];
  const firstFrames: number[] = [];
  const completes: number[] = [];
  for (const list of byRun.values()) {
    let cost: number | null = null;
    let firstFrame: number | undefined;
    let complete: number | undefined;
    for (const row of list) {
      cost = addCost(cost, row.costUsd);
      if (row.firstFrameMs !== undefined && row.firstFrameMs !== null) {
        firstFrame = Math.min(firstFrame ?? row.firstFrameMs, row.firstFrameMs);
      }
      if (
        row.outcome === 'ok' &&
        row.completeFrameMs !== undefined &&
        row.completeFrameMs !== null
      ) {
        complete = Math.min(complete ?? row.completeFrameMs, row.completeFrameMs);
      }
    }
    if (cost !== null) turnCosts.push(cost);
    if (firstFrame !== undefined) firstFrames.push(firstFrame);
    if (complete !== undefined) completes.push(complete);
  }
  const ascending = (values: number[]) => [...values].sort((a, b) => a - b);
  const costs = ascending(turnCosts);
  const firstSorted = ascending(firstFrames);
  const completeSorted = ascending(completes);
  return {
    totals,
    byToolModel: [...toolModel.values()].sort(
      (a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName),
    ),
    errors: [...errors.values()]
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
      .slice(0, 20),
    byDay: [...days.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(({ runs, attempts, successes, ...day }) => ({
        ...day,
        turns: runs.size,
        firstTryRate: rate(successes, attempts),
      })),
    costPerTurn: {
      turns: byRun.size,
      avgUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) / costs.length,
      p50Usd: percentile(costs, 0.5),
      p95Usd: percentile(costs, 0.95),
    },
    latency: {
      firstFrame: {
        samples: firstSorted.length,
        p50Ms: percentile(firstSorted, 0.5),
        p95Ms: percentile(firstSorted, 0.95),
      },
      complete: {
        samples: completeSorted.length,
        p50Ms: percentile(completeSorted, 0.5),
        p95Ms: percentile(completeSorted, 0.95),
      },
    },
  };
}

// ─── The loop's side ────────────────────────────────────────────────────────────────────────────

/** When each tool call's first and final `ui` frames went out on the turn's stream. */
export interface GenuiFrameTimes {
  first?: number;
  complete?: number;
}

/**
 * Wraps the turn's stream writer to note when each tool call's UI frames (`component`) are written —
 * what the user sees, so the time to first frame counts a streaming preview, and a frame a gate
 * held back counts when it was released.
 */
export function observeGenuiFrames(
  writer: SinkWriter,
  now: () => number = Date.now,
): { writer: SinkWriter; times: Map<string, GenuiFrameTimes> } {
  const times = new Map<string, GenuiFrameTimes>();
  const note = (frame: StreamFrame) => {
    let toolCallId: unknown;
    let partial: unknown;
    if (frame.t === 'component') {
      toolCallId = frame.toolCallId;
      partial = frame.partial;
    } else if (frame.t === 'event' && frame.event.kind === 'ui') {
      toolCallId = frame.event.toolCallId;
      partial = frame.event.partial;
    } else {
      return;
    }
    if (typeof toolCallId !== 'string') return;
    const at = now();
    const entry = times.get(toolCallId) ?? {};
    entry.first ??= at;
    if (partial !== true) entry.complete ??= at;
    times.set(toolCallId, entry);
  };
  const wrapped: SinkWriter = Object.create(writer) as SinkWriter;
  wrapped.write = (frame: StreamFrame) => {
    try {
      note(frame);
    } catch {
      // Telemetry never stands in the stream's way.
    }
    return writer.write(frame);
  };
  wrapped.end = () => writer.end();
  if (typeof writer.flush === 'function') {
    wrapped.flush = () => (writer.flush as () => void | Promise<void>).call(writer);
  }
  return { writer: wrapped, times };
}

/** What the loop knows about one step, to turn its UI calls into rows. */
export interface GenuiStepFacts {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
  step: number;
  channel: string;
  modelId: string;
  /** When the turn started; absent → no latency is recorded (an engine that cannot tell). */
  startedAt?: number;
  /** The step's model usage and cost (the whole step: shared out by characters written). */
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number | null;
  costSource?: CostSource;
  text: string;
  calls: readonly { id: string; name: string; input: unknown }[];
  /** Each call's result: an `error` when it was refused or failed. */
  results: readonly { id: string; error?: string; output?: unknown }[];
  /** A call's genui marker, or undefined for a tool that is not a UI tool. */
  markerOf(name: string): GenuiToolMarker | undefined;
  frames: Map<string, GenuiFrameTimes>;
  /** When the step's results settled (a call whose frames went out unobserved completes here). */
  now: number;
}

/**
 * Tracks the turn's UI attempts across steps: a refused UI call followed by another is a retry,
 * whichever UI tool the second one uses.
 */
export class GenuiTurnTelemetry {
  private refusedSinceAccepted = 0;

  rows(facts: GenuiStepFacts): RecordGenuiCallInput[] {
    const sizes = facts.calls.map((call) => jsonSize(call.input));
    const written = facts.text.length + sizes.reduce((a, b) => a + b, 0);
    const rows: RecordGenuiCallInput[] = [];
    facts.calls.forEach((call, index) => {
      const marker = facts.markerOf(call.name);
      if (marker === undefined || marker.telemetry === false) return;
      const result = facts.results.find((each) => each.id === call.id);
      if (result === undefined) return;
      const share = written === 0 ? 1 / facts.calls.length : (sizes[index] ?? 0) / written;
      const failed = result.error !== undefined;
      const attempt = this.refusedSinceAccepted + 1;
      if (failed) this.refusedSinceAccepted += 1;
      else this.refusedSinceAccepted = 0;
      const sample = marker.telemetry !== undefined && marker.telemetry.samplePayloads === true;
      const times = facts.frames.get(call.id);
      const pushed = !failed && hasUi(result.output);
      const complete = times?.complete ?? (pushed ? facts.now : undefined);
      rows.push({
        toolCallId: call.id,
        runId: facts.runId,
        threadId: facts.threadId,
        actorRef: facts.actorRef,
        ...(facts.agentName !== undefined ? { agentName: facts.agentName } : {}),
        step: facts.step,
        toolName: call.name,
        channel: facts.channel,
        mode: marker.mode,
        modelId: facts.modelId,
        attempt,
        outcome: failed ? 'error' : 'ok',
        validity: failed ? 'failed' : attempt === 1 ? 'first_try' : 'retried',
        ...(failed
          ? {
              errorCategory: classifyGenuiError(result.error ?? ''),
              errorMessage: sample
                ? (result.error ?? '').slice(0, 300)
                : scrubGenuiError(result.error ?? ''),
            }
          : {}),
        inputTokens: Math.round(facts.usage.inputTokens * share),
        outputTokens: Math.round(facts.usage.outputTokens * share),
        ...(facts.costUsd !== null ? { costUsd: facts.costUsd * share } : {}),
        ...(facts.costUsd !== null && facts.costSource !== undefined
          ? { costSource: facts.costSource }
          : {}),
        ...latency(facts.startedAt, times?.first ?? complete, failed ? undefined : complete),
        payloadBytes: sizes[index] ?? 0,
        ...(sample ? { payload: JSON.stringify(call.input ?? null).slice(0, 200_000) } : {}),
      });
    });
    return rows;
  }
}

/** The two latencies from the turn's start, when it is known. */
function latency(
  startedAt: number | undefined,
  first: number | undefined,
  complete: number | undefined,
): { firstFrameMs?: number; completeFrameMs?: number } {
  if (startedAt === undefined) return {};
  return {
    ...(first !== undefined ? { firstFrameMs: Math.max(0, first - startedAt) } : {}),
    ...(complete !== undefined ? { completeFrameMs: Math.max(0, complete - startedAt) } : {}),
  };
}

/** One UI call made outside the agent loop, for {@link GenuiRunRecorder.track}. */
export interface GenuiOutOfLoopCall {
  store: Pick<AgentStore, 'recordGenuiCalls'>;
  /** The tool's `spec.genui`; not a UI tool (undefined) or telemetry off → nothing is recorded. */
  marker: GenuiToolMarker | undefined;
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
  channel: string;
  modelId: string;
  call: { id: string; name: string; input: unknown };
}

/**
 * Genui telemetry for an engine whose tools are called OUTSIDE the agent loop (OpenCode's MCP
 * endpoint, which its code mode calls): one row per UI call, attempts counted per run. There the
 * model's step is not split per call (tokens 0, no cost) and the frames are not timed (no latency).
 * Recording is best-effort and never changes what the call returns or throws.
 */
export class GenuiRunRecorder {
  private readonly runs = new Map<string, GenuiTurnTelemetry>();

  constructor(private readonly maxRuns = 1000) {}

  async track<T>(input: GenuiOutOfLoopCall, invoke: () => Promise<T>): Promise<T> {
    const { marker, store } = input;
    if (
      marker === undefined ||
      marker.telemetry === false ||
      store.recordGenuiCalls === undefined
    ) {
      return invoke();
    }
    let output: unknown;
    let error: string | undefined;
    try {
      output = await invoke();
      return output as T;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      throw thrown;
    } finally {
      try {
        const rows = this.turn(input.runId).rows({
          runId: input.runId,
          threadId: input.threadId,
          actorRef: input.actorRef,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
          step: 0,
          channel: input.channel,
          modelId: input.modelId,
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: null,
          text: '',
          calls: [input.call],
          results: [
            error !== undefined ? { id: input.call.id, error } : { id: input.call.id, output },
          ],
          markerOf: () => marker,
          frames: new Map(),
          now: Date.now(),
        });
        if (rows.length > 0) await store.recordGenuiCalls(rows);
      } catch {
        // Telemetry is best-effort.
      }
    }
  }

  private turn(runId: string): GenuiTurnTelemetry {
    let turn = this.runs.get(runId);
    if (turn === undefined) {
      turn = new GenuiTurnTelemetry();
      this.runs.set(runId, turn);
      if (this.runs.size > this.maxRuns) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) this.runs.delete(oldest);
      }
    }
    return turn;
  }
}

/** A genui tool's output (`{ shown, id }`) says it pushed a frame. */
function hasUi(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    typeof (output as { id?: unknown }).id === 'string'
  );
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}
