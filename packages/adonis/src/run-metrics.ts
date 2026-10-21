/** A latency distribution: how many samples, and their nearest-rank median and 95th percentile. */
export interface Latency {
  samples: number;
  /** `null` when there are no samples. */
  p50Ms: number | null;
  /** `null` when there are no samples. */
  p95Ms: number | null;
}

/** Nearest-rank percentile of an ascending-sorted list; `null` when it is empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

/** {@link Latency} of a list of durations, in any order. */
export function summarizeLatency(values: readonly number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/** What {@link summarizeRunMetrics} reads off one run row, whichever store it came from. */
export interface RunMetricsSample {
  status: string;
  parentRunId: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; `null` while running. */
  finishedAt: number | null;
  ttftMs: number | null;
  errorCode: string | null;
}

/** How many failed runs ended under one stream error code. */
export interface RunFailureCodeRow {
  /** The run's `error_code`; `'unknown'` for a failure recorded before codes were. */
  code: string;
  count: number;
}

/** The latency and failure-code part of a run reliability rollup. */
export interface RunMetrics {
  latency: { ttft: Latency; duration: Latency };
  failuresByCode: RunFailureCodeRow[];
}

/**
 * Turn latency and failures by code over a set of runs. Latency counts completed turns only, and
 * only a person's turn: a delegation's child run is part of its parent's turn, and counting it again
 * would skew both the median and the tail toward short sub-tasks. Every failed run counts toward its
 * code, the same runs {@link import('./spi/governance-queries.js').RunReliability.failed} counts.
 */
export function summarizeRunMetrics(runs: Iterable<RunMetricsSample>): RunMetrics {
  const ttft: number[] = [];
  const duration: number[] = [];
  const codes = new Map<string, number>();
  for (const run of runs) {
    if (run.status === 'failed') {
      const code = run.errorCode ?? 'unknown';
      codes.set(code, (codes.get(code) ?? 0) + 1);
      continue;
    }
    if (run.status !== 'completed' || run.parentRunId !== null) continue;
    if (run.finishedAt !== null) duration.push(run.finishedAt - run.startedAt);
    if (run.ttftMs !== null) ttft.push(run.ttftMs);
  }
  return {
    latency: { ttft: summarizeLatency(ttft), duration: summarizeLatency(duration) },
    failuresByCode: [...codes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
  };
}
