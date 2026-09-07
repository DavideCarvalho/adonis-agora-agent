import type { Actor, ModelMessage } from '../types.js';

/** What a {@link HistoryWindow} needs to know about the run it's compacting history for. */
export interface HistoryWindowContext {
  actor: Actor;
  threadId: string;
}

/**
 * Compaction seam for long-lived threads. The loop maps the ENTIRE persisted thread into
 * `ModelMessage[]` before every turn (see `runAgentLoop` in `agent-loop.ts`); with no window
 * configured that whole history rides every turn, so input tokens (cost + latency, and eventually
 * the model's context limit) grow without bound as a thread accumulates messages. A `HistoryWindow`
 * is a black box like {@link import('./retriever.js').Retriever} — the loop hands it the full
 * mapped history and uses whatever it returns, whether that's a plain truncation (this package
 * ships {@link import('../history-window.js').SlidingWindowHistory}) or a summarizing impl that
 * calls a model to fold dropped messages into a synthetic recap message.
 *
 * Applied inside `hooks.step` so durable replay reuses the SAME windowed result deterministically —
 * required for any impl that calls a model (its own cost must not be paid twice on resume) and
 * harmless for a pure truncator.
 */
export interface HistoryWindow {
  apply(
    messages: ModelMessage[],
    ctx: HistoryWindowContext,
  ): ModelMessage[] | Promise<ModelMessage[]>;
}
