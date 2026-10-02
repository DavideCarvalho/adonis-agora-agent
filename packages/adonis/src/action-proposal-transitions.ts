import { attachActionProposalOutcome } from './action-proposal-outcome.js';
import type {
  ActionProposal,
  ActionProposalDecisionCommand,
  ActionProposalMutationResult,
  ActionProposalScope,
  ClaimActionProposal,
  CreateActionProposal,
  ExtendActionProposalLease,
  ListActionProposals,
  SettleActionProposal,
} from './spi/action-proposal-store.js';
import { validateUiCapabilities } from './ui-capabilities.js';

function checkTime(value: number): void {
  if (!Number.isSafeInteger(value))
    throw new RangeError('Action proposal timestamps must be safe integer milliseconds');
}
function checkString(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('Action proposal identifiers must be nonempty strings');
}
export function validateActionProposalCreation(input: CreateActionProposal): void {
  const allowed = [
    'id',
    'tenantRef',
    'actorRef',
    'threadId',
    'originRunId',
    'originMessageId',
    'originToolCallId',
    'toolName',
    'input',
    'preparationInput',
    'executionContext',
    'confirmation',
    'approver',
    'expiresAt',
    'idempotencyKey',
    'replacementKey',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new TypeError('Unknown action proposal creation field');
  for (const key of [
    'id',
    'actorRef',
    'threadId',
    'originRunId',
    'originMessageId',
    'originToolCallId',
    'toolName',
    'approver',
    'idempotencyKey',
  ] as const)
    checkString(input[key]);
  if (input.tenantRef !== null && typeof input.tenantRef !== 'string')
    throw new TypeError('tenantRef must be an explicit string or null');
  for (const value of [input.id, input.actorRef, input.threadId, input.tenantRef]) {
    if (value !== null && value.length > 255)
      throw new RangeError('Action proposal id and scope must fit 255 UTF-16 code units');
  }
  if (input.replacementKey !== undefined) {
    checkString(input.replacementKey);
    if (input.replacementKey.length > 255)
      throw new RangeError('replacementKey must fit 255 UTF-16 code units');
  }
  if (Object.hasOwn(input, 'executionContext')) {
    const context = input.executionContext;
    if (context === null || typeof context !== 'object' || Array.isArray(context))
      throw new TypeError('executionContext must be a JSON object');
    const allowedContext = ['agentName', 'persona', 'requestId', 'pageContext', 'uiCapabilities'];
    if (Object.keys(context).some((key) => !allowedContext.includes(key)))
      throw new TypeError('Unknown execution context field');
    checkString(context.requestId);
    if (Object.hasOwn(context, 'uiCapabilities')) validateUiCapabilities(context.uiCapabilities);
    if (Object.hasOwn(context, 'agentName')) checkString(context.agentName);
    if (Object.hasOwn(context, 'persona')) checkString(context.persona);
    if (Object.hasOwn(context, 'pageContext')) {
      const page = context.pageContext;
      if (page === null || typeof page !== 'object' || Array.isArray(page))
        throw new TypeError('pageContext must be a JSON object');
      if (Object.hasOwn(page, 'kind') && typeof page.kind !== 'string')
        throw new TypeError('pageContext.kind must be a string');
    }
  }
  if (input.expiresAt !== null) checkTime(input.expiresAt);
  checkString(input.confirmation?.title);
  checkString(input.confirmation?.verb);
  canonicalActionProposalJson(input);
}

export function validateActionProposalListQuery(query: ListActionProposals = {}): number {
  const limit = query.limit === undefined ? 100 : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError('limit must be an integer from 1 to 1000');
  if (
    query.decision !== undefined &&
    !['pending', 'approved', 'rejected', 'expired', 'superseded'].includes(query.decision)
  )
    throw new TypeError('Unsupported action proposal list decision');
  if (query.after !== undefined) {
    const after = query.after;
    if (
      typeof after !== 'object' ||
      after === null ||
      Array.isArray(after) ||
      Object.keys(after).some((key) => key !== 'createdAt' && key !== 'id')
    )
      throw new TypeError('Invalid action proposal cursor');
    checkTime(after.createdAt);
    checkString(after.id);
    if (after.id.length > 255) throw new TypeError('Action proposal cursor id is too long');
  }
  return limit;
}

/** Canonical JSON snapshots keep replay equality independent of object key insertion order. */
export function canonicalActionProposalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const sort = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      throw new TypeError('Action proposals require finite, acyclic JSON values');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Action proposals require plain JSON objects');
    ancestors.add(item);
    const sorted = Array.isArray(item)
      ? Array.from(item, sort)
      : Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
        );
    ancestors.delete(item);
    return sorted;
  };
  return JSON.stringify(sort(value));
}
export function snapshotActionProposal<T>(value: T): T {
  return JSON.parse(canonicalActionProposalJson(value)) as T;
}
export function actionProposalScopeMatches(
  row: ActionProposalScope,
  scope: ActionProposalScope,
): boolean {
  return (
    row.tenantRef === scope.tenantRef &&
    row.actorRef === scope.actorRef &&
    row.threadId === scope.threadId
  );
}
export function initialActionProposal(input: CreateActionProposal, now: number): ActionProposal {
  validateActionProposalCreation(input);
  checkTime(now);
  return snapshotActionProposal({
    ...input,
    decision: 'pending',
    decisionAudit: null,
    execution: null,
    createdAt: now,
    updatedAt: now,
  });
}
export function actionProposalCreationMatches(
  row: ActionProposal,
  input: CreateActionProposal,
): boolean {
  validateActionProposalCreation(input);
  const {
    decision: _decision,
    decisionAudit: _audit,
    execution: _execution,
    createdAt: _created,
    updatedAt: _updated,
    supersededBy: _supersededBy,
    outcome: _outcome,
    outcomeDelivery: _delivery,
    ...original
  } = row;
  return canonicalActionProposalJson(original) === canonicalActionProposalJson(input);
}
function result(
  status: ActionProposalMutationResult['status'],
  proposal: ActionProposal,
): ActionProposalMutationResult {
  return { status, proposal: snapshotActionProposal(proposal) };
}
export function transitionActionProposalDecision(
  row: ActionProposal,
  command: ActionProposalDecisionCommand,
  now: number,
): ActionProposalMutationResult {
  checkTime(now);
  if (!['approved', 'rejected', 'expired'].includes(command.decision))
    throw new TypeError('Unsupported action proposal decision');
  checkString(command.actorRef);
  checkString(command.via);
  if (command.reason !== undefined && typeof command.reason !== 'string')
    throw new TypeError('reason must be a string');
  if (command.remember !== undefined && typeof command.remember !== 'boolean')
    throw new TypeError('remember must be a boolean');
  if (row.decision !== 'pending') {
    return result(
      row.decision === command.decision
        ? 'unchanged'
        : row.decision === 'expired'
          ? 'expired'
          : 'conflict',
      row,
    );
  }
  const next = snapshotActionProposal(row);
  if (row.expiresAt !== null && now >= row.expiresAt) {
    next.decision = 'expired';
    next.decisionAudit = { actorRef: 'system', via: 'expiry', at: now };
    next.updatedAt = now;
    return result(
      command.decision === 'expired' ? 'applied' : 'expired',
      attachActionProposalOutcome(next, now),
    );
  }
  if (command.decision === 'expired') return result('conflict', row);
  const { decision, ...audit } = command;
  next.decision = decision;
  next.decisionAudit = {
    actorRef: audit.actorRef,
    via: audit.via,
    at: now,
    ...(audit.reason === undefined ? {} : { reason: audit.reason }),
    ...(audit.remember === undefined ? {} : { remember: audit.remember }),
  };
  next.updatedAt = now;
  if (decision === 'approved') next.execution = { status: 'queued', generation: 0, lease: null };
  return result('applied', decision === 'approved' ? next : attachActionProposalOutcome(next, now));
}
function checkLeaseMs(leaseMs: number, now: number): void {
  checkTime(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs))
    throw new RangeError('leaseMs must be finite and positive');
}
export function transitionActionProposalClaim(
  row: ActionProposal,
  command: ClaimActionProposal,
  now: number,
  token: string,
): ActionProposalMutationResult {
  checkLeaseMs(command.leaseMs, now);
  checkString(command.workerId);
  checkString(token);
  const execution = row.execution;
  if (
    row.decision !== 'approved' ||
    !execution ||
    (execution.status !== 'queued' &&
      !(execution.status === 'executing' && execution.lease && now >= execution.lease.expiresAt))
  )
    return result('conflict', row);
  const next = snapshotActionProposal(row);
  const generation = execution.generation + 1;
  next.execution = {
    status: 'executing',
    generation,
    lease: { token, generation, workerId: command.workerId, expiresAt: now + command.leaseMs },
  };
  next.updatedAt = now;
  return result('applied', next);
}
function leaseStatus(
  row: ActionProposal,
  command: { token: string; generation: number },
  now: number,
): 'valid' | 'conflict' | 'expired' {
  checkTime(now);
  checkString(command.token);
  if (!Number.isSafeInteger(command.generation) || command.generation < 1)
    throw new RangeError('Invalid lease generation');
  const work = row.execution;
  if (
    row.decision !== 'approved' ||
    work?.status !== 'executing' ||
    !work.lease ||
    work.generation !== command.generation ||
    work.lease.generation !== command.generation ||
    work.lease.token !== command.token
  )
    return 'conflict';
  return now >= work.lease.expiresAt ? 'expired' : 'valid';
}
export function transitionActionProposalLease(
  row: ActionProposal,
  command: ExtendActionProposalLease,
  now: number,
): ActionProposalMutationResult {
  checkLeaseMs(command.leaseMs, now);
  const status = leaseStatus(row, command, now);
  if (status !== 'valid') return result(status, row);
  const next = snapshotActionProposal(row);
  if (next.execution?.lease)
    next.execution.lease.expiresAt = Math.max(
      next.execution.lease.expiresAt,
      now + command.leaseMs,
    );
  next.updatedAt = now;
  return result('applied', next);
}
export function transitionActionProposalSettlement(
  row: ActionProposal,
  command: SettleActionProposal,
  now: number,
): ActionProposalMutationResult {
  checkTime(now);
  if (command.status !== 'succeeded' && command.status !== 'failed')
    throw new TypeError('Unsupported settlement status');
  if (
    (command.status === 'succeeded' && command.error !== undefined) ||
    (command.status === 'failed' &&
      (typeof command.error !== 'string' || command.result !== undefined))
  )
    throw new TypeError('Ambiguous action proposal settlement');
  const status = leaseStatus(row, command, now);
  if (status !== 'valid') return result(status, row);
  const next = snapshotActionProposal(row);
  next.execution =
    command.status === 'succeeded'
      ? {
          status: 'succeeded',
          generation: command.generation,
          lease: null,
          ...(command.result === undefined ? {} : { result: command.result }),
        }
      : { status: 'failed', generation: command.generation, lease: null, error: command.error };
  if (command.ui !== undefined) canonicalActionProposalJson(command.ui);
  if (command.text !== undefined && typeof command.text !== 'string')
    throw new TypeError('Outcome text must be a string');
  next.updatedAt = now;
  return result('applied', attachActionProposalOutcome(next, now, command.ui, command.text));
}

/** Caller must obtain the replacement through the same full scope and persistence authority. */
export function transitionActionProposalSupersession(
  row: ActionProposal,
  replacement: ActionProposal,
  command: { replacementProposalId: string; actorRef: string; via: string },
  now: number,
): ActionProposalMutationResult {
  checkTime(now);
  checkString(command.replacementProposalId);
  checkString(command.actorRef);
  checkString(command.via);
  if (
    replacement.id !== command.replacementProposalId ||
    row.id === replacement.id ||
    !actionProposalScopeMatches(row, replacement) ||
    row.toolName !== replacement.toolName ||
    !row.replacementKey ||
    row.replacementKey !== replacement.replacementKey
  )
    return result('conflict', row);
  if (row.decision === 'superseded')
    return result(row.supersededBy === replacement.id ? 'unchanged' : 'conflict', row);
  if (row.decision !== 'pending') return result('conflict', row);
  if (row.expiresAt !== null && now >= row.expiresAt)
    return {
      ...transitionActionProposalDecision(
        row,
        { decision: 'expired', actorRef: 'system', via: 'expiry' },
        now,
      ),
      status: 'expired',
    };
  const next = snapshotActionProposal({
    ...row,
    decision: 'superseded' as const,
    supersededBy: replacement.id,
    decisionAudit: {
      actorRef: command.actorRef,
      via: command.via,
      replacementProposalId: replacement.id,
      at: now,
    },
    updatedAt: now,
  });
  return result('applied', attachActionProposalOutcome(next, now));
}
