/**
 * AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0), producer side, framework-free: the encoder that
 * projects a run's stream onto AG-UI events, the stream driver that ends a run when it stops to
 * ask, and the readers for `RunAgentInput`. Agora serves it as `POST <path>/ag-ui` (`adapters: [agUiAdapter()]`).
 */

export { AgUiEncoder, type AgUiEncoderOptions } from './encoder.js';
export {
  type ForwardedOptions,
  type InlineMedia,
  parseRunInput,
  planResume,
  type ResumeDecision,
  type ResumePlan,
  readAnswersPayload,
  readApprovalPayload,
  readContext,
  readForwardedProps,
  readUserTurn,
  type UserTurn,
} from './input.js';
export { decodeInterruptId, encodeInterruptId, type InterruptAddress } from './interrupt-id.js';
export { actionProposalDecisionEvents } from './proposal-decision.js';
export { type AgUiStreamOptions, agUiEvents, agUiSse } from './stream.js';
export * from './types.js';
