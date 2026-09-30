/**
 * AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0), producer side: the encoder that projects a run's
 * stream onto AG-UI events, and the pieces the `POST <path>/ag-ui` route is built from — for a host
 * that mounts its own route instead of the provider's.
 */

export { type AgUiAdapterOptions, agUiAdapter } from './adapter.js';
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
export { type AgUiStreamOptions, agUiEvents, agUiSse } from './stream.js';
export * from './types.js';
