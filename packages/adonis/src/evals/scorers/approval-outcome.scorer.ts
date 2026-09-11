import type { ScorableRun, ScorableToolCall, ScoreResult, Scorer, ScorerKind } from '../types.js';

/** {@link ApprovalOutcomeScorer}'s stable name. */
export const APPROVAL_OUTCOME_SCORER = 'approval-outcome';

/**
 * The statuses an `action` tool call can only reach AFTER a human approved it. `failed` belongs
 * here: the approval happened and the tool then blew up on its own, which is a tool problem, not a
 * verdict on whether the agent should have proposed it. (`run-completion` is what charges for that
 * failure.) `pending_approval` is the undecided state, and `auto_executed` never applies — an action
 * never auto-executes.
 */
const APPROVED_STATUSES = new Set(['executed', 'failed']);

/**
 * Every HITL rejection is a negative quality label a human produced for free.
 *
 * The library already stops an `action` tool and asks a person "should this run?". That answer is
 * recorded on the tool call, and it is the only ground truth in the whole system that nobody had to
 * be paid to collect: an operator who clicks reject has told you the agent proposed the wrong thing,
 * in the words of the domain, at the moment it mattered. This scorer reads that back as the fraction
 * of a run's decided actions a human said yes to.
 *
 * `null` — not 1 — for a run that proposed no action, or whose actions are all still
 * `pending_approval`. Most runs are read-only and carry no human verdict at all; counting those as
 * perfect would bury the runs that do carry one under an average of ~1.
 */
export class ApprovalOutcomeScorer implements Scorer {
  readonly name = APPROVAL_OUTCOME_SCORER;
  readonly kind: ScorerKind = 'rule';

  async score(run: ScorableRun): Promise<ScoreResult | null> {
    const actions = run.toolCalls.filter((call) => call.toolType === 'action');
    const approved = actions.filter((call) => APPROVED_STATUSES.has(call.status));
    const rejected = actions.filter((call) => call.status === 'rejected');
    const decided = approved.length + rejected.length;
    if (decided === 0) {
      return null;
    }
    const metadata = {
      proposed: actions.length,
      approved: approved.length,
      rejected: rejected.length,
      pending: actions.length - decided,
      rejectedTools: toolNames(rejected),
    };
    if (rejected.length === 0) {
      return {
        score: 1,
        reason: `a human approved all ${decided} decided action${decided === 1 ? '' : 's'}`,
        metadata,
      };
    }
    return {
      score: approved.length / decided,
      reason: `a human approved ${approved.length} of ${decided} decided actions (rejected: ${toolNames(rejected).join(', ')})`,
      metadata,
    };
  }
}

/** The distinct tool names in a set of calls, sorted — a stable reason string and metadata value. */
function toolNames(calls: ScorableToolCall[]): string[] {
  return [...new Set(calls.map((call) => call.toolName))].sort();
}
