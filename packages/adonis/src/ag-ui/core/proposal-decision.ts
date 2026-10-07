import { AG_UI_CUSTOM, AG_UI_PROTOCOL_VERSION, type AgUiEvent } from './types.js';

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
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: input.text },
    { type: 'TEXT_MESSAGE_END', messageId },
    { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId },
  ];
}
