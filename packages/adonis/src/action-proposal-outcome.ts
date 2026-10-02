import { validateActionProposalWorkerClaim } from './action-proposal-discovery.js';
import { snapshotActionProposal } from './action-proposal-transitions.js';
import type {
  ActionProposalOutcome,
  ActionProposalOutcomeLease,
} from './spi/action-proposal-outcome-store.js';
import type { ActionProposal, ActionProposalScope } from './spi/action-proposal-store.js';
import type { AgentUiComponent } from './stream-events.js';

export function attachActionProposalOutcome(
  row: ActionProposal,
  now: number,
  ui: AgentUiComponent[] = [],
  text?: string,
): ActionProposal {
  if (row.outcome) return row;
  const execution = row.execution;
  const outcome: ActionProposalOutcome = {
    id: `${row.id}:outcome:1`,
    proposalId: row.id,
    outcomeVersion: 1,
    tenantRef: row.tenantRef,
    actorRef: row.actorRef,
    threadId: row.threadId,
    originRunId: row.originRunId,
    originToolCallId: row.originToolCallId,
    toolName: row.toolName,
    decision: row.decision,
    ui,
    createdAt: now,
    ...(text !== undefined ? { text } : {}),
    ...(execution?.status === 'succeeded' || execution?.status === 'failed'
      ? { executionStatus: execution.status }
      : {}),
    ...(execution && Object.hasOwn(execution, 'result') ? { result: execution.result } : {}),
    ...(execution?.error !== undefined
      ? { error: execution.error }
      : row.decisionAudit?.reason !== undefined
        ? { error: row.decisionAudit.reason }
        : {}),
  };
  return snapshotActionProposal({
    ...row,
    outcome,
    outcomeDelivery: { status: 'pending', generation: 0, lease: null },
  });
}
export function claimActionProposalOutcome(
  row: ActionProposal,
  command: { workerId: string; leaseMs: number },
  now: number,
  token: string,
): ActionProposal | null {
  validateActionProposalWorkerClaim(command, now);
  const delivery = row.outcomeDelivery;
  if (
    !row.outcome ||
    !delivery ||
    delivery.status !== 'pending' ||
    (delivery.lease && now < delivery.lease.expiresAt)
  )
    return null;
  const generation = delivery.generation + 1;
  return snapshotActionProposal({
    ...row,
    outcomeDelivery: {
      ...delivery,
      generation,
      lease: { token, generation, workerId: command.workerId, expiresAt: now + command.leaseMs },
    },
  });
}
export function actionProposalOutcomeFenceValid(
  row: ActionProposal,
  command: ActionProposalOutcomeLease,
  now: number,
): boolean {
  if (!Number.isSafeInteger(now)) throw new RangeError('Invalid server clock');
  if (
    typeof command.token !== 'string' ||
    !command.token ||
    !Number.isSafeInteger(command.generation) ||
    command.generation < 1 ||
    typeof command.outcomeId !== 'string' ||
    !command.outcomeId
  )
    throw new TypeError('Invalid outcome fence');
  const delivery = row.outcomeDelivery;
  return (
    row.outcome?.id === command.outcomeId &&
    delivery?.status === 'pending' &&
    delivery.generation === command.generation &&
    delivery.lease?.token === command.token &&
    delivery.lease.generation === command.generation &&
    now < delivery.lease.expiresAt
  );
}
function outcomeSummary(outcome: ActionProposalOutcome): string {
  if (outcome.executionStatus === 'succeeded')
    return `Action ${JSON.stringify(outcome.toolName)} completed (proposal ${JSON.stringify(outcome.proposalId)}).${Object.hasOwn(outcome, 'result') ? ` Result: ${JSON.stringify(outcome.result)}` : ''}`;
  if (outcome.executionStatus === 'failed')
    return `Action ${JSON.stringify(outcome.toolName)} failed (proposal ${JSON.stringify(outcome.proposalId)}): ${JSON.stringify(outcome.error ?? 'Execution failed')}`;
  return `Action ${JSON.stringify(outcome.toolName)} was ${outcome.decision} (proposal ${JSON.stringify(outcome.proposalId)}) and was not executed.${outcome.error ? ` Reason: ${JSON.stringify(outcome.error)}` : ''}`;
}
export function actionProposalOutcomeScope(outcome: ActionProposalOutcome): ActionProposalScope {
  return { tenantRef: outcome.tenantRef, actorRef: outcome.actorRef, threadId: outcome.threadId };
}

export function actionProposalOutcomeText(outcome: ActionProposalOutcome): string {
  return outcomeSummary(outcome) + (outcome.text ? ` UI: ${JSON.stringify(outcome.text)}` : '');
}
