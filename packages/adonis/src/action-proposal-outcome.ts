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
/**
 * What happened, for the model (it reads the result from here) and the chat history. No proposal id:
 * the structured outcome stored with the message carries it.
 */
function outcomeSummary(outcome: ActionProposalOutcome): string {
  const tool = JSON.stringify(outcome.toolName);
  if (outcome.executionStatus === 'succeeded')
    return `Action ${tool} completed.${Object.hasOwn(outcome, 'result') ? ` Result: ${JSON.stringify(outcome.result)}` : ''}`;
  if (outcome.executionStatus === 'failed')
    return `Action ${tool} failed: ${JSON.stringify(outcome.error ?? 'Execution failed')}`;
  return `Action ${tool} was ${outcome.decision} and was not executed.${outcome.error ? ` Reason: ${JSON.stringify(outcome.error)}` : ''}`;
}
export function actionProposalOutcomeScope(outcome: ActionProposalOutcome): ActionProposalScope {
  return { tenantRef: outcome.tenantRef, actorRef: outcome.actorRef, threadId: outcome.threadId };
}

/**
 * Text a database column can hold: NUL and unpaired surrogates — which Postgres and SQLite refuse —
 * are written as their JSON escapes, the way the JSON summary already carries them.
 */
function storableText(text: string): string {
  return text
    .replaceAll(String.fromCharCode(0), '\\u0000')
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16)}`,
    );
}

/**
 * The outcome message admitted to the thread. The tool's own presentation text (`present` /
 * `emitUi`), when it has one, leads — what a person reads in the history; the summary follows.
 */
export function actionProposalOutcomeText(outcome: ActionProposalOutcome): string {
  const text = outcome.text === undefined ? undefined : storableText(outcome.text).trim();
  return text ? `${text}\n\n${outcomeSummary(outcome)}` : outcomeSummary(outcome);
}
