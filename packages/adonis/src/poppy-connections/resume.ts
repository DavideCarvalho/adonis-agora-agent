import type { AgentService } from '../agent-service.js';
import type { Actor } from '../types.js';
import type { PoppyPendingConnect } from './store.js';

/**
 * A connect finished: decide the `connect` call the turn parked on, so the conversation resumes
 * with the account connected — a scoped proposal decision under `actionApprovalMode: 'independent'`,
 * an approval of the parked call otherwise. A call already decided (the person tapped first) is left.
 */
export async function resumeAfterConnect(
  service: Pick<
    AgentService,
    | 'actionApprovalMode'
    | 'listActionProposals'
    | 'decideActionProposal'
    | 'approve'
    | 'toolCallApproval'
  >,
  pending: PoppyPendingConnect,
): Promise<void> {
  if (!pending.actor || !pending.threadId || !pending.toolCallId) return;
  const actor = pending.actor as Actor;
  if (service.actionApprovalMode() === 'independent') {
    const proposals = (await service.listActionProposals(actor, pending.threadId)) as unknown as {
      id: string;
      originToolCallId?: string;
      decision?: string;
    }[];
    const proposal = proposals.find(
      (p) =>
        p.originToolCallId === pending.toolCallId &&
        p.decision !== 'approved' &&
        p.decision !== 'rejected',
    );
    if (proposal) {
      await service.decideActionProposal(
        actor,
        pending.threadId,
        proposal.id,
        'approved',
        {},
        'poppy-connect',
      );
    }
    return;
  }
  if (!pending.runId) return;
  const state = await service.toolCallApproval(pending.toolCallId);
  if (state !== null && state.status !== 'pending_approval') return;
  await service.approve(pending.runId, pending.toolCallId, {
    executedByRef: actor.id,
    via: 'poppy-connect',
  });
}
