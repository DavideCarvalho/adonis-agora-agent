import type { ActionProposal, ClaimActionProposal } from './action-proposal-store.js';

/** Privileged worker-only discovery; never expose this unscoped capability on public routes. */
export interface ActionProposalWorkerStore {
  /** Claim one queued or expired-lease action across scopes; null means no claim was won. */
  claimNextActionProposal(command: ClaimActionProposal): Promise<ActionProposal | null>;
  /** Expire at most limit (1..1000) due pending proposals using the store's trusted clock. */
  expireActionProposals(command: { limit: number }): Promise<number>;
}
