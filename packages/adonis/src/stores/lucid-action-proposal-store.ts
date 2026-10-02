import { createHash, randomUUID } from 'node:crypto';
import {
  validateActionProposalDiscoveryIndexBatch,
  validateActionProposalExpiryBatch,
  validateActionProposalWorkerClaim,
} from '../action-proposal-discovery.js';
import {
  actionProposalOutcomeFenceValid,
  actionProposalOutcomeText,
  claimActionProposalOutcome,
} from '../action-proposal-outcome.js';
import {
  actionProposalCreationMatches,
  actionProposalScopeMatches,
  canonicalActionProposalJson,
  initialActionProposal,
  transitionActionProposalClaim,
  transitionActionProposalDecision,
  transitionActionProposalLease,
  transitionActionProposalSettlement,
  transitionActionProposalSupersession,
  validateActionProposalListQuery,
} from '../action-proposal-transitions.js';
import type {
  ActionProposalOutcomeLease,
  ActionProposalOutcomeStore,
} from '../spi/action-proposal-outcome-store.js';
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
import type {
  ActionProposalDiscoveryIndexStore,
  ActionProposalWorkerStore,
} from '../spi/action-proposal-worker-store.js';
import type { LucidDatabaseLike } from './lucid.js';
import { AGENT_TABLES, forDialect, rowsOf } from './lucid-schema.js';
import { isMySql } from './sql-dialect.js';
import { withStoreTransaction } from './sqlite-transactions.js';

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

function discoveryMetadata(proposal: ActionProposal) {
  return {
    replacement_group_key:
      proposal.replacementKey === undefined
        ? null
        : key([proposal.toolName, proposal.replacementKey]),
    decision: proposal.decision,
    execution_status: proposal.execution?.status ?? null,
    lease_expires_at: proposal.execution?.lease?.expiresAt ?? null,
    proposal_expires_at: proposal.expiresAt,
    discovery_index_version: 1,
    outcome_key: proposal.outcome ? key(proposal.outcome.id) : null,
    delivery_status: proposal.outcomeDelivery?.status ?? null,
    delivery_lease_expires_at: proposal.outcomeDelivery?.lease?.expiresAt ?? null,
  };
}

/**
 * Durable work is embedded in the proposal snapshot. One version-fenced UPDATE commits both
 * approval and queued work, so there is no dispatch gap requiring a second transactional table.
 * Physical keys hash exact JSON identities to avoid MySQL PAD SPACE/collation equivalence.
 */
export class LucidActionProposalStore
  implements
    ActionProposalStore,
    ActionProposalWorkerStore,
    ActionProposalDiscoveryIndexStore,
    ActionProposalOutcomeStore
{
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
      'execution_status',
      'lease_expires_at',
      'proposal_expires_at',
      'discovery_index_version',
      'replacement_group_key',
      'outcome_key',
      'delivery_status',
      'delivery_lease_expires_at',
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
      null,
      null,
      proposal.expiresAt,
      1,
      proposal.replacementKey === undefined
        ? null
        : key([proposal.toolName, proposal.replacementKey]),
      null,
      null,
      null,
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

  async createReplacingActionProposal(
    input: CreateActionProposal,
  ): Promise<CreateActionProposalResult> {
    initialActionProposal(input, this.proposalClock());
    await this.ensureProposalSchema();
    if (input.replacementKey === undefined) return this.createActionProposal(input);
    return withStoreTransaction(this.proposalDb, async (client) => {
      const tx = client as LucidDatabaseLike;
      await tx.rawQuery(
        forDialect(
          `UPDATE "${AGENT_TABLES.threads}" SET "updated_at" = "updated_at" WHERE "id" = ?`,
          isMySql(this.proposalDb),
        ),
        [input.threadId],
      );
      const scope = await tx
        .from(AGENT_TABLES.threads)
        .where('id', input.threadId)
        .whereNull('deleted_at')
        .first();
      if (
        !scope ||
        scope.id !== input.threadId ||
        scope.actor_ref !== input.actorRef ||
        (scope.tenant_ref ?? null) !== input.tenantRef
      )
        return { status: 'conflict' };
      const adapter = new LucidActionProposalStore(tx, { clock: this.proposalClock });
      const created = await adapter.createActionProposal(input);
      if (created.status !== 'created') return created;
      const siblings = await tx
        .from(AGENT_TABLES.actionProposals)
        .where('scope_key', scopeKey(input))
        .where('decision', 'pending')
        .where('replacement_group_key', key([input.toolName, input.replacementKey]))
        .select('*');
      for (const row of siblings) {
        const sibling = read(row);
        if (
          sibling.id === input.id ||
          sibling.toolName !== input.toolName ||
          sibling.replacementKey !== input.replacementKey
        )
          continue;
        await adapter.supersedeActionProposal(input, sibling.id, {
          replacementProposalId: input.id,
          actorRef: input.actorRef,
          via: 'system/replacement',
        });
      }
      return created;
    });
  }

  async supersedeActionProposal(
    scope: ActionProposalScope,
    id: string,
    command: { replacementProposalId: string; actorRef: string; via: string },
  ): Promise<ActionProposalMutationResult> {
    const replacement = await this.getActionProposal(scope, command.replacementProposalId);
    if (!replacement) return { status: 'not_found' };
    return this.mutate(scope, id, (proposal, now) =>
      transitionActionProposalSupersession(proposal, replacement, command, now),
    );
  }

  protected async rememberedActionProposalTools(scope: ActionProposalScope): Promise<string[]> {
    await this.ensureProposalSchema();
    const rows = await this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('scope_key', scopeKey(scope))
      .where('decision', 'approved')
      .whereIn('execution_status', ['succeeded', 'failed'])
      .select('payload');
    return rows
      .map(read)
      .filter(
        (proposal) =>
          actionProposalScopeMatches(proposal, scope) &&
          proposal.decision === 'approved' &&
          (proposal.execution?.status === 'succeeded' || proposal.execution?.status === 'failed') &&
          proposal.decisionAudit?.remember === true,
      )
      .map((proposal) => proposal.toolName);
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
    const filters = ['"scope_key" = ?'];
    const bindings: unknown[] = [scopeKey(scope)];
    if (query.decision !== undefined) {
      filters.push('"decision" = ?');
      bindings.push(query.decision);
    }
    if (query.after !== undefined) {
      filters.push('("created_at" > ? OR ("created_at" = ? AND "logical_sort" > ?))');
      bindings.push(query.after.createdAt, query.after.createdAt, logicalSort(query.after.id));
    }
    bindings.push(limit);
    const rows = rowsOf(
      await this.proposalDb.rawQuery(
        forDialect(
          `SELECT * FROM "${AGENT_TABLES.actionProposals}" WHERE ${filters.join(' AND ')} ORDER BY "created_at" ASC, "logical_sort" ASC LIMIT ?`,
          isMySql(this.proposalDb),
        ),
        bindings,
      ),
    );
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
          ...discoveryMetadata(result.proposal),
          version: Number(row.version) + 1,
          updated_at: result.proposal.updatedAt,
        });
      if (affected(changed) > 0) return result;
    }
    const proposal = await this.getActionProposal(scope, id);
    return proposal ? { status: 'conflict', proposal } : { status: 'not_found' };
  }

  async getThreadActionProposalScope(threadId: string) {
    await this.ensureProposalSchema();
    const row = await this.proposalDb
      .from(AGENT_TABLES.threads)
      .where('id', threadId)
      .whereNull('deleted_at')
      .first();
    return row && row.id === threadId
      ? {
          threadId,
          actorRef: String(row.actor_ref),
          tenantRef: row.tenant_ref == null ? null : String(row.tenant_ref),
        }
      : null;
  }

  async claimNextActionProposalOutcome(command: { workerId: string; leaseMs: number }) {
    const now = this.proposalClock();
    validateActionProposalWorkerClaim(command, now);
    await this.ensureProposalSchema();
    const rows = rowsOf(
      await this.proposalDb.rawQuery(
        forDialect(
          `SELECT * FROM "${AGENT_TABLES.actionProposals}" WHERE "delivery_status" = 'pending' AND ("delivery_lease_expires_at" IS NULL OR "delivery_lease_expires_at" <= ?) ORDER BY "created_at" ASC, "logical_sort" ASC LIMIT 32`,
          isMySql(this.proposalDb),
        ),
        [now],
      ),
    );
    for (const row of rows) {
      const proposal = read(row);
      const result = await this.mutate(proposal, proposal.id, (current, time) => {
        const next = claimActionProposalOutcome(current, command, time, randomUUID());
        return next
          ? { status: 'applied', proposal: next }
          : { status: 'conflict', proposal: current };
      });
      const next = result.proposal;
      if (result.status === 'applied' && next?.outcome && next.outcomeDelivery?.lease)
        return {
          outcome: next.outcome,
          lease: {
            outcomeId: next.outcome.id,
            token: next.outcomeDelivery.lease.token,
            generation: next.outcomeDelivery.generation,
          },
        };
    }
    return null;
  }

  async admitActionProposalOutcome(
    command: ActionProposalOutcomeLease,
  ): ReturnType<ActionProposalOutcomeStore['admitActionProposalOutcome']> {
    // Validate malformed privileged commands even when the outcome does not exist.
    actionProposalOutcomeFenceValid({} as ActionProposal, command, this.proposalClock());
    await this.ensureProposalSchema();
    const observed = await this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('outcome_key', key(command.outcomeId))
      .first();
    if (!observed) return { status: 'not_found' };
    const observedProposal = read(observed);
    return withStoreTransaction(this.proposalDb, async (client) => {
      const tx = client as LucidDatabaseLike;
      const sql = (statement: string) => forDialect(statement, isMySql(this.proposalDb));
      // This write starts SQLite's reserved writer lock before reading a transaction snapshot;
      // on PostgreSQL/MySQL the same update locks the real admission row used by user sends.
      await tx.rawQuery(
        sql(`UPDATE "${AGENT_TABLES.threads}" SET "updated_at" = "updated_at" WHERE "id" = ?`),
        [observedProposal.threadId],
      );
      const row = await tx
        .from(AGENT_TABLES.actionProposals)
        .where('id', observed.id)
        .where('scope_key', observed.scope_key)
        .first();
      if (!row) return { status: 'not_found' };
      const proposal = read(row);
      if (proposal.outcome?.id !== command.outcomeId) return { status: 'not_found' };
      if (proposal.outcomeDelivery?.status === 'admitted')
        return {
          status: 'unchanged',
          ...(proposal.outcomeDelivery.messageId !== undefined
            ? { messageId: proposal.outcomeDelivery.messageId }
            : {}),
        };
      if (proposal.outcomeDelivery?.status === 'discarded') return { status: 'discarded' };
      const now = this.proposalClock();
      if (!actionProposalOutcomeFenceValid(proposal, command, now)) return { status: 'conflict' };
      const thread = await tx.from(AGENT_TABLES.threads).where('id', proposal.threadId).first();
      const discarded =
        !thread ||
        thread.id !== proposal.threadId ||
        thread.deleted_at != null ||
        thread.actor_ref !== proposal.actorRef ||
        (thread.tenant_ref ?? null) !== proposal.tenantRef;
      if (!discarded && thread.active_stream_id != null) return { status: 'busy' };
      const messageId = key(['action-proposal-outcome', command.outcomeId]);
      const next = {
        ...proposal,
        outcomeDelivery: {
          ...proposal.outcomeDelivery!,
          status: discarded ? ('discarded' as const) : ('admitted' as const),
          lease: null,
          ...(discarded ? {} : { messageId }),
        },
      };
      if (!discarded) {
        const sequence = rowsOf(
          await tx.rawQuery(
            sql(
              `SELECT MAX("seq") AS "maximum" FROM "${AGENT_TABLES.messages}" WHERE "thread_id" = ?`,
            ),
            [proposal.threadId],
          ),
        )[0];
        // Store JSON metadata in escaped TEXT; native UI columns remain empty on these facts.
        await tx.table(AGENT_TABLES.messages).insert({
          id: messageId,
          thread_id: proposal.threadId,
          seq: Number(sequence?.maximum ?? 0) + 1,
          role: 'assistant',
          content: actionProposalOutcomeText(proposal.outcome),
          action_proposal_outcome: canonicalActionProposalJson(proposal.outcome),
          created_at: now,
        });
      }
      const changed = await tx
        .from(AGENT_TABLES.actionProposals)
        .where('id', row.id)
        .where('scope_key', row.scope_key)
        .where('version', row.version)
        .update({
          payload: canonicalActionProposalJson(next),
          ...discoveryMetadata(next),
          version: Number(row.version) + 1,
        });
      if (affected(changed) !== 1) throw new Error('Outcome admission lost its version fence');
      if (!discarded)
        await tx
          .from(AGENT_TABLES.threads)
          .where('id', proposal.threadId)
          .update({ updated_at: now });
      return discarded ? { status: 'discarded' } : { status: 'applied', messageId };
    });
  }

  async claimNextActionProposal(command: ClaimActionProposal): Promise<ActionProposal | null> {
    const now = this.proposalClock();
    validateActionProposalWorkerClaim(command, now);
    await this.ensureProposalSchema();
    const rows = rowsOf(
      await this.proposalDb.rawQuery(
        forDialect(
          `SELECT * FROM "${AGENT_TABLES.actionProposals}" WHERE "discovery_index_version" = 1 AND "decision" = 'approved' AND ("execution_status" = 'queued' OR ("execution_status" = 'executing' AND "lease_expires_at" <= ?)) ORDER BY "created_at" ASC, "logical_sort" ASC LIMIT 32`,
          isMySql(this.proposalDb),
        ),
        [now],
      ),
    );
    for (const row of rows) {
      const proposal = read(row);
      const result = await this.claimActionProposal(proposal, proposal.id, command);
      if (result.status === 'applied') return result.proposal ?? null;
    }
    return null;
  }

  async expireActionProposals(command: { limit: number }): Promise<number> {
    const now = this.proposalClock();
    validateActionProposalExpiryBatch(command, now);
    await this.ensureProposalSchema();
    const rows = rowsOf(
      await this.proposalDb.rawQuery(
        forDialect(
          `SELECT * FROM "${AGENT_TABLES.actionProposals}" WHERE "discovery_index_version" = 1 AND "decision" = 'pending' AND "proposal_expires_at" <= ? ORDER BY "created_at" ASC, "logical_sort" ASC LIMIT ?`,
          isMySql(this.proposalDb),
        ),
        [now, command.limit],
      ),
    );
    let changed = 0;
    for (const row of rows) {
      const proposal = read(row);
      const result = await this.decideActionProposal(proposal, proposal.id, {
        decision: 'expired',
        actorRef: 'system',
        via: 'expiry',
      });
      if (result.status === 'applied') changed++;
    }
    return changed;
  }

  async backfillActionProposalDiscoveryIndex(command: { limit: number }): Promise<number> {
    validateActionProposalDiscoveryIndexBatch(command);
    await this.ensureProposalSchema();
    const rows = await this.proposalDb
      .from(AGENT_TABLES.actionProposals)
      .where('discovery_index_version', 0)
      .orderBy('created_at', 'asc')
      .orderBy('logical_sort', 'asc')
      .limit(command.limit)
      .select('*');
    let changed = 0;
    for (const row of rows) {
      const proposal = read(row);
      const result = await this.proposalDb
        .from(AGENT_TABLES.actionProposals)
        .where('id', row.id)
        .where('scope_key', row.scope_key)
        .where('version', row.version)
        .where('discovery_index_version', 0)
        .update({ ...discoveryMetadata(proposal), version: Number(row.version) + 1 });
      if (affected(result) > 0) changed++;
    }
    return changed;
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
