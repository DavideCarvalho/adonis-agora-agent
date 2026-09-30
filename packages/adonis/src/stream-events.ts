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
  /** The tool call that pushed the component, when one did. */
  toolCallId?: string;
}

/** Who has to settle an action tool call, and until when. Metadata: the call still settles by id. */
export interface AgentApprovalRequest {
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
  | { kind: 'cancelled' };

/** The `event: error` codes the provider writes, matching the NestJS library's. */
export type AgentStreamErrorCode =
  | 'quota_exceeded'
  | 'output_rejected'
  | 'structured_output_invalid'
  | 'run_failed';
