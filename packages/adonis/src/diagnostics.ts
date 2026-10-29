/**
 * The `@adonis-agora/diagnostics` emit capability, published on this global slot at that package's
 * module load. `@adonis-agora/agent` reads it STRUCTURALLY — it never imports or depends on the
 * diagnostics package. When diagnostics isn't installed the slot is empty and emitting is an inert
 * no-op that never throws back into the agent loop.
 *
 * Events land on `agora:agent:<event>`; the payload shapes below are the contract every consumer
 * (dashboard / telescope) reads.
 */
import diagnostics_channel, { type Channel } from 'node:diagnostics_channel';
import type { RunStepTiming } from './spi/agent-store.js';
import type { AgentStreamErrorCode } from './stream-events.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/** Payloads carried on each `agora:agent:*` channel. */
export interface AgentRunStarted {
  runId: string;
  threadId: string;
  actorId: string;
  persona?: string;
}
export interface AgentMessageEvent {
  runId: string;
  threadId: string;
  role: 'user' | 'assistant';
  textLength: number;
}
export interface AgentToolCallEvent {
  runId: string;
  /** The call's id — the same on every publication of it, so an observer can deduplicate. */
  toolCallId?: string;
  toolName: string;
  toolType: 'read' | 'action';
  status: string;
  /** How long the tool ran, when this process ran it (absent for a decision or a replay). */
  durationMs?: number;
  /**
   * The durable runtime replayed the call's checkpoint instead of running the tool: the call was
   * already published by the attempt that ran it. Observers that count calls skip these.
   */
  replayed?: boolean;
}
export interface AgentQuotaExceeded {
  actorId: string;
  usedTokens: number;
  limitTokens: number;
}
/**
 * Who and what a run is, carried by the run's terminal events so an observer can attribute them
 * without reading the store. All optional: a run that has none of them (the default agent, no
 * tenant) carries none.
 */
export interface AgentRunContext {
  /** The agent that handled the run; absent for the default agent. */
  agentName?: string;
  actorId?: string;
  tenantRef?: string;
  /** Set on a delegation's child run: the run that started it. Not a turn of its own. */
  parentRunId?: string;
}
export interface AgentRunFinished extends AgentRunContext {
  runId: string;
  threadId: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  /** From the turn's start in this process (a resumed run: its resume) to the end. */
  durationMs?: number;
  /** From the turn's start to the first `text` frame on the stream; absent when no text went out. */
  ttftMs?: number;
  /** The run's cost, from the steps whose cost is known; absent when none was. */
  costUsd?: number;
  /** The model of the run's last model call. */
  modelId?: string;
  /**
   * Enqueue → the run's body starting in a worker (the durable engine's run row `createdAt`, so the
   * enqueuing process's clock against the worker's); about 0 inline. Absent when it was not read.
   */
  queueMs?: number;
  /** Every model call's `llm.turn` time, summed. */
  modelMs?: number;
  /** Tool time, wall-clock: tools a step ran in parallel count once. */
  toolsMs?: number;
  /** Model calls measured. */
  modelCalls?: number;
  /** Tool calls measured. */
  toolCalls?: number;
  /** Each step's model time and its tool calls (name and ms). */
  stepTimings?: RunStepTiming[];
}
/**
 * A run that ended in an error (the loop threw). `code` is the stable code the stream's `error`
 * frame carries ({@link AgentStreamErrorCode}); the error itself is never on the event.
 */
export interface AgentRunFailed extends AgentRunContext {
  runId: string;
  threadId: string;
  code: AgentStreamErrorCode;
  /** From the turn's start in this process to the failure. */
  durationMs: number;
  /** Enqueue → body start, as on {@link AgentRunFinished.queueMs}; absent when not read yet. */
  queueMs?: number;
  /** What the run measured before it failed, as on {@link AgentRunFinished}. */
  modelMs?: number;
  toolsMs?: number;
  modelCalls?: number;
  toolCalls?: number;
  stepTimings?: RunStepTiming[];
}
/** A run someone stopped (its abort signal fired) before it finished. */
export interface AgentRunCancelled extends AgentRunContext {
  runId: string;
  threadId: string;
  durationMs: number;
  /** Enqueue → body start, as on {@link AgentRunFinished.queueMs}; absent when not read yet. */
  queueMs?: number;
}
export interface AgentDelegated {
  runId: string;
  fromAgent?: string;
  toAgent: string;
  /** The delegate was STARTED, not awaited — this run's turn ended without its answer. */
  detached?: boolean;
}
export interface AgentRetrieved {
  runId: string;
  /** Length of the query (not the text) — same redaction posture as {@link AgentMessageEvent}. */
  queryLength: number;
  count: number;
}
/**
 * A transient-classified tool error being retried in place (no new checkpoint) — see
 * `invokeWithTransientRetry`. Emitted once per retry (not for the final, non-retried outcome).
 */
export interface AgentToolRetry {
  runId: string;
  toolName: string;
  toolCallId: string;
  /** 1-based ordinal of the attempt that just failed and is about to be retried. */
  attempt: number;
  /** The failed attempt's error message. */
  message: string;
}

/**
 * One row written to the usage ledger — an agent turn's model call (chat, structured output, history
 * summary, retrieval embedding) or spend an app recorded through `AgentService.recordUsage`. Every AI
 * cost goes through this one event. Amounts and attribution only: never content, never `metadata`.
 */
export interface AgentUsageRecorded {
  /** Who pays; `@platform` for platform cost. */
  actorRef: string;
  /** What the spend was for: `agent:<name>` (or `agent`) for an agent turn, the app's own otherwise. */
  feature: string;
  /** The ledger `purpose`: `chat`, `structured_output`, `summary`, `embedding`… or `external`. */
  purpose: string;
  modelId: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  audioSeconds?: number;
  characters?: number;
  requests?: number;
  costUsd?: number;
  costSource?: 'provider' | 'estimate';
  threadId?: string;
  runId?: string;
  tenantRef?: string;
}

/** Maps each event name to its payload type, so {@link publishAgent} is checked at the call site. */
export interface AgentDiagnosticPayloads {
  'run.started': AgentRunStarted;
  message: AgentMessageEvent;
  'tool-call': AgentToolCallEvent;
  'quota.exceeded': AgentQuotaExceeded;
  'run.finished': AgentRunFinished;
  'run.failed': AgentRunFailed;
  'run.cancelled': AgentRunCancelled;
  delegated: AgentDelegated;
  retrieved: AgentRetrieved;
  'tool.retry': AgentToolRetry;
  'usage.recorded': AgentUsageRecorded;
}

export type AgentDiagnosticEvent = keyof AgentDiagnosticPayloads;

/**
 * Publish an agent event on `agora:agent:<event>` via the structural diagnostics slot. No-op when
 * diagnostics isn't installed (the slot is empty) — and it never throws back into the agent loop.
 */
export function publishAgent<E extends AgentDiagnosticEvent>(
  event: E,
  payload: AgentDiagnosticPayloads[E],
): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit === 'function') {
    try {
      emit('agent', event, payload);
    } catch {
      // diagnostics must never break an agent run
    }
  }
}

export function publishAgentRunStarted(payload: AgentRunStarted): void {
  publishAgent('run.started', payload);
}
export function publishAgentMessage(payload: AgentMessageEvent): void {
  publishAgent('message', payload);
}
export function publishAgentToolCall(payload: AgentToolCallEvent): void {
  publishAgent('tool-call', payload);
}
export function publishAgentQuotaExceeded(payload: AgentQuotaExceeded): void {
  publishAgent('quota.exceeded', payload);
}
export function publishAgentRunFailed(payload: AgentRunFailed): void {
  publishAgent('run.failed', payload);
}

export function publishAgentRunCancelled(payload: AgentRunCancelled): void {
  publishAgent('run.cancelled', payload);
}

export function publishAgentRunFinished(payload: AgentRunFinished): void {
  publishAgent('run.finished', payload);
}
export function publishAgentDelegated(payload: AgentDelegated): void {
  publishAgent('delegated', payload);
}
export function publishAgentRetrieved(payload: AgentRetrieved): void {
  publishAgent('retrieved', payload);
}
export function publishAgentToolRetry(payload: AgentToolRetry): void {
  publishAgent('tool.retry', payload);
}
export function publishAgentUsageRecorded(payload: AgentUsageRecorded): void {
  publishAgent('usage.recorded', payload);
}

// ── Run-tracing spans ─────────────────────────────────────────────────────────
//
// Point events above tell you WHAT happened; spans tell you the SHAPE of a turn — a start/end pair
// per genuinely-executed operation, all correlated by `traceId = runId`, so telescope renders one
// turn as a waterfall. Spans ride the SAME `agora:agent:*` convention as the point events, but on the
// five span sub-channels `agora:agent:<event>:<phase>` (start / end / asyncStart / asyncEnd / error) —
// byte-for-byte the wire shape `@adonis-agora/diagnostics`' own `trace()` publishes, so a span-aware
// bridge reads agent spans with ZERO agent→diagnostics coupling.
//
// We publish them directly over Node's builtin `node:diagnostics_channel` (a Node builtin — no
// diagnostics import, no emit slot needed), exactly as the media-ingestion subscribe path does. Cost
// is a handful of `hasSubscribers` reads when nothing is listening.
//
// REPLAY SAFETY: `spannedAgent` MUST be called from INSIDE a `hooks.step` body (→ `ctx.localStep`).
// Durable replay skips step bodies and returns the checkpoint, so a replayed run never re-emits a
// span. The root `turn` span (which spans the whole loop) is therefore a RUNNER concern: the inline
// runner emits it once around the loop; the durable runner does not emit a body-level root (it would
// re-emit per replay slice) and relies on the `traceId = runId` grouping to root the trace.

/** Span envelope schema version — matches `@adonis-agora/diagnostics`' `SPAN_SCHEMA_VERSION`. */
const SPAN_SCHEMA_VERSION = 1;
const SPAN_CHANNEL_PREFIX = 'agora';
const SPAN_LIB = 'agent';

/** The root span for a whole agent turn. `run.finished`-shaped summary rides its `asyncEnd`. */
export interface AgentTurnSpan {
  runId: string;
}
/** One model call. Summarized (never prompt/output text) with token counts + tool-call count. */
export interface AgentLlmTurnSpan {
  runId: string;
  step: number;
}
/** One tool invocation. Only the start payload's name/type ride the span — never the tool output. */
export interface AgentToolExecutionSpan {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolType: 'read' | 'action' | 'agent';
}
/** One inject-mode retrieval. Query LENGTH (not text) on start; passage `count` on end. */
export interface AgentRetrievalSpan {
  runId: string;
  queryLength: number;
  topK: number;
}

/** Maps each span event to its start payload, so {@link spannedAgent} is checked at the call site. */
export interface AgentSpanPayloads {
  turn: AgentTurnSpan;
  'llm.turn': AgentLlmTurnSpan;
  'tool.execution': AgentToolExecutionSpan;
  retrieval: AgentRetrievalSpan;
}
export type AgentSpanEvent = keyof AgentSpanPayloads;
type SpanPhase = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error';

/** The five resolved span sub-channels for one `(agent, event)` pair. */
interface SpanChannels {
  start: Channel;
  end: Channel;
  asyncStart: Channel;
  asyncEnd: Channel;
  error: Channel;
}

/** Per-event memo of the resolved span channels — the steady state is a single `Map.get`. */
const spanChannelCache = new Map<string, SpanChannels>();

function getSpanChannels(event: string): SpanChannels {
  const cached = spanChannelCache.get(event);
  if (cached !== undefined) {
    return cached;
  }
  const base = `${SPAN_CHANNEL_PREFIX}:${SPAN_LIB}:${event}`;
  const channels: SpanChannels = {
    start: diagnostics_channel.channel(`${base}:start`),
    end: diagnostics_channel.channel(`${base}:end`),
    asyncStart: diagnostics_channel.channel(`${base}:asyncStart`),
    asyncEnd: diagnostics_channel.channel(`${base}:asyncEnd`),
    error: diagnostics_channel.channel(`${base}:error`),
  };
  spanChannelCache.set(event, channels);
  return channels;
}

/** True when ANY of the five span sub-channels currently has a subscriber. */
function anySpanSubscribed(channels: SpanChannels): boolean {
  return (
    channels.start.hasSubscribers ||
    channels.end.hasSubscribers ||
    channels.asyncStart.hasSubscribers ||
    channels.asyncEnd.hasSubscribers ||
    channels.error.hasSubscribers
  );
}

let spanCounter = 0;
/** A cheap, process-unique span id. Allocated only when a span is actually observed. */
function nextSpanId(): string {
  spanCounter = (spanCounter + 1) >>> 0;
  return `${Date.now().toString(36)}-${spanCounter.toString(36)}`;
}

/** Publish one phase on its sub-channel; never throws back into the agent loop. */
function publishSpanPhase(
  channel: Channel,
  phase: SpanPhase,
  event: string,
  spanId: string,
  traceId: string,
  extra: { payload?: unknown; result?: unknown; error?: unknown; durationMs?: number },
): void {
  if (!channel.hasSubscribers) {
    return;
  }
  try {
    channel.publish({
      v: SPAN_SCHEMA_VERSION,
      ts: Date.now(),
      lib: SPAN_LIB,
      event,
      phase,
      spanId,
      traceId,
      ...extra,
    });
  } catch {
    // Observability must never break the traced code path.
  }
}

/**
 * Wrap a genuinely-executing async operation in an `agora:agent:<event>` span correlated to its run
 * by `traceId = runId`, WITHOUT letting the operation's raw return value ride the span envelope: only
 * the (redaction-safe) `summarize`d metadata is published as the span `result`, while the real value
 * is handed straight back to the caller. Zero-cost when no span sub-channel has a subscriber (runs
 * `run()` directly). Never throws from the span machinery — only `run()`'s own rejection propagates.
 *
 * Mirrors the async lifecycle of `@adonis-agora/diagnostics`' `trace()`: `start` → `end` (sync
 * portion) → `asyncStart` → `asyncEnd` (with the summary) on success, or `error` on rejection.
 *
 * MUST be called from inside a `hooks.step` body (→ `ctx.localStep`) so durable replay — which skips
 * step bodies — never re-emits the span. See the module header.
 */
export async function spannedAgent<E extends AgentSpanEvent, T>(
  event: E,
  traceId: string,
  payload: AgentSpanPayloads[E],
  run: () => Promise<T>,
  summarize: (value: T) => Record<string, unknown>,
): Promise<T> {
  return (await timedSpan(event, traceId, payload, run, summarize)).value;
}

/**
 * {@link spannedAgent}, also handing back how long the operation took — the SAME reading the span's
 * `asyncEnd` carries as `durationMs`, taken whether or not anyone subscribes. What the loop persists
 * as a run's model time, so the run row and the trace never disagree. Same replay rule: call it
 * inside a step body, and journal the duration with the step's result.
 */
export async function timedSpan<E extends AgentSpanEvent, T>(
  event: E,
  traceId: string,
  payload: AgentSpanPayloads[E],
  run: () => Promise<T>,
  summarize: (value: T) => Record<string, unknown>,
): Promise<{ value: T; durationMs: number }> {
  const channels = getSpanChannels(event);
  const startedAt = performance.now();
  if (!anySpanSubscribed(channels)) {
    const value = await run();
    return { value, durationMs: performance.now() - startedAt };
  }
  const spanId = nextSpanId();
  publishSpanPhase(channels.start, 'start', event, spanId, traceId, { payload });
  publishSpanPhase(channels.end, 'end', event, spanId, traceId, {
    durationMs: performance.now() - startedAt,
  });
  publishSpanPhase(channels.asyncStart, 'asyncStart', event, spanId, traceId, {});
  try {
    const value = await run();
    let result: Record<string, unknown> | undefined;
    try {
      result = summarize(value);
    } catch {
      result = undefined;
    }
    const durationMs = performance.now() - startedAt;
    publishSpanPhase(channels.asyncEnd, 'asyncEnd', event, spanId, traceId, {
      ...(result !== undefined ? { result } : {}),
      durationMs,
    });
    return { value, durationMs };
  } catch (error) {
    publishSpanPhase(channels.error, 'error', event, spanId, traceId, {
      error,
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }
}
