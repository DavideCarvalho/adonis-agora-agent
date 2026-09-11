import type { AgentGovernanceQueries } from '../spi/governance-queries.js';
import type { ScorableRun } from './types.js';

/**
 * The corpus behind {@link import('./scorers/approval-risk.scorer.js').ApprovalRiskScorer}: how
 * often humans have approved each `action` tool, across the HITL decisions in view.
 */

/** One recorded human decision on an `action` tool call. */
export interface ToolApprovalDecision {
  toolName: string;
  /** The tool call's final status, as the store recorded it. */
  status: string;
}

/** How a single tool has fared with humans. */
export interface ToolApprovalCounts {
  approved: number;
  rejected: number;
}

/** Approval counts per tool name. */
export type ToolApprovalPrior = ReadonlyMap<string, ToolApprovalCounts>;

/** See the approval-outcome scorer — an approved action can still end `failed`. */
const APPROVED_STATUSES = new Set(['executed', 'failed']);

/**
 * Pseudo-counts of a Beta(1,1) prior — one imagined approval and one imagined rejection per tool.
 *
 * Without it a tool rejected once out of one call scores 0.0 and a tool approved once out of one
 * scores 1.0, and the whole ranking is decided by whichever tool happened to be used first. With it,
 * an unseen tool sits at exactly 0.5 ("no evidence either way") and evidence moves it as it
 * accumulates — 1-of-1 rejected reads 0.33, 1-of-6 reads 0.25, 0-of-50 reads 0.02.
 */
const PRIOR_PSEUDO_COUNT = 1;

/** Fold recorded decisions into per-tool approval counts. Undecided statuses are ignored. */
export function buildApprovalPrior(
  decisions: Iterable<ToolApprovalDecision>,
): Map<string, ToolApprovalCounts> {
  const prior = new Map<string, ToolApprovalCounts>();
  for (const decision of decisions) {
    const approved = APPROVED_STATUSES.has(decision.status);
    if (!approved && decision.status !== 'rejected') {
      continue;
    }
    const counts = prior.get(decision.toolName) ?? { approved: 0, rejected: 0 };
    if (approved) {
      counts.approved += 1;
    } else {
      counts.rejected += 1;
    }
    prior.set(decision.toolName, counts);
  }
  return prior;
}

/**
 * The prior over the runs a batch already loaded — the cheapest way to get one, and free of extra
 * reads. {@link import('./governance-sample-source.js').GovernanceRunSampleSource} returns each run
 * with its tool calls already attached, so the whole sample's HITL history is in hand before the
 * first scorer runs. It is a prior over the corpus being scored, which is the honest reading of a
 * batch that also IS the corpus; reach for {@link loadApprovalPrior} when the prior should come from
 * a wider slice of history than the batch covers.
 */
export function priorFromRuns(runs: Iterable<ScorableRun>): Map<string, ToolApprovalCounts> {
  const decisions: ToolApprovalDecision[] = [];
  for (const run of runs) {
    for (const call of run.toolCalls) {
      if (call.toolType === 'action') {
        decisions.push({ toolName: call.toolName, status: call.status });
      }
    }
  }
  return buildApprovalPrior(decisions);
}

/** How much decision history {@link loadApprovalPrior} reads. */
export interface ApprovalPriorQuery {
  /**
   * How many of the most recent tool calls to read. The read-model's activity feed is not filtered
   * by tool type, so this bounds calls of EVERY kind and a deployment whose traffic is mostly reads
   * needs a generous number to see its actions. Hard cap on the work, by design: building a prior
   * must never turn into an unbounded scan.
   */
  limit?: number;
  /** Inclusive UTC day bounds on when the call was made, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

const DEFAULT_LIMIT = 2_000;

/**
 * Build the prior from the store's own HITL history, off the governance activity feed. Offline by
 * construction: it reads decisions humans already made, so a batch can score a whole backlog against
 * the taste of the people who have been running the system.
 */
export async function loadApprovalPrior(args: {
  queries: AgentGovernanceQueries;
  query?: ApprovalPriorQuery;
}): Promise<Map<string, ToolApprovalCounts>> {
  const { queries, query = {} } = args;
  const rows = await queries.recentToolCalls(query.limit ?? DEFAULT_LIMIT);
  const decisions: ToolApprovalDecision[] = [];
  for (const row of rows) {
    if (row.toolType !== 'action') {
      continue;
    }
    const day = row.createdAt.slice(0, 10);
    if (query.fromDay !== undefined && day < query.fromDay) continue;
    if (query.toDay !== undefined && day > query.toDay) continue;
    decisions.push({ toolName: row.toolName, status: row.status });
  }
  return buildApprovalPrior(decisions);
}

/**
 * The smoothed probability that a human approves this tool the next time it is proposed. `0.5` for a
 * tool nobody has ever decided on, which is what "we have no evidence" should look like.
 */
export function approvalPosterior(counts: ToolApprovalCounts | undefined): number {
  const approved = counts?.approved ?? 0;
  const rejected = counts?.rejected ?? 0;
  return (approved + PRIOR_PSEUDO_COUNT) / (approved + rejected + PRIOR_PSEUDO_COUNT * 2);
}
