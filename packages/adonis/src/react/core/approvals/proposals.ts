import type { UIMessage } from 'ai';
import type { ActionProposal } from '../../../index.js';
import type { StoredMessage } from '../client-wire.js';
import { storedMessageToUiMessage } from '../stored-message-to-ui-message.js';

export type ApprovalTarget =
  | { kind: 'legacy'; toolCallId: string }
  | { kind: 'proposal'; proposalId: string; threadId?: string };

export function proposalNeedsPolling(proposal: ActionProposal): boolean {
  return (
    proposal.decision === 'pending' ||
    proposal.execution?.status === 'queued' ||
    proposal.execution?.status === 'executing' ||
    proposal.outcomeDelivery?.status === 'pending'
  );
}

/** Patch proposal metadata and append outcome facts; never replace live text with stored rows. */
export function reconcileProposalMessages(
  current: UIMessage[],
  proposals: ActionProposal[],
  facts: StoredMessage[],
): UIMessage[] {
  const messages = current.map((message) => {
    const relevant = proposals.filter((proposal) =>
      message.parts.some((part) => {
        if (
          'data' in part &&
          record(part.data) &&
          record(part.data.target) &&
          part.data.target.kind === 'proposal'
        )
          return part.data.target.proposalId === proposal.id;
        if ('toolCallId' in part && part.toolCallId === proposal.originToolCallId) {
          if ('output' in part && record(part.output) && typeof part.output.proposalId === 'string')
            return part.output.proposalId === proposal.id;
          return record(message.metadata) && message.metadata.runId === proposal.originRunId;
        }
        return false;
      }),
    );
    if (relevant.length === 0) return message;
    const ids = new Set(relevant.map((proposal) => proposal.originToolCallId));
    const parts = message.parts.filter(
      (part) =>
        !(
          part.type === 'data-action-proposal' &&
          'id' in part &&
          typeof part.id === 'string' &&
          ids.has(part.id)
        ),
    );
    for (const proposal of relevant)
      parts.push({
        type: 'data-action-proposal',
        id: proposal.originToolCallId,
        data: {
          id: proposal.originToolCallId,
          target: { kind: 'proposal', proposalId: proposal.id, threadId: proposal.threadId },
          approver: proposal.approver,
          confirmation: proposal.confirmation,
          expiresAt:
            proposal.expiresAt === null
              ? null
              : Math.abs(proposal.expiresAt) <= 8.64e15
                ? new Date(proposal.expiresAt).toISOString()
                : null,
          status: proposal.decision,
          executionStatus: proposal.execution?.status ?? null,
          remember: proposal.decisionAudit?.remember === true,
          decidedBy: proposal.decisionAudit?.actorRef ?? null,
          decidedVia: proposal.decisionAudit?.via ?? null,
          reason: proposal.decisionAudit?.reason ?? null,
        },
      });
    return { ...message, parts };
  });
  const knownMessages = new Set(messages.map((message) => message.id));
  const knownOutcomes = new Set(
    messages.map((message) => outcomeId(message.metadata)).filter(Boolean),
  );
  for (const fact of facts) {
    const id = fact.actionProposalOutcome?.id;
    if (id === undefined || knownMessages.has(fact.id) || knownOutcomes.has(id)) continue;
    const message = storedMessageToUiMessage(fact);
    messages.push({
      ...message,
      metadata: {
        ...(record(message.metadata) ? message.metadata : {}),
        actionProposalOutcomeId: id,
      },
    });
    knownMessages.add(fact.id);
    knownOutcomes.add(id);
  }
  return messages;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function outcomeId(value: unknown): string | undefined {
  return record(value) && typeof value.actionProposalOutcomeId === 'string'
    ? value.actionProposalOutcomeId
    : undefined;
}
