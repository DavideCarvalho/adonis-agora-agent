import type { ScorerKind } from './types.js';

/**
 * Persistence for scores, separate from {@link import('../spi/agent-store.js').AgentStore} the same
 * way the governance read-model is: the agent's own tables are the INPUT to scoring and must not
 * grow a column every time someone writes a scorer. A host binds whichever adapter it likes;
 * {@link import('./in-memory-score-store.js').InMemoryScoreStore} covers tests and the offline demo.
 */

/** One scorer's verdict on one run, as persisted. */
export interface RunScore {
  runId: string;
  threadId: string;
  agentName: string | null;
  /** {@link import('./types.js').Scorer.name}. */
  scorer: string;
  kind: ScorerKind;
  /** `0..1`, 1 is good. */
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
  /**
   * The `YYYY-MM-DD` UTC day the SCORED RUN started — not the day the batch ran. A trend must move
   * when the agent's quality moves, not when someone re-ran a backfill over last month.
   */
  day: string;
  /** ISO timestamp the score was produced. */
  scoredAt: string;
}

/** Filters for {@link ScoreStore.listScores}; an absent field imposes no constraint. */
export interface ScoreWhere {
  scorer?: string;
  agentName?: string;
  threadId?: string;
  runId?: string;
  /** Inclusive UTC day bounds on {@link RunScore.day}, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

export interface ScoreStore {
  /**
   * Append scores. Idempotency is the caller's job via {@link ScoreStore.scoredRunIds} — an adapter
   * that upserts on `(runId, scorer)` and one that appends both satisfy this SPI, so a consumer must
   * not read "the score" of a run without deciding which it wants.
   */
  recordScores(scores: RunScore[]): Promise<void>;
  /**
   * Which of `runIds` already carry a score from `scorer`. The resume seam: a backfill interrupted
   * halfway is restarted by skipping these, so re-running it costs nothing and — for a model-graded
   * scorer — bills nothing.
   */
  scoredRunIds(scorer: string, runIds: string[]): Promise<string[]>;
  /** Every score matching `where`, newest-scored first. The feed the summaries aggregate. */
  listScores(where: ScoreWhere): Promise<RunScore[]>;
}
