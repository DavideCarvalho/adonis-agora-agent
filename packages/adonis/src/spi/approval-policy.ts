import type { ToolConfirmation } from '../tool-presentation.js';
import type {
  Actor,
  ToolCallApproval,
  ToolCallApprovalStatus,
  ToolCallStatus,
  ToolKind,
  ToolSpec,
} from '../types.js';

/*
 * The approval SPI of `@dudousxd/nestjs-agent-core`, copied: the same policy shape, the same default
 * decider rule and the same row → `ToolCallApproval` mapping, so the two libraries put the same
 * frames on the wire and answer the same statuses on the approve/reject routes.
 */

/** The approver that means "the person the run is acting for" — the thread's own actor. */
export const REQUESTER_APPROVER = 'requester';

/** The tool a requirement is asked about. `spec` is absent where this process cannot resolve it. */
export interface ApprovalToolRef {
  name: string;
  kind: ToolKind;
  spec?: ToolSpec;
}

/** Where the call is being made. */
export interface ApprovalThreadRef {
  threadId: string;
  runId: string;
  agentName?: string;
}

/**
 * What an action tool call needs before it runs.
 *
 *  - `required: false` → the call runs without asking anyone (it is still recorded as an action).
 *  - `approver` → who may decide: {@link REQUESTER_APPROVER} (the thread's own actor — the default)
 *    or any other string, which the default {@link ApprovalPolicy.canDecide} reads as a ROLE the
 *    decider must hold. Streamed on `approval-requested` and persisted on the call.
 *  - `ttlMs` → how long the request stays open. When it lapses the call settles `expired` and the
 *    model is told nobody approved it. Absent → it waits indefinitely.
 */
export interface ApprovalRequirement {
  required: boolean;
  approver: string;
  ttlMs?: number;
}

/** A decision about to be taken on a call, as {@link ApprovalPolicy.canDecide} sees it. */
export interface ApprovalDecisionRef {
  toolCallId: string;
  /** The approver recorded on the call when it was put to a person. */
  approver: string;
  /** The actorRef the run is acting for — the owner of the call's thread. */
  requesterRef: string;
}

/**
 * Who has to approve an action tool call, and for how long the request stays open.
 *
 * Consulted by the LOOP once per `action` call, inside the call's `persist:toolcall` checkpoint — so
 * a durable run reads the answer back on every replay instead of re-deciding it against a policy
 * that may have changed while it was parked. Only `action` calls are asked about: a policy cannot
 * put a `read` behind an approval, and an `ask` (a question set) is always the requester's.
 */
export interface ApprovalPolicy {
  requirementFor(
    tool: ApprovalToolRef,
    actor: Actor,
    thread: ApprovalThreadRef,
  ): ApprovalRequirement | Promise<ApprovalRequirement>;
  /**
   * May `actor` settle this call? Checked by the approve/reject routes before a decision is
   * signalled. Absent → {@link defaultCanDecide}: the requester approver means the thread's own
   * actor, anything else is a role the actor must hold. Plug an authz Gate here for abilities.
   */
  canDecide?(actor: Actor, decision: ApprovalDecisionRef): boolean | Promise<boolean>;
}

/**
 * The shorthand `config/agent.ts` takes instead of a whole {@link ApprovalPolicy}: who decides and
 * for how long, for every `action` call — or per tool, by name. `approvalPolicy: { ttlMs: 900_000 }`
 * expires every request after 15 minutes; `{ tools: { refund: { approver: 'admin' } } }` routes
 * refunds to admins and leaves every other action with the requester.
 */
export interface ApprovalRules {
  /** Who decides by default: `'requester'` (the default) or a role name. */
  approver?: string;
  /** How long a request stays open by default, in ms. Omit → it never lapses. */
  ttlMs?: number;
  /** Per-tool overrides. `required: false` runs that action without asking anyone. */
  tools?: Record<string, Partial<ApprovalRequirement>>;
}

/** An {@link ApprovalPolicy} built from {@link ApprovalRules}. */
export function approvalRules(rules: ApprovalRules): ApprovalPolicy {
  return {
    requirementFor(tool) {
      const override = rules.tools?.[tool.name] ?? {};
      const ttlMs = override.ttlMs ?? rules.ttlMs;
      return {
        required: override.required ?? tool.kind === 'action',
        approver: override.approver ?? rules.approver ?? REQUESTER_APPROVER,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      };
    },
  };
}

/** Accept either a whole policy or the {@link ApprovalRules} shorthand. */
export function toApprovalPolicy(value: ApprovalPolicy | ApprovalRules): ApprovalPolicy {
  return typeof (value as ApprovalPolicy).requirementFor === 'function'
    ? (value as ApprovalPolicy)
    : approvalRules(value as ApprovalRules);
}

/**
 * The behaviour the lib always had: every `action` call waits on the person who asked, with no
 * expiry.
 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  requirementFor(tool: ApprovalToolRef): ApprovalRequirement {
    return { required: tool.kind === 'action', approver: REQUESTER_APPROVER };
  }
}

/** The default decider rule — see {@link ApprovalPolicy.canDecide}. */
export function defaultCanDecide(actor: Actor, decision: ApprovalDecisionRef): boolean {
  if (decision.approver === REQUESTER_APPROVER) {
    return actor.id === decision.requesterRef;
  }
  return actor.roles?.includes(decision.approver) === true;
}

/** Resolve whether `actor` may decide, through the policy's own rule when it has one. */
export async function mayDecideApproval(
  policy: ApprovalPolicy | undefined,
  actor: Actor,
  decision: ApprovalDecisionRef,
): Promise<boolean> {
  if (policy?.canDecide !== undefined) {
    return policy.canDecide(actor, decision);
  }
  return defaultCanDecide(actor, decision);
}

/** The columns a store keeps for one call's approval, however it names them. */
export interface ToolCallApprovalColumns {
  confirmation?: ToolConfirmation | undefined;
  toolCallId: string;
  status: ToolCallStatus;
  approver: string | null | undefined;
  expiresAt: string | Date | null | undefined;
  remember: boolean | null | undefined;
  executedByRef: string | null | undefined;
  decidedVia: string | null | undefined;
  error: string | null | undefined;
}

/** What the approve/reject routes need to know about a call before they signal a decision on it. */
export interface ToolCallApprovalState {
  status: ToolCallStatus;
  /** `null` for a call no policy put to anyone (an `ask`, or a row written before approvers existed). */
  approver: string | null;
  expiresAt: string | null;
}

/**
 * Read a tool-call row back as the {@link ToolCallApproval} a thread carries, or `null` for a call
 * no policy put to anyone (no approver recorded). Shared by every store so they agree on the
 * status mapping: a call that ran — or ran and failed — after a decision was APPROVED.
 */
export function toolCallApprovalFromRow(row: ToolCallApprovalColumns): ToolCallApproval | null {
  if (row.approver === null || row.approver === undefined) {
    return null;
  }
  const status: ToolCallApprovalStatus =
    row.status === 'pending_approval'
      ? 'pending'
      : row.status === 'rejected'
        ? 'rejected'
        : row.status === 'expired'
          ? 'expired'
          : 'approved';
  const expiresAt =
    row.expiresAt instanceof Date
      ? row.expiresAt.toISOString()
      : typeof row.expiresAt === 'string'
        ? row.expiresAt
        : undefined;
  const decided = status === 'approved' || status === 'rejected';
  return {
    toolCallId: row.toolCallId,
    ...(row.confirmation !== undefined ? { confirmation: row.confirmation } : {}),
    approver: row.approver,
    status,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(row.remember === true ? { remember: true } : {}),
    ...(decided && typeof row.executedByRef === 'string' ? { decidedBy: row.executedByRef } : {}),
    ...(decided && typeof row.decidedVia === 'string' ? { decidedVia: row.decidedVia } : {}),
    ...(status === 'rejected' && typeof row.error === 'string' ? { reason: row.error } : {}),
  };
}
