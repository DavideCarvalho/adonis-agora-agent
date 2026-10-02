export type ActionApprovalMode = 'blocking' | 'independent';
export type ActionProposalTarget = { kind: 'proposal'; proposalId: string };
export interface ActionProposalReceipt {
  proposalId: string;
  status: 'pending';
  executed: false;
}
export function actionProposalReceipt(proposalId: string): ActionProposalReceipt {
  return { proposalId, status: 'pending', executed: false };
}
