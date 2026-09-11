import type { Actor, MessageUsage, ModelMessage } from '../types.js';

/** What a {@link HistoryWindow} needs to know about the run it's compacting history for. */
export interface HistoryWindowContext {
  actor: Actor;
  threadId: string;
}

/** How a window split the thread: what rides into the turn, and what the ceiling left out. */
export interface HistorySelection {
  /** Sent to the model, oldest-first. */
  keep: ModelMessage[];
  /** Left out, oldest-first. Folded into a leading summary when the window implements `summarize`. */
  drop: ModelMessage[];
}

/** A stand-in for the messages a window left out, plus what producing it cost. */
export interface HistorySummary {
  /** Prose the loop folds into the window as a leading `system` message. */
  text: string;
  /**
   * What the summarizer spent, when it called a model. Recorded as a `summary` usage row, so a
   * ceiling on context cost cannot itself become spend nothing accounts for — the quota sums the
   * whole ledger without filtering purpose, so this also counts against the daily cap. Omit for a
   * summarizer that calls no model (a rollup of tool names, a digest the app already stored).
   */
  usage?: MessageUsage;
  /** Accounting label for the model that produced it; falls back to `AgentLoopDeps.modelId`. */
  modelId?: string;
}

/**
 * Compaction seam for long-lived threads. The loop maps the ENTIRE persisted thread into
 * `ModelMessage[]` before every turn (see `runAgentLoop` in `agent-loop.ts`); with no window
 * configured that whole history rides every turn, so input tokens (cost + latency, and eventually
 * the model's context limit) grow without bound as a thread accumulates messages. This package
 * ships {@link import('../history-window.js').SlidingWindowHistory}; anything satisfying the seam
 * works.
 *
 * The two halves run in deliberately different places, and that split is what lets a window exist
 * without moving a single one of the loop's checkpoint positions — see each method.
 */
export interface HistoryWindow {
  /**
   * The most messages {@link select} can ever keep, where the ceiling can be stated as a row count.
   *
   * A hint the loop hands to the store, which then reads that many of the thread's newest rows
   * rather than its whole transcript (see {@link import('./agent-store.js').ThreadTurnReader}).
   * Declaring it is a PROMISE about `select`: that it keeps at most this many messages, and that
   * they are the NEWEST ones — so a window of this size is indistinguishable, to `select`, from the
   * full transcript. A window that can keep more than this, or something older than the newest
   * `maxMessages`, must omit it rather than select over rows the store was never asked for.
   *
   * Omit where the ceiling is not a row count at all. Omitting costs only the bound on the READ; the
   * prompt is identical either way.
   */
  readonly maxMessages?: number;
  /**
   * Decide what the model sees.
   *
   * MUST be a pure function of `messages`. The loop calls it OUTSIDE any checkpoint, which is safe
   * only because its input already IS one (`load:thread`'s cached result), so a replay re-runs it
   * over the same messages and reaches the same split. Read a clock, a feature flag or a database
   * here and the resumed run windows differently from the one that suspended: the model gets a
   * different prompt, and any step whose existence depends on the split lands at a position the
   * history has no room for. Anything non-deterministic belongs in {@link summarize}.
   *
   * The newest message must always be in `keep` — dropping it leaves the turn with nothing to answer.
   */
  select(messages: ModelMessage[], ctx: HistoryWindowContext): HistorySelection;
  /**
   * Fold the dropped messages into prose the model reads in their place, prepended to the window as
   * a `system` message. Optional — without it, dropped messages are simply gone.
   *
   * Runs inside the loop's `history:summarize` checkpoint, so it may call a model or hit the
   * network: the first attempt's result is journaled and every replay reads it back instead of
   * re-summarizing (and instead of paying for it twice). It runs once per RUN, not per model step,
   * and only when `select` actually dropped something.
   */
  summarize?(dropped: ModelMessage[], ctx: HistoryWindowContext): Promise<HistorySummary>;
}
