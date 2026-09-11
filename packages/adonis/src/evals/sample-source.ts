import type { RunStatus } from '../spi/governance-queries.js';
import type { ScorableRun } from './types.js';

/**
 * Which stored runs to score. `limit` caps the batch; every other field is an optional filter, and
 * each one maps to a filter the governance read-model actually has
 * ({@link import('../spi/governance-queries.js').ListRunsFilter}) — a filter this package applied
 * after the page was already clamped would return fewer runs than `limit` asked for and look like a
 * quiet corpus.
 */
export interface RunSampleQuery {
  /** Max runs returned, newest first. */
  limit: number;
  /** Inclusive UTC day bounds on the run's start, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
  agentName?: string;
  status?: RunStatus;
  /** Exact `actorRef` — score one person's runs, or one tenant's service account. */
  actorRef?: string;
}

/**
 * Where {@link ScorableRun}s come from. The evaluation runner reads through this and nothing else,
 * so a host can point it at the live agent tables, at a frozen regression set checked into a repo,
 * or at a hand-written fixture in a test — the scorers never learn which.
 */
export interface RunSampleSource {
  listRuns(query: RunSampleQuery): Promise<ScorableRun[]>;
  getRun(runId: string): Promise<ScorableRun | null>;
}

/**
 * A {@link RunSampleSource} over a fixed list of runs — the regression-set / fixture source. Also
 * what a test uses instead of standing up a store.
 */
export class StaticRunSampleSource implements RunSampleSource {
  constructor(private readonly runs: ScorableRun[]) {}

  async listRuns(query: RunSampleQuery): Promise<ScorableRun[]> {
    return this.runs
      .filter((run) => {
        if (query.agentName !== undefined && run.agentName !== query.agentName) return false;
        if (query.status !== undefined && run.status !== query.status) return false;
        if (query.actorRef !== undefined && run.actorRef !== query.actorRef) return false;
        const day = run.startedAt.slice(0, 10);
        if (query.fromDay !== undefined && day < query.fromDay) return false;
        if (query.toDay !== undefined && day > query.toDay) return false;
        return true;
      })
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId),
      )
      .slice(0, query.limit);
  }

  async getRun(runId: string): Promise<ScorableRun | null> {
    return this.runs.find((run) => run.runId === runId) ?? null;
  }
}
