import type {
  AgentGovernanceQueries,
  ListRunsFilter,
  RunDetail,
} from '../spi/governance-queries.js';
import type { RunSampleQuery, RunSampleSource } from './sample-source.js';
import type { ScorableRun, ScorableToolCall } from './types.js';

/**
 * A {@link RunSampleSource} over what the agent already persisted, read through
 * {@link AgentGovernanceQueries} alone. Works against any adapter that implements it (Lucid, the
 * in-memory one) — this module adds no tables of its own on the read side.
 *
 * The prompt and the answer come off `runDetail`, whose messages are the ones stamped with this
 * run's own `run_id`. There is no transcript join and no time-window heuristic: a run that wrote no
 * message has empty text, and no other run's answer can ever be handed to it.
 *
 * One seam remains, and it is the read-model's rather than this class's: a run whose messages were
 * written before message-level run stamping reads as empty text. A rule-based scorer over tool
 * outcomes still works on it; a judge over the answer has nothing to read.
 */
export class GovernanceRunSampleSource implements RunSampleSource {
  constructor(private readonly queries: AgentGovernanceQueries) {}

  async listRuns(query: RunSampleQuery): Promise<ScorableRun[]> {
    const filter: ListRunsFilter = {
      ...(query.actorRef !== undefined ? { actor: query.actorRef } : {}),
      ...(query.agentName !== undefined ? { agent: query.agentName } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.fromDay !== undefined ? { from: query.fromDay } : {}),
      ...(query.toDay !== undefined ? { to: query.toDay } : {}),
    };
    // The read-model clamps a page to 200, so a batch bigger than that has to walk the cursor rather
    // than ask for the whole thing and quietly get a fifth of it.
    const runs: ScorableRun[] = [];
    let cursor: string | null = null;
    while (runs.length < query.limit) {
      const page = await this.queries.listRuns({
        ...filter,
        first: query.limit - runs.length,
        ...(cursor !== null ? { after: cursor } : {}),
      });
      for (const row of page.items) {
        const detail = await this.queries.runDetail(row.runId);
        if (detail !== null) {
          runs.push(toScorableRun(detail));
        }
      }
      cursor = page.nextCursor;
      if (cursor === null || page.items.length === 0) {
        break;
      }
    }
    return runs;
  }

  async getRun(runId: string): Promise<ScorableRun | null> {
    const detail = await this.queries.runDetail(runId);
    return detail === null ? null : toScorableRun(detail);
  }
}

/**
 * Flatten a run's trace into the unit a scorer judges. A turn can persist several assistant messages
 * (one per model step); the LAST is the answer and the earlier ones are the steps that called tools,
 * so both sides reduce by taking the last of their role.
 */
function toScorableRun(detail: RunDetail): ScorableRun {
  const { run } = detail;
  let input = '';
  let output = '';
  for (const message of detail.messages) {
    if (message.role === 'user') {
      input = message.content;
    } else if (message.role === 'assistant') {
      output = message.content;
    }
  }
  return {
    runId: run.runId,
    threadId: run.threadId,
    actorRef: run.actorRef,
    agentName: run.agentName,
    status: run.status,
    input,
    output,
    toolCalls: detail.toolCalls.map(
      (call): ScorableToolCall => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        toolType: call.toolType,
        status: call.status,
        executionMs: call.executionMs,
        error: call.error,
      }),
    ),
    durationMs: run.durationMs,
    error: run.error,
    startedAt: run.startedAt,
  };
}
