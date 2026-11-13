import type { AgentService } from './agent-service.js';
import { RunNotActiveError } from './dead-run.js';
import { HumanReplyMismatchError } from './elicitation.js';
import { evaluateOwnership } from './ownership.js';
import { REQUESTER_APPROVER } from './spi/approval-policy.js';
import type { Actor } from './types.js';

/** Why a HITL decision was not delivered: the HTTP status the routes answer, and the message. */
export interface DecisionRefusal {
  status: 403 | 404 | 409 | 410 | 501;
  message: string;
  code?: string;
}

/** The approve or reject a person makes on a parked tool call. */
export type ToolCallDecision =
  | { kind: 'approve'; remember?: boolean; via?: string }
  | { kind: 'reject'; reason?: string; via?: string };

export type ToolCallDecisionOutcome =
  | { ok: true; runId: string }
  | { ok: false; refusal: DecisionRefusal };

/**
 * Deliver one approve/reject to a parked tool call, under the HITL rules every surface shares
 * (`POST <path>/tool-call/approve|reject`, the console's approvals inbox, `agent:approvals:*`):
 *
 * 1. The run is the given `runId`, else the call's own row (unknown call → `404`).
 * 2. The call's recorded approver decides who may answer: the requester (the default) is the run's
 *    own actor, or a caller `privileged` says may act across actors; any other approver goes through
 *    the approval policy's `canDecide` (by default: holds that role) → `403`.
 * 3. A request that already lapsed (recorded `expired`, or past its `expiresAt`) → `410`.
 * 4. `fromAnotherProcess`: the caller is not the process running the turns (the CLI). Unless the
 *    runner's signals reach other processes (the durable runner), nothing there could resume the
 *    run → `501`, before anything is written. (Steps 2–4: {@link decisionRefusal}.)
 * 5. Delivered through `AgentService.approve`/`reject`; a run that has ended or a reply of the wrong
 *    kind → `409`.
 *
 * `privileged` is asked only for a requester-approved call.
 */
export async function decideToolCall(
  service: AgentService,
  input: {
    actor: Actor;
    toolCallId: string;
    runId?: string | undefined;
    privileged: () => Promise<boolean>;
    decision: ToolCallDecision;
    fromAnotherProcess?: boolean;
  },
): Promise<ToolCallDecisionOutcome> {
  const refuse = (refusal: DecisionRefusal): ToolCallDecisionOutcome => ({ ok: false, refusal });
  const { actor, toolCallId, decision } = input;
  const runId =
    typeof input.runId === 'string' && input.runId.length > 0
      ? input.runId
      : typeof toolCallId === 'string'
        ? await service.toolCallRun(toolCallId)
        : null;
  if (runId === null) return refuse({ status: 404, message: 'Unknown tool call.' });

  const refusal = await decisionRefusal(service, {
    actor,
    runId,
    toolCallId,
    privileged: input.privileged,
    ...(input.fromAnotherProcess !== undefined
      ? { fromAnotherProcess: input.fromAnotherProcess }
      : {}),
  });
  if (refusal !== null) return refuse(refusal);

  try {
    if (decision.kind === 'approve') {
      await service.approve(runId, toolCallId, {
        executedByRef: actor.id,
        ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
        ...(decision.via !== undefined ? { via: decision.via } : {}),
      });
    } else {
      await service.reject(runId, toolCallId, decision.reason, {
        executedByRef: actor.id,
        ...(decision.via !== undefined ? { via: decision.via } : {}),
      });
    }
  } catch (error) {
    // The run the decision was for has ended: nothing is waiting for it.
    if (error instanceof RunNotActiveError) {
      return refuse({ status: 409, code: error.code, message: error.message });
    }
    // The call waits for another kind of reply (a question set answered with a decision, or back).
    if (error instanceof HumanReplyMismatchError) {
      return refuse({ status: 409, message: error.message });
    }
    throw error;
  }
  return { ok: true, runId };
}

/**
 * May `actor` settle this call, and is it still open? `null` when so, else the refusal. The call's
 * recorded approver decides who: the requester (the default, and every call recorded before
 * approvers existed) is the run's own actor, or a caller `privileged` says may act across actors;
 * any other approver goes through the policy's `canDecide` (by default: holds that role) → `403`.
 * A request that already lapsed — recorded `expired`, or past its `expiresAt` with the run's own
 * timer about to fire — is `410`: signalling it anyway would race the timeout, and a late approval
 * must not be what a later replay of the run reads back. `fromAnotherProcess` (the CLI): unless the
 * runner's signals reach other processes (the durable runner), nothing there could resume the run
 * → `501`, before anything is written.
 */
export async function decisionRefusal(
  service: AgentService,
  input: {
    actor: Actor;
    runId: string;
    toolCallId: string;
    privileged: () => Promise<boolean>;
    fromAnotherProcess?: boolean;
  },
): Promise<DecisionRefusal | null> {
  const { actor, runId, toolCallId } = input;
  const approval = await service.toolCallApproval(toolCallId, runId);
  const approver = approval?.approver ?? REQUESTER_APPROVER;
  const owner = await service.runOwner(runId);
  if (approver === REQUESTER_APPROVER) {
    const verdict = evaluateOwnership(actor.id, owner, await input.privileged());
    if (!verdict.ok) {
      return verdict.status === 404
        ? { status: 404, message: 'run not found' }
        : { status: 403, message: 'forbidden' };
    }
  } else {
    if (owner === null) return { status: 404, message: 'Unknown run.' };
    if (!(await service.mayDecide(actor, { toolCallId, approver, requesterRef: owner }))) {
      return { status: 403, message: `This approval is for ${approver}.` };
    }
  }

  const lapsed =
    approval !== null &&
    (approval.status === 'expired' ||
      (approval.status === 'pending_approval' &&
        approval.expiresAt !== null &&
        Date.parse(approval.expiresAt) <= Date.now()));
  if (lapsed) {
    return {
      status: 410,
      message: `The approval request for tool call ${toolCallId} has expired.`,
    };
  }
  if (input.fromAnotherProcess === true && !service.signalsReachOtherProcesses) {
    return {
      status: 501,
      code: 'in_process_runner',
      message:
        'This app runs agent turns in-process (no durable runner), so a decision made outside the web process cannot reach the parked run. Decide it in the app, or run turns with `durable: true`.',
    };
  }
  return null;
}
