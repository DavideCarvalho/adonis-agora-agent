/**
 * The chat stream protocol shared with `@dudousxd/nestjs-agent`: the vocabulary every run's SSE carries
 * (see `docs/streaming-and-http.mdx`).
 *
 * It is a COPY of `AgentStreamEvent` in `@dudousxd/nestjs-agent-core/src/stream-events.ts`, kept
 * field-for-field identical rather than imported: neither repo depends on the other (the guardrails
 * detectors are shared the same way). The frame is the contract, so that React client — the
 * transport, `useAgentChat`, the transcript model — renders an Adonis run unchanged.
 *
 * Two rules keep it evolvable, on both sides at once:
 *  - every frame is a JSON object with a string `kind`; a reader MUST tolerate kinds it does not
 *    know (the React transport forwards them as `data-<kind>` parts rather than dropping them);
 *  - fields are only ever added, and new fields are optional.
 */
import type { ElicitationRequest } from './elicitation.js';
import type { ChatQueueState } from './spi/chat-queue.js';
import type { ToolConfirmation } from './tool-presentation.js';
import type { MessageUsage } from './types.js';

/**
 * A component the server pushed into the conversation: generative UI that is not a tool call's
 * rendering. `component` is a key into the client's own registry; `id` is its identity within the
 * message — a second frame with the same `id` REPLACES the first, it never adds a second one.
 */
export interface AgentUiComponent {
  id: string;
  component: string;
  props: Record<string, unknown>;
  /** Schema version of `props`, so a client can keep rendering components an older server persisted. */
  version?: number;
  fallbackText?: string;
  componentVersions?: Record<string, number>;
  /** The tool call that pushed the component, when one did. */
  toolCallId?: string;
  /**
   * A PREVIEW, drawn from a tool call's arguments while the model is still writing them (genui
   * `streaming: 'partial'`): unvalidated, never persisted, and replaced in place by the final push
   * under the same `id` — or withdrawn by a partial frame with empty `props`, which a client renders
   * as nothing. A text surface skips it. Absent on every final frame.
   */
  partial?: true;
}

/** Who has to settle an action tool call, and until when. Metadata: the call still settles by id. */
export interface AgentApprovalRequest {
  confirmation?: ToolConfirmation;
  id: string;
  /** Open vocabulary: `'requester'` (the person chatting), `'admin'`, a role, a team. */
  approver: string;
  /** ISO-8601 instant after which the request lapses. Absent → it never expires. */
  expiresAt?: string;
  reason?: string;
}

/** How an approval settled — the other half of {@link AgentApprovalRequest}, under the same `id`. */
export interface AgentApprovalSettlement {
  id: string;
  status: 'approved' | 'rejected' | 'expired';
  approver?: string;
  decidedBy?: string;
  decidedVia?: string;
  remember?: boolean;
  reason?: string;
}

export type AgentStreamEvent =
  | { kind: 'step-start' }
  | {
      kind: 'step-finish';
      usage?: MessageUsage;
      /** An estimate or the provider's figure; `null` when unpriced — never a fabricated `0`. */
      costUsd?: number | null;
      reasoningMs?: number;
      /** The model the step ran on, when the provider reported one — what a per-model usage report keys on. */
      model?: string;
    }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool-input-start';
      id: string;
      name: string;
      toolKind: 'read' | 'action';
      parentId?: string;
    }
  | { kind: 'tool-input-delta'; id: string; delta: string }
  | {
      kind: 'tool-input-available';
      id: string;
      name: string;
      input: unknown;
      toolKind: 'read' | 'action';
      parentId?: string;
    }
  | { kind: 'tool-output'; id: string; output: unknown }
  | { kind: 'tool-output-error'; id: string; error: string }
  /** A person declined an action: nothing ran. Distinct from a failure, whose effects are unknown. */
  | { kind: 'tool-output-denied'; id: string; reason?: string }
  | { kind: 'elicitation'; id: string; request: ElicitationRequest }
  | ({ kind: 'approval-requested' } & AgentApprovalRequest)
  | ({ kind: 'approval-settled' } & AgentApprovalSettlement)
  | ({ kind: 'ui' } & AgentUiComponent)
  | { kind: 'title'; title: string }
  /** Someone stopped the run: the stream's last frame before a normal end. */
  | { kind: 'cancelled' }
  /**
   * The thread's message queue changed — a snapshot of the whole queue, never a delta, so a client
   * that missed one frame is corrected by the next. Written into the stream of the run that is
   * holding the thread: when someone queues, edits, reorders or removes a waiting message, and, just
   * before this run's own terminal frame, with what happens next — `started` names the queued
   * message that became the next turn and that turn's run id (attach to it with
   * `GET <base>/chat/:runId/stream`), `queue.paused` says why nothing starts.
   */
  | { kind: 'queue'; queue: ChatQueueState; started?: { messageId: string; runId: string } };

/** The `event: error` codes the provider writes, matching the NestJS library's. */
export type AgentStreamErrorCode =
  | 'quota_exceeded'
  | 'output_rejected'
  | 'structured_output_invalid'
  /** The durable runtime refused a checkpoint position: the run's journal and its code disagree. */
  | 'replay_diverged'
  /** A model call ended without producing anything. */
  | 'model_no_output'
  | 'run_failed';
