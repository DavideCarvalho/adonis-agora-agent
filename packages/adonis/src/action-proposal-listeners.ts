import type { ActionProposalOutcome } from './spi/action-proposal-outcome-store.js';

type AdmittedListener = (outcome: ActionProposalOutcome) => void | Promise<void>;

const admitted = new Set<AdmittedListener>();

/**
 * Listen for proposal outcomes written to their thread by this process's action-proposal worker
 * (`actionApprovalMode: 'independent'`) — what a package uses to continue a conversation once an
 * action it proposed ran. Returns the unsubscribe.
 */
export function onActionProposalAdmitted(listener: AdmittedListener): () => void {
  admitted.add(listener);
  return () => {
    admitted.delete(listener);
  };
}

/** Tell every listener; a throwing one does not stop the others (its error is rethrown last). */
export async function notifyActionProposalAdmitted(outcome: ActionProposalOutcome): Promise<void> {
  let failure: unknown;
  for (const listener of [...admitted]) {
    try {
      await listener(outcome);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
