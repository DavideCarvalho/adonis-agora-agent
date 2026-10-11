import type { AgentService, ChatParams } from '../agent-service.js';
import type { ActionProposalOutcome } from '../spi/action-proposal-outcome-store.js';
import type { Actor } from '../types.js';
import type { PoppyConnections } from './service.js';
import type { PoppyPendingConnect } from './store.js';

/**
 * A connect finished: decide the `connect` call the turn parked on, so the conversation resumes
 * with the account connected — a scoped proposal decision under `actionApprovalMode: 'independent'`,
 * an approval of the parked call otherwise. A call already decided (the person tapped first) is left.
 */
export async function resumeAfterConnect(
  service: Pick<
    AgentService,
    | 'actionApprovalMode'
    | 'listActionProposals'
    | 'decideActionProposal'
    | 'approve'
    | 'toolCallApproval'
  > &
    Partial<Pick<AgentService, 'send'>>,
  pending: PoppyPendingConnect,
  /**
   * For a sign-in that finished after its card expired: the connection is stored all the same, and
   * the conversation is continued with a new turn ({@link PoppyConnectionsTexts.continueAfterConnect})
   * instead of nothing happening. Without it, an expired card is left alone.
   */
  late?: {
    connections: Pick<PoppyConnections, 'texts'>;
    follow?: (
      address: unknown,
      run: { runId: string; threadId: string; actor: Actor },
    ) => Promise<unknown>;
  },
): Promise<void> {
  if (!pending.actor || !pending.threadId || !pending.toolCallId) return;
  const actor = pending.actor as Actor;
  const threadId = pending.threadId;
  if (service.actionApprovalMode() === 'independent') {
    const proposals = (await service.listActionProposals(actor, threadId)) as unknown as {
      id: string;
      originToolCallId?: string;
      decision?: string;
      executionContext?: { agentName?: string; pageContext?: Record<string, unknown> };
    }[];
    const mine = proposals.filter((p) => p.originToolCallId === pending.toolCallId);
    const open = mine.find((p) => p.decision === 'pending');
    if (open) {
      const decided = await service
        .decideActionProposal(actor, threadId, open.id, 'approved', {}, 'poppy-connect')
        .then(
          (r) => (r as { status?: string }).status !== 'expired',
          () => false,
        );
      if (decided) return;
    }
    // Approved already (the person tapped first) or turned down: nothing to add.
    if (mine.some((p) => p.decision === 'approved' || p.decision === 'rejected')) return;
    // Expired (or gone) before the sign-in finished: the account is connected anyway — go on.
    await continueLate(service, late, actor, threadId, pending, mine[0]?.executionContext);
    return;
  }
  if (!pending.runId) return;
  const state = await service.toolCallApproval(pending.toolCallId);
  if (state === null || state.status === 'pending_approval') {
    await service.approve(pending.runId, pending.toolCallId, {
      executedByRef: actor.id,
      via: 'poppy-connect',
    });
    return;
  }
  if (state.status === 'expired') await continueLate(service, late, actor, threadId, pending);
}

async function continueLate(
  service: Partial<Pick<AgentService, 'send'>>,
  late: Parameters<typeof resumeAfterConnect>[2],
  actor: Actor,
  threadId: string,
  pending: PoppyPendingConnect,
  context?: { agentName?: string; pageContext?: Record<string, unknown> },
): Promise<void> {
  if (!late || !service.send) return;
  const sent = await service.send(
    {
      actor,
      threadId,
      message: late.connections.texts.continueAfterConnect.replace(
        /\{company\}/g,
        pending.organization,
      ),
      ...(context?.agentName !== undefined ? { agentName: context.agentName } : {}),
      ...(context?.pageContext !== undefined
        ? { pageContext: context.pageContext as NonNullable<ChatParams['pageContext']> }
        : {}),
    },
    { textDecisions: false },
  );
  const runId = (sent as { runId?: string }).runId;
  const address = context?.pageContext?.channel;
  if (runId !== undefined && late.follow && address !== null && typeof address === 'object') {
    await late.follow(address, { runId, threadId, actor });
  }
}

/**
 * Independent approvals: deciding the `connect` proposal runs it, and its outcome is written to the
 * thread — but nothing asks the model to go on. Once that outcome is admitted (the
 * action-proposal worker's `onAdmitted`), this starts the next turn on the thread, in the person's
 * voice ({@link PoppyConnectionsTexts.continueAfterConnect}), so the model proceeds with what was
 * asked before the sign-in. A text channel's conversation gets that turn too (`follow`).
 *
 * Only for a connect this app's connect page completed (its pending connect is `connected`), and
 * only once: the outcome is admitted once.
 */
export async function continueAfterConnect(
  service: Pick<AgentService, 'listActionProposals' | 'send'>,
  connections: Pick<PoppyConnections, 'pendingFor' | 'texts'>,
  outcome: ActionProposalOutcome,
  options: {
    prefix?: string;
    /** Deliver the new run to a text channel (`channels.follow`). */
    follow?: (
      address: unknown,
      run: { runId: string; threadId: string; actor: Actor },
    ) => Promise<unknown>;
  } = {},
): Promise<{ runId: string } | null> {
  if (outcome.toolName !== `${options.prefix ?? 'poppy_'}connect`) return null;
  if (outcome.executionStatus !== 'succeeded' || outcome.decision !== 'approved') return null;
  const result = outcome.result as { connected?: unknown; organization?: unknown } | undefined;
  if (result?.connected !== true) return null;
  const pending = await connections.pendingFor(outcome.originRunId, outcome.originToolCallId);
  if (pending === null || pending.status !== 'connected' || pending.actor === null) return null;
  const actor = pending.actor as Actor;
  const proposal = (
    (await service.listActionProposals(actor, outcome.threadId)) as unknown as {
      id: string;
      executionContext?: { agentName?: string; pageContext?: Record<string, unknown> };
    }[]
  ).find((p) => p.id === outcome.proposalId);
  const context = proposal?.executionContext;
  const company =
    typeof result.organization === 'string' ? result.organization : pending.organization;
  const sent = await service.send(
    {
      actor,
      threadId: outcome.threadId,
      message: connections.texts.continueAfterConnect.replace(/\{company\}/g, company),
      ...(context?.agentName !== undefined ? { agentName: context.agentName } : {}),
      ...(context?.pageContext !== undefined
        ? { pageContext: context.pageContext as NonNullable<ChatParams['pageContext']> }
        : {}),
    },
    { textDecisions: false },
  );
  const runId = (sent as { runId?: string }).runId;
  if (runId === undefined) return null;
  const address = context?.pageContext?.channel;
  if (options.follow && address !== null && typeof address === 'object') {
    await options.follow(address, { runId, threadId: outcome.threadId, actor });
  }
  return { runId };
}
