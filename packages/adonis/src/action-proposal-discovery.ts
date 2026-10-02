import type { ClaimActionProposal } from './spi/action-proposal-store.js';

export function validateActionProposalWorkerClaim(command: ClaimActionProposal, now: number): void {
  if (!Number.isSafeInteger(now)) throw new RangeError('Invalid action proposal clock');
  if (typeof command.workerId !== 'string' || command.workerId.length === 0)
    throw new TypeError('workerId must be a nonempty string');
  if (
    !Number.isSafeInteger(command.leaseMs) ||
    command.leaseMs <= 0 ||
    !Number.isSafeInteger(now + command.leaseMs)
  )
    throw new RangeError('leaseMs must be positive safe integer milliseconds');
}

export function validateActionProposalExpiryBatch(command: { limit: number }, now: number): void {
  if (!Number.isSafeInteger(now)) throw new RangeError('Invalid action proposal clock');
  if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 1000)
    throw new RangeError('limit must be an integer from 1 to 1000');
}
