import type { ScorableRun, ScoreResult, Scorer, ScorerKind } from '../types.js';

/** {@link RunCompletionScorer}'s stable name, for a `where.scorer` filter or a resumed backfill. */
export const RUN_COMPLETION_SCORER = 'run-completion';

/**
 * An answer assembled from a partially-broken toolset. Kept distinguishable from BOTH a clean answer
 * (1) and no answer at all (0): the user did get a reply, and it was written without whatever the
 * failed tool was going to say.
 */
const PARTIAL_TOOLING_SCORE = 0.5;

/**
 * Did the turn actually deliver? Deterministic, free, and the baseline every other scorer is read
 * against.
 *
 * It is NOT the governance success rate. That counts a run as a success the moment it settles
 * `completed`, which a turn that answered nothing after three failed tool calls also does. This asks
 * the narrower question the ledger cannot: was there an answer, and was the agent whole while it
 * wrote one.
 */
export class RunCompletionScorer implements Scorer {
  readonly name = RUN_COMPLETION_SCORER;
  readonly kind: ScorerKind = 'rule';

  async score(run: ScorableRun): Promise<ScoreResult | null> {
    const failedCalls = run.toolCalls.filter((call) => call.status === 'failed');
    const metadata = {
      status: run.status,
      outputChars: run.output.trim().length,
      toolCalls: run.toolCalls.length,
      failedToolCalls: failedCalls.length,
    };

    // A run still in flight has no outcome to judge — scoring it would freeze a verdict the run is
    // about to contradict.
    if (run.status === 'running') {
      return null;
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      return {
        score: 0,
        reason: `the run ${run.status} (${run.error ?? 'unclassified'})`,
        metadata,
      };
    }
    if (run.output.trim() === '') {
      return { score: 0, reason: 'the run completed without answering anything', metadata };
    }
    if (failedCalls.length > 0) {
      const names = [...new Set(failedCalls.map((call) => call.toolName))].sort().join(', ');
      return {
        score: PARTIAL_TOOLING_SCORE,
        reason: `answered, but ${failedCalls.length} of ${run.toolCalls.length} tool calls failed (${names})`,
        metadata,
      };
    }
    return { score: 1, reason: 'the run completed and answered with every tool intact', metadata };
  }
}
