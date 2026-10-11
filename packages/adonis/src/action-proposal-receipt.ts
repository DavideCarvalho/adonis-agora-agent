export type ActionApprovalMode = 'blocking' | 'independent';
export type ActionProposalTarget = { kind: 'proposal'; proposalId: string };
export interface ActionProposalReceipt {
  proposalId: string;
  status: 'pending';
  executed: false;
  /** What the model is told to say: nothing happened yet, it waits for the person's confirmation. */
  note: string;
}
/** The receipt's {@link ActionProposalReceipt.note}: words for the model, not for the person. */
export const PENDING_ACTION_PROPOSAL_NOTE =
  'NOT done yet: this action waits for the person to confirm it on the card shown to them. Tell them it is awaiting their confirmation; never say it was done, saved or sent.';
export function actionProposalReceipt(proposalId: string): ActionProposalReceipt {
  return { proposalId, status: 'pending', executed: false, note: PENDING_ACTION_PROPOSAL_NOTE };
}
