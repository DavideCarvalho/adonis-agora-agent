/**
 * AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0), producer side: the route adapter, and the pieces it is
 * built from — for a host that mounts its own route instead of the provider's.
 *
 * The encoder, the input readers and the interrupt-id codec are `@dudousxd/nestjs-agent-core/ag-ui`
 * (one implementation for both servers), re-exported here; `AgUiEncoder` and `agUiEvents` take this
 * package's `StreamFrame`s. Install `@dudousxd/nestjs-agent-core` (an optional peer, 0.35 or later)
 * to use this entry.
 */

export {
  AG_UI_CUSTOM,
  AG_UI_PROTOCOL_VERSION,
  type AgUiContentPart,
  type AgUiContext,
  type AgUiEvent,
  type AgUiInterrupt,
  type AgUiMessage,
  type AgUiMetadata,
  type AgUiPartSource,
  type AgUiResumeEntry,
  type AgUiRunInput,
  type AgUiRunOutcome,
  type AgUiSourceFrame,
  type AgUiTokenUsage,
  decodeInterruptId,
  encodeInterruptId,
  type ForwardedOptions,
  type InlineMedia,
  type InterruptAddress,
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
} from '@dudousxd/nestjs-agent-core/ag-ui';
export { type AgUiAdapterOptions, agUiAdapter } from './adapter.js';
export { AgUiEncoder, type AgUiEncoderOptions } from './encoder.js';
export { agUiFrames, toAgUiFrame } from './frames.js';
export { type AgUiStreamOptions, agUiEvents, agUiSse } from './stream.js';
