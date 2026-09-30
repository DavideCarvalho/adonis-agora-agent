/**
 * The slice of AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0) this producer writes and reads. Typed by
 * hand rather than imported: the agent package takes no dependency on an AG-UI SDK, and the wire
 * shape is pinned by the protocol's own JSON Schema, which the tests validate every emitted event
 * against (`test/fixtures/ag-ui/schema-1.0.json`).
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
  | (Base & { type: 'CUSTOM'; name: string; value: unknown });

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
  /** The whole question set of an elicitation (`ElicitationRequest`). */
  elicitation: 'agora.elicitation',
  /** `{ usage, costUsd, reasoningMs }` of one model step. */
  stepUsage: 'agora.step-usage',
  /** `{ message }` — input material this producer could not use and dropped. */
  warning: 'agora.warning',
} as const;
