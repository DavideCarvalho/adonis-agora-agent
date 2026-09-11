import { approvalPosterior, type ToolApprovalPrior } from '../approval-prior.js';
import type { ScorableRun, ScoreResult, Scorer, ScorerKind } from '../types.js';

/** {@link ApprovalRiskScorer}'s stable name. */
export const APPROVAL_RISK_SCORER = 'approval-risk';

/** One proposed action, with the history that decides how much to trust it. */
interface ProposedAction {
  toolName: string;
  approved: number;
  rejected: number;
  pApprove: number;
}

/**
 * How likely a human is to reject what this run proposed — BEFORE a human looks at it.
 *
 * {@link import('./approval-outcome.scorer.js').ApprovalOutcomeScorer} reads verdicts that already
 * exist; this turns the same corpus into a prediction, so a pending approvals inbox can be drained
 * riskiest-first and a run that is about to be rejected can be caught while it is still cheap. It is
 * the statistical family, not the rule-based one: the number is a smoothed frequency estimate over
 * past decisions, and its `metadata` carries the sample it rests on so a 1-of-1 rejection is never
 * mistaken for certainty.
 *
 * A run scores as its WORST proposed action, not the average of them. A turn that proposes one tool
 * humans reject nine times in ten is a risky turn no matter how many safe reads it made alongside.
 *
 * `null` for a run that proposed no action — the same "not applicable, not perfect" rule as the
 * outcome scorer.
 */
export class ApprovalRiskScorer implements Scorer {
  readonly name = APPROVAL_RISK_SCORER;
  readonly kind: ScorerKind = 'statistical';

  constructor(private readonly prior: ToolApprovalPrior) {}

  async score(run: ScorableRun): Promise<ScoreResult | null> {
    const actions = run.toolCalls.filter((call) => call.toolType === 'action');
    if (actions.length === 0) {
      return null;
    }
    const proposed: ProposedAction[] = [...new Set(actions.map((call) => call.toolName))]
      .sort()
      .map((toolName) => {
        const counts = this.prior.get(toolName);
        return {
          toolName,
          approved: counts?.approved ?? 0,
          rejected: counts?.rejected ?? 0,
          pApprove: approvalPosterior(counts),
        };
      });
    const riskiest = proposed.reduce((worst, candidate) =>
      candidate.pApprove < worst.pApprove ? candidate : worst,
    );
    const decided = riskiest.approved + riskiest.rejected;
    return {
      score: riskiest.pApprove,
      reason:
        decided === 0
          ? `no human has ever decided on ${riskiest.toolName}, the riskiest of ${proposed.length} proposed action(s)`
          : `the riskiest proposed action is ${riskiest.toolName} — humans approved ${riskiest.approved} of its ${decided} past calls`,
      metadata: { riskiestTool: riskiest.toolName, proposed },
    };
  }
}
