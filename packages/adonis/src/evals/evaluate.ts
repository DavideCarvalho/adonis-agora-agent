import type { RunSampleQuery, RunSampleSource } from './sample-source.js';
import type { RunScore, ScoreStore } from './score-store.js';
import type { ScorableRun, ScoreResult, Scorer } from './types.js';

/** One scorer blowing up on one run. Collected, never thrown — see {@link runEvaluation}. */
export interface ScorerFailure {
  runId: string;
  scorer: string;
  message: string;
}

/** What a batch did. `runsRead - runsScored` is the runs no scorer had anything to say about. */
export interface EvaluationSummary {
  /** Runs the source returned for the query. */
  runsRead: number;
  /** Distinct runs that produced at least one score. */
  runsScored: number;
  /** `(run, scorer)` pairs skipped because that scorer had already covered that run. */
  pairsSkipped: number;
  scoresRecorded: number;
  failures: ScorerFailure[];
}

export interface EvaluationOptions {
  source: RunSampleSource;
  scorers: Scorer[];
  store: ScoreStore;
  query: RunSampleQuery;
  /**
   * Score runs a scorer has already covered. Default `false`, which makes a batch resumable: an
   * interrupted backfill restarted with the same query costs nothing for the part it finished — and
   * for a model-graded scorer, bills nothing.
   */
  rescore?: boolean;
  /** Clock for {@link RunScore.scoredAt}; injectable so a test can pin it. */
  now?: () => Date;
}

/**
 * Score a batch of stored runs and persist the results — the offline path, and the one to reach for.
 *
 * A scorer that throws is recorded as a {@link ScorerFailure} and the batch carries on. One
 * malformed run, one judge that returned prose instead of a verdict, one adapter row a scorer did
 * not expect: none of those should cost you the other 499 runs of a backfill, and a failure that
 * silently became a score of 0 would be worse still — it would read as the agent's fault.
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationSummary> {
  const now = options.now ?? (() => new Date());
  const runs = await options.source.listRuns(options.query);
  const runIds = runs.map((run) => run.runId);

  const alreadyScored = new Map<string, Set<string>>();
  if (options.rescore !== true) {
    for (const scorer of options.scorers) {
      alreadyScored.set(
        scorer.name,
        new Set(await options.store.scoredRunIds(scorer.name, runIds)),
      );
    }
  }

  const scores: RunScore[] = [];
  const failures: ScorerFailure[] = [];
  const scoredRuns = new Set<string>();
  let pairsSkipped = 0;

  for (const run of runs) {
    for (const scorer of options.scorers) {
      if (alreadyScored.get(scorer.name)?.has(run.runId) === true) {
        pairsSkipped += 1;
        continue;
      }
      let result: ScoreResult | null;
      try {
        result = await scorer.score(run);
      } catch (error) {
        failures.push({
          runId: run.runId,
          scorer: scorer.name,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (result === null) {
        continue;
      }
      scores.push(toRunScore({ run, scorer, result, scoredAt: now() }));
      scoredRuns.add(run.runId);
    }
  }

  if (scores.length > 0) {
    await options.store.recordScores(scores);
  }
  return {
    runsRead: runs.length,
    runsScored: scoredRuns.size,
    pairsSkipped,
    scoresRecorded: scores.length,
    failures,
  };
}

/** Assemble the persisted row: the scorer's verdict plus the provenance a summary groups by. */
export function toRunScore(args: {
  run: ScorableRun;
  scorer: Scorer;
  result: ScoreResult;
  scoredAt: Date;
}): RunScore {
  const { run, scorer, result, scoredAt } = args;
  return {
    runId: run.runId,
    threadId: run.threadId,
    agentName: run.agentName,
    scorer: scorer.name,
    kind: scorer.kind,
    score: result.score,
    reason: result.reason,
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    // The RUN's day, not the batch's — see RunScore.day.
    day: run.startedAt.slice(0, 10),
    scoredAt: scoredAt.toISOString(),
  };
}
