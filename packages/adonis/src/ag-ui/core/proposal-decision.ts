import { AG_UI_CUSTOM, AG_UI_PROTOCOL_VERSION, type AgUiEvent } from './types.js';

/** The pre-`agora.*` name of {@link AG_UI_CUSTOM.actionProposalDecision}, still sent alongside it. */
export const LEGACY_ACTION_PROPOSAL_DECISION_EVENT = 'aviary.action-proposal-decision';

/** A decision-only protocol invocation: no model run, stream holder or tool execution is created. */
export function actionProposalDecisionEvents(input: {
  threadId: string;
  runId: string;
  text: string;
  proposalDecision: unknown;
}): AgUiEvent[] {
  const messageId = `${input.runId}:proposal-decision`;
  const value = { threadId: input.threadId, proposalDecision: input.proposalDecision };
  return [
    {
      type: 'RUN_STARTED',
      threadId: input.threadId,
      runId: input.runId,
      protocolVersion: AG_UI_PROTOCOL_VERSION,
    },
    { type: 'CUSTOM', name: AG_UI_CUSTOM.actionProposalDecision, value },
    // Deprecated: kept for clients that listen for the old name; removed in the next major.
    { type: 'CUSTOM', name: LEGACY_ACTION_PROPOSAL_DECISION_EVENT, value },
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: input.text },
    { type: 'TEXT_MESSAGE_END', messageId },
    { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId },
  ];
}
