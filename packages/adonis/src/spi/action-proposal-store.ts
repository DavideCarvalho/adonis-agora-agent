import type { AgentUiComponent } from '../stream-events.js';
import type { ToolConfirmation } from '../tool-presentation.js';
import type { PageContext } from '../types.js';
import type { UiCapabilities } from '../ui-capabilities.js';
import type {
  ActionProposalOutcome,
  ActionProposalOutcomeDelivery,
} from './action-proposal-outcome-store.js';

export interface ActionProposalScope {
  /** Explicit null or string; scope strings have at most 255 UTF-16 code units. */
  tenantRef: string | null;
  actorRef: string;
  threadId: string;
}

/** Persisted JSON execution descriptor; identity is resolved fresh from proposal scope. */
export interface ActionProposalExecutionContext {
  agentName?: string;
  persona?: string;
  requestId: string;
  uiCapabilities?: UiCapabilities;
  pageContext?: PageContext;
}

export interface CreateActionProposal extends ActionProposalScope {
  /** Globally unique deterministic identifier, at most 255 UTF-16 code units. */
  id: string;
  originRunId: string;
  originMessageId: string;
  originToolCallId: string;
  toolName: string;
  /** JSON-serializable immutable snapshot. */
  input: unknown;
  /** Original JSON before schema parsing; absence on legacy rows falls back to input. Null is present. */
  preparationInput?: unknown;
  /** Original execution address, never requester roles or transport/host handles. */
  executionContext?: ActionProposalExecutionContext;
  confirmation: ToolConfirmation;
  approver: string;
  /** Milliseconds since epoch; null means no expiry. */
  expiresAt: number | null;
  /** Stable across claims and crash recovery; tools must honor this key. */
  idempotencyKey: string;
  /** Explicit tool-authored replacement identity; never inferred from model text. */
  replacementKey?: string;
}

export type ActionProposalDecision = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
export interface ActionProposalDecisionCommand {
  decision: 'approved' | 'rejected' | 'expired';
  actorRef: string;
  via: string;
  reason?: string;
  remember?: boolean;
}
export interface ActionProposalDecisionAudit
  extends Omit<ActionProposalDecisionCommand, 'decision'> {
  at: number;
  replacementProposalId?: string;
}
export interface ActionProposalLease {
  token: string;
  generation: number;
  workerId: string;
  expiresAt: number;
}
export interface ActionProposalExecution {
  status: 'queued' | 'executing' | 'succeeded' | 'failed';
  generation: number;
  lease: ActionProposalLease | null;
  result?: unknown;
  error?: string;
}
export interface ActionProposal extends CreateActionProposal {
  decision: ActionProposalDecision;
  decisionAudit: ActionProposalDecisionAudit | null;
  /** Embedded durable execution work: created atomically with approval, absent before it. */
  execution: ActionProposalExecution | null;
  supersededBy?: string;
  outcome?: ActionProposalOutcome;
  outcomeDelivery?: ActionProposalOutcomeDelivery;
  createdAt: number;
  updatedAt: number;
}
export interface CreateActionProposalResult {
  status: 'created' | 'unchanged' | 'conflict';
  proposal?: ActionProposal;
}
export interface ActionProposalMutationResult {
  status: 'applied' | 'unchanged' | 'conflict' | 'not_found' | 'expired';
  /** Snapshot observed after the operation; concurrent operations may advance it. */
  proposal?: ActionProposal;
}
export interface ClaimActionProposal {
  workerId: string;
  leaseMs: number;
}
export interface ExtendActionProposalLease {
  token: string;
  generation: number;
  leaseMs: number;
}
export type SettleActionProposal = {
  token: string;
  generation: number;
  ui?: AgentUiComponent[];
  text?: string;
} & (
  | { status: 'succeeded'; result?: unknown; error?: never }
  | { status: 'failed'; error: string; result?: never }
);
export interface ListActionProposals {
  /** Default 100; integer 1..1000. Ties order by UTF-16 lexical logical id. */
  limit?: number;
  decision?: ActionProposalDecision;
  /** Exclusive cursor in the same creation-time / exact logical-id order. */
  after?: { createdAt: number; id: string };
}
export interface ActionProposalStoreOptions {
  /** Server-configured trusted clock, never a timestamp from a request. */
  clock?: () => number;
}

/**
 * Independent capability; AgentStore implementations are not required to implement it.
 * All identifiers are looked up within the complete scope. Creation must compare the original
 * immutable payload on replay and reject mismatches without disclosing a differently scoped row.
 * Decisions are first-wins CAS; approving atomically queues durable execution work. At now >=
 * expiresAt a pending proposal expires and cannot be approved or rejected. An explicit expiry
 * before that instant conflicts. Duplicate matching decisions are unchanged without replacing
 * audit data. Lease claims and recovery are atomic and fenced by token AND generation. Settlement
 * and renewal require a matching, unexpired lease; leaseMs must be a positive safe integer.
 * Execution recovery preserves the idempotency key (delivery is at least once, not exactly once).
 */
export interface ActionProposalStore {
  createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult>;
  getActionProposal(scope: ActionProposalScope, id: string): Promise<ActionProposal | null>;
  listActionProposals(
    scope: ActionProposalScope,
    query?: ListActionProposals,
  ): Promise<ActionProposal[]>;
  decideActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ActionProposalDecisionCommand,
  ): Promise<ActionProposalMutationResult>;
  claimActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ClaimActionProposal,
  ): Promise<ActionProposalMutationResult>;
  extendActionProposalLease(
    scope: ActionProposalScope,
    id: string,
    command: ExtendActionProposalLease,
  ): Promise<ActionProposalMutationResult>;
  settleActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: SettleActionProposal,
  ): Promise<ActionProposalMutationResult>;
}

export interface ActionProposalSupersessionStore {
  createReplacingActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult>;
  supersedeActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: { replacementProposalId: string; actorRef: string; via: string },
  ): Promise<ActionProposalMutationResult>;
}
