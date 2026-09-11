import type { RunScore, ScoreStore, ScoreWhere } from './score-store.js';

/**
 * Whether a `YYYY-MM-DD` day falls within an inclusive range whose bounds are each optional — an
 * absent bound imposes no constraint on that side. Lexicographic comparison is valid because the
 * days are zero-padded ISO dates.
 */
function dayWithinBounds(
  day: string,
  fromDay: string | undefined,
  toDay: string | undefined,
): boolean {
  if (fromDay !== undefined && day < fromDay) {
    return false;
  }
  if (toDay !== undefined && day > toDay) {
    return false;
  }
  return true;
}

/**
 * A fully in-memory {@link ScoreStore} for unit tests and the offline demo.
 *
 * Append-only: `recordScores` never replaces a previous verdict, so re-scoring the same run after a
 * scorer changed leaves both rows and the history stays auditable. Callers that want one row per
 * `(runId, scorer)` skip the already-scored runs via {@link InMemoryScoreStore.scoredRunIds}, which
 * is what `runEvaluation` does by default.
 */
export class InMemoryScoreStore implements ScoreStore {
  private readonly scores: RunScore[] = [];

  async recordScores(scores: RunScore[]): Promise<void> {
    for (const score of scores) {
      this.scores.push({ ...score });
    }
  }

  async scoredRunIds(scorer: string, runIds: string[]): Promise<string[]> {
    const wanted = new Set(runIds);
    const seen = new Set<string>();
    for (const row of this.scores) {
      if (row.scorer === scorer && wanted.has(row.runId)) {
        seen.add(row.runId);
      }
    }
    return [...seen];
  }

  async listScores(where: ScoreWhere = {}): Promise<RunScore[]> {
    return this.scores
      .filter((row) => {
        if (where.scorer !== undefined && row.scorer !== where.scorer) return false;
        if (where.agentName !== undefined && row.agentName !== where.agentName) return false;
        if (where.threadId !== undefined && row.threadId !== where.threadId) return false;
        if (where.runId !== undefined && row.runId !== where.runId) return false;
        return dayWithinBounds(row.day, where.fromDay, where.toDay);
      })
      .sort(
        (left, right) =>
          right.scoredAt.localeCompare(left.scoredAt) || right.runId.localeCompare(left.runId),
      )
      .map((row) => ({ ...row }));
  }
}
