import type { RunScore } from './score-store.js';
import type { ScorerKind } from './types.js';

/**
 * The pure aggregation core over persisted scores, mirroring the governance read-model: an adapter's
 * only job is fetching rows, and every surface that reports a mean score runs the SAME arithmetic
 * here, so a dashboard and a CI gate can never disagree about whether quality moved.
 */

/** Rollup for one scorer over a set of scores. */
export interface ScorerSummaryRow {
  scorer: string;
  kind: ScorerKind;
  /** How many runs this scorer actually scored. A mean over 3 samples is not a metric — read this first. */
  samples: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
}

/** Rollup for one agent under one scorer. */
export interface AgentScoreRow {
  /** `'(default)'` when the scored run named no agent, mirroring the governance breakdown. */
  agentName: string;
  scorer: string;
  samples: number;
  meanScore: number;
}

/** One point on the daily quality trend, per scorer. */
export interface ScoreTrendPoint {
  day: string;
  scorer: string;
  samples: number;
  meanScore: number;
}

/** Bucket key for a score whose run named no agent (mirrors the governance run breakdown). */
const DEFAULT_AGENT_BUCKET = '(default)';

/** Mean of a bucket. Every caller below builds its buckets by pushing, so none is ever empty. */
function mean(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Rollup per scorer, worst mean first — the ordering that puts the problem at the top. */
export function summarizeByScorer(rows: RunScore[]): ScorerSummaryRow[] {
  const byScorer = new Map<string, { kind: ScorerKind; scores: number[] }>();
  for (const row of rows) {
    const bucket = byScorer.get(row.scorer) ?? { kind: row.kind, scores: [] };
    bucket.scores.push(row.score);
    byScorer.set(row.scorer, bucket);
  }
  const result: ScorerSummaryRow[] = [];
  for (const [scorer, bucket] of byScorer) {
    result.push({
      scorer,
      kind: bucket.kind,
      samples: bucket.scores.length,
      meanScore: mean(bucket.scores),
      minScore: Math.min(...bucket.scores),
      maxScore: Math.max(...bucket.scores),
    });
  }
  result.sort(
    (left, right) => left.meanScore - right.meanScore || left.scorer.localeCompare(right.scorer),
  );
  return result;
}

/** Rollup per (agent, scorer) pair, worst mean first — which persona drags which signal down. */
export function summarizeByAgent(rows: RunScore[]): AgentScoreRow[] {
  const byPair = new Map<string, { agentName: string; scorer: string; scores: number[] }>();
  for (const row of rows) {
    const agentName = row.agentName ?? DEFAULT_AGENT_BUCKET;
    const key = `${agentName} ${row.scorer}`;
    const bucket = byPair.get(key) ?? { agentName, scorer: row.scorer, scores: [] };
    bucket.scores.push(row.score);
    byPair.set(key, bucket);
  }
  const result: AgentScoreRow[] = [];
  for (const bucket of byPair.values()) {
    result.push({
      agentName: bucket.agentName,
      scorer: bucket.scorer,
      samples: bucket.scores.length,
      meanScore: mean(bucket.scores),
    });
  }
  result.sort(
    (left, right) =>
      left.meanScore - right.meanScore ||
      left.agentName.localeCompare(right.agentName) ||
      left.scorer.localeCompare(right.scorer),
  );
  return result;
}

/** Daily mean per scorer, ascending by day then scorer — the "is it getting better" series. */
export function bucketScoreTrend(rows: RunScore[]): ScoreTrendPoint[] {
  const byDay = new Map<string, { day: string; scorer: string; scores: number[] }>();
  for (const row of rows) {
    const key = `${row.day} ${row.scorer}`;
    const bucket = byDay.get(key) ?? { day: row.day, scorer: row.scorer, scores: [] };
    bucket.scores.push(row.score);
    byDay.set(key, bucket);
  }
  const result: ScoreTrendPoint[] = [];
  for (const bucket of byDay.values()) {
    result.push({
      day: bucket.day,
      scorer: bucket.scorer,
      samples: bucket.scores.length,
      meanScore: mean(bucket.scores),
    });
  }
  result.sort(
    (left, right) => left.day.localeCompare(right.day) || left.scorer.localeCompare(right.scorer),
  );
  return result;
}

/**
 * The lowest-scoring runs, worst first, capped at `limit` — the triage queue. Every scorer carries a
 * `reason`, so this is the one view that answers "show me what went wrong" without a second read.
 */
export function worstScoredRuns(rows: RunScore[], limit: number): RunScore[] {
  return [...rows]
    .sort((left, right) => left.score - right.score || left.runId.localeCompare(right.runId))
    .slice(0, limit);
}
