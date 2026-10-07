import {
  DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES,
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  parseTextActionProposalCommand,
  resolveTextActionProposalDecision,
  type TextActionProposalConfig,
  type TextActionProposalReplies,
  type TextActionProposalVocabulary,
  textActionProposalReply,
} from './action-proposal-text.js';
import { validateActionProposalListQuery } from './action-proposal-transitions.js';
import type {
  ActionProposalScope,
  ActionProposalStore,
  ListActionProposals,
} from './spi/action-proposal-store.js';
import { type ApprovalPolicy, mayDecideApproval } from './spi/approval-policy.js';
import type { Actor } from './types.js';

export interface ActionProposalScopeStore {
  getThreadActionProposalScope(threadId: string): Promise<ActionProposalScope | null>;
}
export class ActionProposalServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 501,
    message: string,
  ) {
    super(message);
  }
}

/** Authenticated decisions live independently of the origin runner and its signals. */
export class ActionProposalService {
  private readonly vocabulary: TextActionProposalVocabulary;
  private readonly replies: TextActionProposalReplies;
  constructor(
    private readonly store: ActionProposalStore & ActionProposalScopeStore,
    private readonly policy?: ApprovalPolicy,
    text: TextActionProposalConfig = {},
  ) {
    this.vocabulary = { ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY, ...text.vocabulary };
    this.replies = { ...DEFAULT_TEXT_ACTION_PROPOSAL_REPLIES, ...text.replies };
  }
  private async scope(actor: Actor, threadId: string) {
    const scope = await this.store.getThreadActionProposalScope(threadId);
    if (!scope) throw new ActionProposalServiceError(404, 'Unknown thread');
    if ((actor.tenantRef ?? null) !== scope.tenantRef)
      throw new ActionProposalServiceError(403, 'Forbidden tenant');
    return scope;
  }
  async list(actor: Actor, threadId: string, after?: ListActionProposals['after']) {
    return (await this.listPage(actor, threadId, after)).items;
  }
  async listPage(actor: Actor, threadId: string, after?: ListActionProposals['after']) {
    const scope = await this.scope(actor, threadId);
    const query = { limit: 1000, ...(after !== undefined ? { after } : {}) };
    validateActionProposalListQuery(query);
    const raw = await this.store.listActionProposals(scope, query);
    const last = raw.at(-1);
    const next =
      raw.length === 1000 && last ? { createdAt: last.createdAt, id: last.id } : undefined;
    const permitted =
      actor.id === scope.actorRef
        ? raw
        : (
            await Promise.all(
              raw.map(async (proposal) =>
                (await this.canDecide(actor, proposal)) ? proposal : null,
              ),
            )
          ).filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null);
    return { items: permitted, ...(next !== undefined ? { next } : {}) };
  }
  async handleTextDecision(actor: Actor, threadId: string, text: string) {
    const command = parseTextActionProposalCommand(text, this.vocabulary);
    if (command.status === 'unmatched') return command;
    if (command.proposalId !== undefined) {
      // An `#ID` naming no proposal of this thread is an ordinary message, not a failed decision —
      // the same answer the candidate resolver gives.
      const scope = await this.scope(actor, threadId);
      if (!(await this.store.getActionProposal(scope, command.proposalId)))
        return { status: 'unmatched' as const };
      const result = await this.decide(
        actor,
        threadId,
        command.proposalId,
        command.decision,
        { remember: command.remember },
        'text',
      );
      return {
        threadId,
        proposalDecision: result,
        text: this.decisionText(result, command.decision),
      };
    }
    const scope = await this.scope(actor, threadId);
    const visible = await this.store.listActionProposals(scope, {
      decision: 'pending',
      limit: 1000,
    });
    const permitted = await Promise.all(
      visible.map(async (proposal) => ((await this.canDecide(actor, proposal)) ? proposal : null)),
    );
    const resolution = resolveTextActionProposalDecision(
      text,
      permitted.filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null),
      this.vocabulary,
    );
    if (resolution.status === 'unmatched') return resolution;
    if (visible.length === 1000 && resolution.status === 'decision' && !text.includes('#'))
      return {
        threadId,
        proposalDecision: {
          status: 'ambiguous' as const,
          proposalIds: permitted
            .filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null)
            .map((proposal) => proposal.id),
        },
        text: this.replies.tooMany,
      };
    if (resolution.status === 'ambiguous')
      return {
        threadId,
        proposalDecision: resolution,
        text: this.replies.ambiguous(resolution.proposalIds),
      };
    const result = await this.decide(
      actor,
      threadId,
      resolution.proposalId,
      resolution.decision,
      { remember: resolution.remember },
      'text',
    );
    return {
      threadId,
      proposalDecision: result,
      text: this.decisionText(result, resolution.decision),
    };
  }
  private decisionText(
    result: import('./spi/action-proposal-store.js').ActionProposalMutationResult,
    decision: 'approved' | 'rejected',
  ) {
    return textActionProposalReply(result, decision, this.replies);
  }
  private canDecide(
    actor: Actor,
    proposal: import('./spi/action-proposal-store.js').ActionProposal,
  ) {
    return mayDecideApproval(this.policy, actor, {
      toolCallId: proposal.originToolCallId,
      approver: proposal.approver,
      requesterRef: proposal.actorRef,
    });
  }
  async decide(
    actor: Actor,
    threadId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
    body: unknown,
    via = 'web',
  ) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ActionProposalServiceError(400, 'Invalid decision body');
    const fields = Object.keys(body);
    if (fields.some((field) => !['remember', 'reason'].includes(field)))
      throw new ActionProposalServiceError(400, 'Invalid decision fields');
    const { remember, reason } = body as { remember?: unknown; reason?: unknown };
    if (
      (remember !== undefined && typeof remember !== 'boolean') ||
      (reason !== undefined && typeof reason !== 'string')
    )
      throw new ActionProposalServiceError(400, 'Invalid decision values');
    const scope = await this.scope(actor, threadId);
    const proposal = await this.store.getActionProposal(scope, proposalId);
    if (!proposal) throw new ActionProposalServiceError(404, 'Unknown proposal');
    if (
      !(await mayDecideApproval(this.policy, actor, {
        toolCallId: proposal.originToolCallId,
        approver: proposal.approver,
        requesterRef: proposal.actorRef,
      }))
    )
      throw new ActionProposalServiceError(403, 'Forbidden decision');
    return this.store.decideActionProposal(scope, proposalId, {
      decision,
      actorRef: actor.id,
      via,
      ...(typeof remember === 'boolean' ? { remember } : {}),
      ...(typeof reason === 'string' ? { reason } : {}),
    });
  }
}
