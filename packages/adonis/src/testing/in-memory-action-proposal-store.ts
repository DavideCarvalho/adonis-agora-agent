import { randomUUID } from 'node:crypto';
import {
  validateActionProposalExpiryBatch,
  validateActionProposalWorkerClaim,
} from '../action-proposal-discovery.js';
import {
  actionProposalCreationMatches,
  actionProposalScopeMatches,
  initialActionProposal,
  snapshotActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  validateActionProposalCreation,
  validateActionProposalListQuery,
} from '../action-proposal-transitions.js';
import type {
  ActionProposal,
  ActionProposalDecisionCommand,
  ActionProposalMutationResult,
  ActionProposalScope,
  ActionProposalStore,
  ActionProposalStoreOptions,
  ClaimActionProposal,
  CreateActionProposal,
  CreateActionProposalResult,
  ExtendActionProposalLease,
  ListActionProposals,
  SettleActionProposal,
} from '../spi/action-proposal-store.js';
import type { ActionProposalWorkerStore } from '../spi/action-proposal-worker-store.js';

/** Reference single-process implementation; durable adapters use the same transitions under CAS. */
export class InMemoryActionProposalStore implements ActionProposalStore, ActionProposalWorkerStore {
  private readonly rows = new Map<string, ActionProposal>();
  private readonly clock: () => number;
  constructor(options: ActionProposalStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }
  async createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    validateActionProposalCreation(input);
    const row = this.rows.get(input.id);
    if (row) {
      if (!actionProposalScopeMatches(row, input)) return { status: 'conflict' };
      return {
        status: actionProposalCreationMatches(row, input) ? 'unchanged' : 'conflict',
        proposal: snapshotActionProposal(row),
      };
    }
    const proposal = initialActionProposal(input, this.clock());
    this.rows.set(input.id, proposal);
    return { status: 'created', proposal: snapshotActionProposal(proposal) };
  }
  async getActionProposal(scope: ActionProposalScope, id: string): Promise<ActionProposal | null> {
    const row = this.rows.get(id);
    return row && actionProposalScopeMatches(row, scope) ? snapshotActionProposal(row) : null;
  }
  async listActionProposals(
    scope: ActionProposalScope,
    query: ListActionProposals = {},
  ): Promise<ActionProposal[]> {
    const limit = validateActionProposalListQuery(query);
    return [...this.rows.values()]
      .filter(
        (row) =>
          actionProposalScopeMatches(row, scope) &&
          (query.decision === undefined || row.decision === query.decision),
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map(snapshotActionProposal);
  }
  private mutate(
    scope: ActionProposalScope,
    id: string,
    transition: (row: ActionProposal, now: number) => ActionProposalMutationResult,
  ): ActionProposalMutationResult {
    const row = this.rows.get(id);
    if (!row || !actionProposalScopeMatches(row, scope)) return { status: 'not_found' };
    const result = transition(row, this.clock());
    if (result.proposal) this.rows.set(id, snapshotActionProposal(result.proposal));
    return result;
  }
  async decideActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ActionProposalDecisionCommand,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalDecision(row, command, now),
    );
  }
  async claimActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ClaimActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalClaim(row, command, now, randomUUID()),
    );
  }
  async extendActionProposalLease(
    scope: ActionProposalScope,
    id: string,
    command: ExtendActionProposalLease,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) => transitionActionProposalLease(row, command, now));
  }
  async settleActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: SettleActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (row, now) =>
      transitionActionProposalSettlement(row, command, now),
    );
  }

  async claimNextActionProposal(command: ClaimActionProposal): Promise<ActionProposal | null> {
    const now = this.clock();
    validateActionProposalWorkerClaim(command, now);
    const candidates = [...this.rows.values()]
      .filter(
        (row) =>
          row.decision === 'approved' &&
          (row.execution?.status === 'queued' ||
            (row.execution?.status === 'executing' &&
              row.execution.lease !== null &&
              now >= row.execution.lease.expiresAt)),
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 32);
    for (const candidate of candidates) {
      const claimed = await this.claimActionProposal(candidate, candidate.id, command);
      if (claimed.status === 'applied' && claimed.proposal) return claimed.proposal;
    }
    return null;
  }

  async expireActionProposals(command: { limit: number }): Promise<number> {
    const now = this.clock();
    validateActionProposalExpiryBatch(command, now);
    const candidates = [...this.rows.values()]
      .filter((row) => row.decision === 'pending' && row.expiresAt !== null && now >= row.expiresAt)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, command.limit);
    let expired = 0;
    for (const candidate of candidates) {
      const result = await this.decideActionProposal(candidate, candidate.id, {
        decision: 'expired',
        actorRef: 'system',
        via: 'expiry',
      });
      if (result.status === 'applied') expired++;
    }
    return expired;
  }
}
