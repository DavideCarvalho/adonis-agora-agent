import type { ActionProposalTarget } from '../../action-proposal-receipt.js';
import type { AgentStreamEvent } from '../../stream-events.js';

/**
 * The slice of AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0) this producer writes and reads. Typed by
 * hand rather than imported: the agent package takes no dependency on an AG-UI SDK, and the wire
 * shape is pinned by the protocol's own JSON Schema, which the tests validate every emitted event
 * against (`src/ag-ui/fixtures/schema-1.0.json`).
 *
 * Optional members are OMITTED when there is nothing to say, never `null` — the protocol's
 * "absent means absent" rule.
 */

/** The protocol version this producer declares on `RUN_STARTED`. */
export const AG_UI_PROTOCOL_VERSION = '1.0';

export type AgUiMetadata = Record<string, unknown>;

/** One provider-and-model's token usage, in the protocol's single accounting. */
export interface AgUiTokenUsage {
  provider?: string;
  model?: string;
  /** Every prompt token, cached or not. */
  inputTokens?: number;
  /** Every generated token, reasoning included. */
  outputTokens?: number;
  totalTokens?: number;
  /** Part of `outputTokens`. */
  reasoningTokens?: number;
  /** Cache reads — part of `inputTokens`. */
  cachedInputTokens?: number;
  /** Cache writes — part of `inputTokens`, disjoint from the reads. */
  cacheWriteInputTokens?: number;
}

/** What an interrupted run is waiting for; a resume entry answers it by `id`. */
export interface AgUiInterrupt {
  id: string;
  /** Open string. This producer writes `tool_approval` and `input_required`. */
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  metadata?: AgUiMetadata;
}

export type AgUiRunOutcome =
  | { type: 'success'; pendingToolCallIds?: string[] }
  | { type: 'interrupt'; interrupts: AgUiInterrupt[] }
  | { type: 'cancelled' };

interface Base {
  metadata?: AgUiMetadata;
}

export type AgUiEvent =
  | (Base & { type: 'RUN_STARTED'; threadId: string; runId: string; protocolVersion?: string })
  | (Base & {
      type: 'RUN_FINISHED';
      threadId: string;
      runId: string;
      outcome?: AgUiRunOutcome;
      usage?: AgUiTokenUsage[];
    })
  | (Base & { type: 'RUN_ERROR'; message: string; code?: string; usage?: AgUiTokenUsage[] })
  | (Base & { type: 'STEP_STARTED'; stepName: string })
  | (Base & { type: 'STEP_FINISHED'; stepName: string })
  | (Base & { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' })
  | (Base & { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string })
  | (Base & { type: 'TEXT_MESSAGE_END'; messageId: string })
  | (Base & { type: 'REASONING_START'; messageId: string })
  | (Base & { type: 'REASONING_MESSAGE_START'; messageId: string; role: 'reasoning' })
  | (Base & { type: 'REASONING_MESSAGE_CONTENT'; messageId: string; delta: string })
  | (Base & { type: 'REASONING_MESSAGE_END'; messageId: string })
  | (Base & { type: 'REASONING_END'; messageId: string })
  | (Base & {
      type: 'TOOL_CALL_START';
      toolCallId: string;
      toolCallName: string;
      parentMessageId?: string;
    })
  | (Base & { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string })
  | (Base & { type: 'TOOL_CALL_END'; toolCallId: string })
  | (Base & {
      type: 'TOOL_CALL_RESULT';
      messageId: string;
      toolCallId: string;
      content: string;
      role: 'tool';
    })
  | (Base & { type: 'CUSTOM'; name: string; value: unknown })
  /** A2UI over AG-UI (`a2ui-surface` activities): written only when the route was asked for A2UI. */
  | (Base & {
      type: 'ACTIVITY_SNAPSHOT';
      messageId: string;
      activityType: string;
      content: Record<string, unknown>;
      replace?: boolean;
    });

/** Where a media part's bytes are. Closed set: an unknown `type` is malformed input. */
export type AgUiPartSource =
  | { type: 'data'; value: string; mimeType: string }
  | { type: 'url'; value: string; mimeType?: string }
  | { type: 'file'; value: string; provider?: string; mimeType?: string };

export type AgUiContentPart =
  | { type: 'text'; text: string; id?: string; metadata?: unknown }
  | {
      type: 'image' | 'audio' | 'video' | 'document';
      source: AgUiPartSource;
      id?: string;
      metadata?: unknown;
    };

export interface AgUiMessage {
  id: string;
  role: string;
  content?: string | AgUiContentPart[];
  [key: string]: unknown;
}

export interface AgUiResumeEntry {
  interruptId: string;
  status: 'resolved' | 'cancelled';
  payload?: unknown;
  metadata?: AgUiMetadata;
}

export interface AgUiContext {
  description: string;
  value: string;
}

/** `RunAgentInput`: the one message that travels from the application to the agent. */
export interface AgUiRunInput {
  threadId: string;
  runId: string;
  protocolVersion?: string;
  parentRunId?: string;
  state?: unknown;
  messages: AgUiMessage[];
  tools?: unknown[];
  context?: AgUiContext[];
  forwardedProps?: unknown;
  resume?: AgUiResumeEntry[];
}

/**
 * The names of the `CUSTOM` events this producer writes for what AG-UI does not model. Prefixed, as
 * the protocol asks of invented names; a consumer that does not know one ignores it.
 */
export const AG_UI_CUSTOM = {
  /** `{ runId, threadId }` — the library's own ids for the run behind this stream (cancel, re-attach). */
  run: 'agora.run',
  /** A generative-UI component (`AgentUiComponent`); a repeat `id` replaces. */
  ui: 'agora.ui',
  title: 'agora.title',
  queue: 'agora.queue',
  /** The approval request as the native protocol carries it, for a consumer that renders it live. */
  approvalRequested: 'agora.approval-requested',
  approvalSettled: 'agora.approval-settled',
  /** `{ id, runId, request }` — the whole question set of an elicitation (`ElicitationRequest`). */
  elicitation: 'agora.elicitation',
  /** `{ usage, costUsd, reasoningMs, model }` of one model step, right after its `STEP_FINISHED`. */
  stepUsage: 'agora.step-usage',
  /** `{ message }` — input material this producer could not use and dropped. */
  warning: 'agora.warning',
  /** `{ threadId, proposalDecision }` — a message decided an independent proposal instead of a run. */
  actionProposalDecision: 'agora.action-proposal-decision',
} as const;

/**
 * What the encoder reads: one frame of a run's stream, in the shared vocabulary
 * ({@link AgentStreamEvent}) — plus the terminal failure, which the NestJS sink throws and the
 * Adonis sink writes as a frame, and three optional facts a sink may know about a parked call:
 *  - `runId` — the run that is PARKED, when it is not the one whose stream this is (a delegated
 *    sub-agent forwards its frames into its ancestor's stream). Absent → the stream's own run.
 *  - `toolName`, `input` — the call being approved. Absent → read off the call's announcement.
 *  - `target` — the independent proposal the approval decides (`actionApprovalMode: 'independent'`).
 *    Absent → an ordinary parked approval.
 *
 * Framework-free on purpose: both servers project their own sink onto this and share one encoder.
 */
export type AgUiSourceFrame =
  | Exclude<
      AgentStreamEvent,
      { kind: 'approval-requested' } | { kind: 'elicitation' } | { kind: 'ui' }
    >
  | (Extract<AgentStreamEvent, { kind: 'approval-requested' }> & {
      runId?: string;
      toolName?: string;
      input?: unknown;
      target?: ActionProposalTarget;
    })
  | (Extract<AgentStreamEvent, { kind: 'elicitation' }> & { runId?: string })
  /** A component with no `id` is numbered by its position in the stream (`ui:<n>`). */
  | (Omit<Extract<AgentStreamEvent, { kind: 'ui' }>, 'id' | 'props'> & {
      id?: string;
      props: unknown;
    })
  /** The run failed: the AG-UI run ends with `RUN_ERROR`, and nothing follows it. */
  | { kind: 'error'; code: string; message: string };
