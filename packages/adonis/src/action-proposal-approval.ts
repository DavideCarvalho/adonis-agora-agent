import type { ApprovalPolicy, ApprovalThreadRef, ApprovalToolRef } from './spi/approval-policy.js';
import { DefaultApprovalPolicy } from './spi/approval-policy.js';
import type { Actor } from './types.js';
export type ClaimedActionApproval =
  | { mode: 'auto' }
  | { mode: 'remembered'; approver: string }
  | { mode: 'ask'; approver: string; ttlMs?: number; expiresAt?: string };
export interface ResolveActionProposalApprovalInput {
  actor: Actor;
  thread: ApprovalThreadRef;
  tool: ApprovalToolRef;
  store: { rememberedApprovals?(threadId: string): Promise<string[]> };
  policy?: ApprovalPolicy;
  clock?: () => number;
}
/** Journal this result on the trusted producer before choosing strict proposal preparation. */
export async function resolveActionProposalApproval(
  input: ResolveActionProposalApprovalInput,
): Promise<ClaimedActionApproval> {
  const policy = input.policy ?? new DefaultApprovalPolicy();
  const requirement = await policy.requirementFor(input.tool, input.actor, input.thread);
  if (!requirement.required) return { mode: 'auto' };
  const remembered = (await input.store.rememberedApprovals?.(input.thread.threadId)) ?? [];
  if (remembered.includes(input.tool.name))
    return { mode: 'remembered', approver: requirement.approver };
  const roundedTtl =
    requirement.ttlMs !== undefined && Number.isFinite(requirement.ttlMs)
      ? Math.floor(requirement.ttlMs)
      : 0;
  if (roundedTtl <= 0) return { mode: 'ask', approver: requirement.approver };
  const now = (input.clock ?? Date.now)();
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(roundedTtl) ||
    !Number.isSafeInteger(now + roundedTtl)
  )
    throw new RangeError('Invalid action approval deadline');
  return {
    mode: 'ask',
    approver: requirement.approver,
    ttlMs: roundedTtl,
    expiresAt: new Date(now + roundedTtl).toISOString(),
  };
}
