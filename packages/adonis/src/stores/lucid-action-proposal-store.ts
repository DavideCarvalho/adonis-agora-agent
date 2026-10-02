import { createHash, randomUUID } from 'node:crypto';
import {
  actionProposalCreationMatches,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  initialActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
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
import type { LucidDatabaseLike } from './lucid.js';
import { AGENT_TABLES, forDialect } from './lucid-schema.js';
import { isMySql } from './sql-dialect.js';

function key(value: unknown): string {
  return createHash('sha256').update(canonicalActionProposalJson(value)).digest('hex');
}
function proposalKey(id: string): string {
  return key(id);
}
function scopeKey(scope: ActionProposalScope): string {
  return key([scope.tenantRef, scope.actorRef, scope.threadId]);
}
function logicalSort(id: string): string {
  let value = '';
  for (let index = 0; index < id.length; index++)
    value += id.charCodeAt(index).toString(16).padStart(4, '0');
  return value;
}
function affected(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return affected(result[0]);
  if (result && typeof result === 'object') {
    for (const field of ['rowCount', 'changes', 'affectedRows']) {
      const value = Reflect.get(result, field);
      if (typeof value === 'number') return value;
    }
  }
  return 0;
}
function read(row: Record<string, unknown>): ActionProposal {
  return JSON.parse(String(row.payload)) as ActionProposal;
}

/**
 * Durable work is embedded in the proposal snapshot. One version-fenced UPDATE commits both
 * approval and queued work, so there is no dispatch gap requiring a second transactional table.
 * Physical keys hash exact JSON identities to avoid MySQL PAD SPACE/collation equivalence.
 */
export class LucidActionProposalStore implements ActionProposalStore {
  private readonly proposalClock: () => number;
  constructor(
    private readonly proposalDb: LucidDatabaseLike,
    options: ActionProposalStoreOptions = {},
    private readonly ensureProposalSchema: () => Promise<void> = async () => {},
  ) {
    this.proposalClock = options.clock ?? Date.now;
  }

  async createActionProposal(input: CreateActionProposal): Promise<CreateActionProposalResult> {
    await this.ensureProposalSchema();
    const proposal = initialActionProposal(input, this.proposalClock());
    const token = randomUUID();
    const mysql = isMySql(this.proposalDb);
    const columns = [
      'id',
      'scope_key',
      'logical_sort',
      'insert_token',
      'decision',
      'payload',
      'version',
      'created_at',
      'updated_at',
    ];
    const insertion = `INSERT INTO "${AGENT_TABLES.actionProposals}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const conflict = mysql
      ? ' ON DUPLICATE KEY UPDATE "id" = "id"'
      : ' ON CONFLICT ("id") DO NOTHING';
    // Conflict-ignore does not poison a PostgreSQL caller transaction. A per-insertion marker
    // identifies the creator independently of MySQL FOUND_ROWS or identical timestamps.
    await this.proposalDb.rawQuery(forDialect(insertion + conflict, mysql), [
      proposalKey(input.id),
      scopeKey(input),
      logicalSort(input.id),
      token,
      'pending',
      canonicalActionProposalJson(proposal),
      0,
      proposal.createdAt,
      proposal.updatedAt,
    ]);
    const row = await this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('id', proposalKey(input.id))
      .first();
    if (!row) throw new Error('Proposal insert did not persist a row');
    const existing = read(row);
    if (existing.id !== input.id || !actionProposalScopeMatches(existing, input))
      return { status: 'conflict' };
    if (row.insert_token === token) return { status: 'created', proposal: existing };
    return {
      status: actionProposalCreationMatches(existing, input) ? 'unchanged' : 'conflict',
      proposal: existing,
    };
  }

  async getActionProposal(scope: ActionProposalScope, id: string): Promise<ActionProposal | null> {
    await this.ensureProposalSchema();
    const row = await this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('id', proposalKey(id))
      .where('scope_key', scopeKey(scope))
      .first();
    if (!row) return null;
    const proposal = read(row);
    return proposal.id === id && actionProposalScopeMatches(proposal, scope) ? proposal : null;
  }

  async listActionProposals(
    scope: ActionProposalScope,
    query: ListActionProposals = {},
  ): Promise<ActionProposal[]> {
    await this.ensureProposalSchema();
    const limit = validateActionProposalListQuery(query);
    const builder = this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('scope_key', scopeKey(scope));
    if (query.decision !== undefined) builder.where('decision', query.decision);
    const rows = await builder
      .orderBy('created_at', 'asc')
      .orderBy('logical_sort', 'asc')
      .limit(limit)
      .select('*');
    return rows.map(read).filter((p) => actionProposalScopeMatches(p, scope));
  }

  private async mutate(
    scope: ActionProposalScope,
    id: string,
    transition: (proposal: ActionProposal, now: number) => ActionProposalMutationResult,
  ): Promise<ActionProposalMutationResult> {
    await this.ensureProposalSchema();
    for (let attempt = 0; attempt < 32; attempt++) {
      const row = await this.proposalDb
        .from(AGENT_TABLES.actionProposals)
        .where('id', proposalKey(id))
        .where('scope_key', scopeKey(scope))
        .first();
      if (!row) return { status: 'not_found' };
      const previous = read(row);
      if (previous.id !== id || !actionProposalScopeMatches(previous, scope))
        return { status: 'not_found' };
      // Recompute the trusted time after every lost CAS, never carry a stale expiry check.
      const result = transition(previous, this.proposalClock());
      if (
        !result.proposal ||
        canonicalActionProposalJson(previous) === canonicalActionProposalJson(result.proposal)
      )
        return result;
      const changed = await this.proposalDb
        .from(AGENT_TABLES.actionProposals)
        .where('id', proposalKey(id))
        .where('scope_key', scopeKey(scope))
        .where('version', row.version)
        .update({
          payload: canonicalActionProposalJson(result.proposal),
          decision: result.proposal.decision,
          version: Number(row.version) + 1,
          updated_at: result.proposal.updatedAt,
        });
      if (affected(changed) > 0) return result;
    }
    const proposal = await this.getActionProposal(scope, id);
    return proposal ? { status: 'conflict', proposal } : { status: 'not_found' };
  }

  decideActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ActionProposalDecisionCommand,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (p, now) => transitionActionProposalDecision(p, command, now));
  }
  claimActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: ClaimActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (p, now) =>
      transitionActionProposalClaim(p, command, now, randomUUID()),
    );
  }
  extendActionProposalLease(
    scope: ActionProposalScope,
    id: string,
    command: ExtendActionProposalLease,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (p, now) => transitionActionProposalLease(p, command, now));
  }
  settleActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: SettleActionProposal,
  ): Promise<ActionProposalMutationResult> {
    return this.mutate(scope, id, (p, now) => transitionActionProposalSettlement(p, command, now));
  }
}
