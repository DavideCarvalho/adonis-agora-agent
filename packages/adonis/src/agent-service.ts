import { utcDay } from './agent-deps.js';
import type { AgentDepsFactory } from './agent-deps-factory.js';
import { readElicitationQuestions, validateElicitationAnswer } from './elicitation-input.js';
import type { AgentRunner } from './spi/agent-runner.js';
import type { AgentStore } from './spi/agent-store.js';
import {
  type ApprovalDecisionRef,
  mayDecideApproval,
  type ToolCallApprovalState,
} from './spi/approval-policy.js';
import type { AttachmentRef, AttachmentStagingStore } from './spi/attachment-staging.js';
import {
  findCatalogModel,
  type ModelCatalog,
  type ModelCatalogView,
  ModelNotAllowedError,
} from './spi/model-catalog.js';
import { QuotaBlockedError, type QuotaProvider, type QuotaReport } from './spi/quota-provider.js';
import type { StreamFrame } from './spi/token-stream-sink.js';
import type { ToolCatalogEntry } from './tool-presentation.js';
import type {
  Actor,
  AgentRunInput,
  MessageAttachment,
  MessageFeedback,
  PageContext,
  Persona,
  ThreadDetail,
  ThreadSummary,
} from './types.js';

/** A feedback comment is stored with the message — bounded like any other stored text. */
const MAX_FEEDBACK_COMMENT_LENGTH = 2000;

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  personaId?: string;
  pageContext?: PageContext;
  /**
   * Uploads to attach to this message, named by id (`POST <path>/attachments` answered it). The
   * configured attachment store resolves each — the url the model fetches is never taken from here.
   */
  attachments?: AttachmentRef[];
  /**
   * Run this turn on a catalog model instead of the thread's pinned one (or the provider default).
   * Refused ({@link ModelNotAllowedError}) unless the catalog lists it as available to this actor.
   */
  model?: string;
}

/**
 * The framework-agnostic orchestration facade the `/agent` routes call: start a run, subscribe to
 * its live token stream, deliver HITL decisions, and read/mutate threads. It owns no HTTP — the
 * provider's route handlers resolve the actor and pipe the SSE, then delegate here.
 */
/** What the service needs beyond the runner, store and deps — all optional. */
export interface AgentServiceOptions {
  /** Which models a caller may pick. Omitted → an empty catalog; naming a model is refused. */
  models?: ModelCatalog;
  /**
   * The budget report behind `GET <path>/quota` and, when `gated`, the send gate. Omitted → a day
   * window from the ledger, never gated.
   */
  quota?: { provider: QuotaProvider; gated: boolean };
  /** Where attachments live (`attachments` in `config/agent.ts`). Absent → a send naming one is refused. */
  attachments?: AttachmentStagingStore;
}

/** A send's attachments were refused — `status` is what the chat route answers (`403`, `501`). */
export class AttachmentRefusedError extends Error {
  constructor(
    readonly status: 400 | 403 | 501,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentRefusedError';
  }
}

export class AgentService {
  constructor(
    private readonly runner: AgentRunner,
    private readonly store: AgentStore,
    private readonly deps: AgentDepsFactory,
    private readonly options: AgentServiceOptions = {},
  ) {}

  /**
   * The models `actor` may pick for `agent` (`GET <path>/models`). An empty catalog when none is
   * configured, so a picker simply has nothing to offer.
   */
  /** Is a model catalog configured (so `GET <path>/models` lists something)? */
  hasModelCatalog(): boolean {
    return this.options.models !== undefined;
  }

  async listModels(actor: Actor, agent?: string): Promise<ModelCatalogView> {
    if (this.options.models === undefined) {
      return { providers: [], default: null };
    }
    return this.options.models.list({ actor, ...(agent !== undefined ? { agent } : {}) });
  }

  /**
   * `model` if the catalog offers it to this actor and agent right now, else a
   * {@link ModelNotAllowedError} naming why. The one gate every model choice passes — a send's own,
   * and a thread's pinned one when it is pinned and again at every turn that runs on it.
   */
  async assertModelAllowed(actor: Actor, agent: string, model: string): Promise<string> {
    if (this.options.models === undefined) {
      throw new ModelNotAllowedError(
        `model "${model}" cannot be selected: no model catalog is configured (models in config/agent.ts)`,
      );
    }
    const entry = findCatalogModel(await this.options.models.list({ actor, agent }), model);
    if (entry === undefined) {
      throw new ModelNotAllowedError(`model "${model}" is not offered`);
    }
    if (!entry.available) {
      throw new ModelNotAllowedError(
        `model "${model}" is not available${entry.unavailableReason ? `: ${entry.unavailableReason}` : ''}`,
      );
    }
    return entry.id;
  }

  /** The model a turn runs on: the send's own, else the thread's pinned one, else none. */
  private async resolveModel(
    actor: Actor,
    agent: string,
    requested: string | undefined,
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const pinned =
      requested === undefined && threadId !== undefined
        ? ((await this.store.getThread(threadId))?.model ?? null)
        : null;
    const model = requested ?? pinned;
    return model === null || model === undefined
      ? undefined
      : this.assertModelAllowed(actor, agent, model);
  }

  /**
   * Pin (or with `null`, unpin) a catalog model on a thread — checked against the catalog for the
   * thread's default agent. `false` when the store cannot persist it (no `updateThread`).
   */
  async setThreadModel(actor: Actor, threadId: string, model: string | null): Promise<boolean> {
    if (this.store.updateThread === undefined) {
      return false;
    }
    const pinned =
      model === null
        ? null
        : await this.assertModelAllowed(actor, this.deps.defaultAgentName(), model);
    await this.store.updateThread(threadId, { model: pinned });
    return true;
  }

  /** The registered agents, for a picker (`GET <path>/agents`). */
  listAgents(): { name: string; description: string; isDefault?: true }[] {
    const defaultName = this.deps.defaultAgentName();
    const listed = this.deps.agentDefinitions();
    const entries = listed.map((definition) => ({
      name: definition.name,
      description: definition.description ?? '',
      ...(definition.name === defaultName ? { isDefault: true as const } : {}),
    }));
    return entries.some((entry) => entry.name === defaultName)
      ? entries
      : [{ name: defaultName, description: '', isDefault: true as const }, ...entries];
  }

  /** The actor's budget across windows (`GET <path>/quota`). */
  async quotaReport(actor: Actor): Promise<QuotaReport> {
    if (this.options.quota !== undefined) {
      return this.options.quota.provider.report({ actor });
    }
    const today = await this.quotaToday(actor.id);
    return { windows: [{ period: 'day', usedTokens: today.usedTokens, usedUsd: 0 }] };
  }

  /**
   * Refuse a turn the actor's budget no longer covers — only when a budget was configured
   * (`quota: { limits }` or a `QuotaProvider`): the default report is informational.
   */
  private async assertWithinQuota(actor: Actor): Promise<void> {
    if (this.options.quota?.gated !== true) {
      return;
    }
    const { blocked } = await this.options.quota.provider.report({ actor });
    if (blocked !== undefined) {
      throw new QuotaBlockedError(
        blocked.period,
        blocked.reason ?? `The ${blocked.period === 'day' ? 'daily' : 'monthly'} quota is used up`,
      );
    }
  }

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    await this.assertWithinQuota(params.actor);
    const agentName = params.agentName ?? this.deps.defaultAgentName();
    // Before the thread exists, so a refused model or attachment leaves nothing behind.
    const model = await this.resolveModel(params.actor, agentName, params.model, params.threadId);
    const attachments = await this.resolveAttachments(params.actor, params.attachments ?? []);
    let threadId = params.threadId;
    if (threadId === undefined) {
      const created = await this.store.createThread({
        actor: params.actor,
        persona: params.personaId ?? this.deps.forAgent(agentName).defaultPersona,
      });
      threadId = created.id;
    }

    const persona = this.resolvePersona(agentName, params.personaId);
    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
      ...(persona !== undefined ? { persona } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(model !== undefined ? { model } : {}),
    };

    // The runner marks the thread's active run itself, before the turn can end.
    const { runId } = await this.runner.start(input);
    return { runId, threadId };
  }

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    return this.deps.forAgent().sink.subscribe(runId);
  }

  /**
   * Rate a message: `'up'`/`'down'` with an optional comment, or `null` to clear the rating. Checks
   * nothing about WHO — the route resolves the message's thread (`threadOfMessage`) and its owner
   * first. Returns the stored rating, or an error the route maps to a status.
   */
  async setMessageFeedback(
    messageId: string,
    input: { value: unknown; comment?: unknown },
  ): Promise<
    { ok: true; feedback: MessageFeedback | null } | { ok: false; status: 400 | 501; error: string }
  > {
    const { value } = input;
    if (value !== null && value !== 'up' && value !== 'down') {
      return { ok: false, status: 400, error: "value must be 'up', 'down' or null" };
    }
    if (input.comment !== undefined && typeof input.comment !== 'string') {
      return { ok: false, status: 400, error: 'comment must be a string' };
    }
    const comment = (input.comment as string | undefined)?.trim();
    if (comment !== undefined && comment.length > MAX_FEEDBACK_COMMENT_LENGTH) {
      return {
        ok: false,
        status: 400,
        error: `comment must be at most ${MAX_FEEDBACK_COMMENT_LENGTH} characters`,
      };
    }
    if (this.store.setMessageFeedback === undefined) {
      return {
        ok: false,
        status: 501,
        error:
          'Message feedback requires an AgentStore that implements threadOfMessage() and setMessageFeedback().',
      };
    }
    const feedback: MessageFeedback | null =
      value === null
        ? null
        : {
            value,
            ...(comment !== undefined && comment.length > 0 ? { comment } : {}),
            updatedAt: new Date().toISOString(),
          };
    await this.store.setMessageFeedback(messageId, feedback);
    return { ok: true, feedback };
  }

  /** The thread a message belongs to (`AgentStore.threadOfMessage`); `undefined` when unsupported. */
  async threadOfMessage(messageId: string): Promise<string | null | undefined> {
    return this.store.threadOfMessage === undefined
      ? undefined
      : this.store.threadOfMessage(messageId);
  }

  /** Is anything streaming (or buffered) under this run? `true` when the sink cannot say. */
  async hasStream(runId: string): Promise<boolean> {
    return (await this.deps.forAgent().sink.has?.(runId)) ?? true;
  }

  /** The owning actor ref of a run (turn), or `null` if unknown — for per-actor route ownership checks. */
  runOwner(runId: string): Promise<string | null> {
    return this.store.getRunActorRef(runId);
  }

  /** The owning actor ref of a thread, or `null` if unknown — for per-actor route ownership checks. */
  /** The run a tool call belongs to (see `AgentStore.getToolCallRunId`); `null` when unknown. */
  async toolCallRun(toolCallId: string): Promise<string | null> {
    return (await this.store.getToolCallRunId?.(toolCallId)) ?? null;
  }

  threadOwner(threadId: string): Promise<string | null> {
    return this.store.getThreadActorRef(threadId);
  }

  /**
   * Approve a parked action call. `executedByRef` is who decided (the routes stamp the caller);
   * `remember` approves later calls of the same tool in the same thread; `via` names the surface the
   * decision came through (`'web'`, `'slack'`, …) — all persisted with the call.
   */
  approve(
    runId: string,
    toolCallId: string,
    opts: { executedByRef?: string; remember?: boolean; via?: string } = {},
  ): Promise<void> {
    return this.runner.signal(runId, toolCallId, {
      approved: true,
      ...(opts.executedByRef !== undefined ? { executedByRef: opts.executedByRef } : {}),
      ...(opts.remember === true ? { remember: true } : {}),
      ...(opts.via !== undefined ? { decidedVia: opts.via } : {}),
    });
  }

  reject(
    runId: string,
    toolCallId: string,
    reason?: string,
    opts: { executedByRef?: string; via?: string } = {},
  ): Promise<void> {
    return this.runner.signal(runId, toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
      ...(opts.executedByRef !== undefined ? { executedByRef: opts.executedByRef } : {}),
      ...(opts.via !== undefined ? { decidedVia: opts.via } : {}),
    });
  }

  /** A call's approval state (see `AgentStore.toolCallApproval`); `null` when unknown or unrecorded. */
  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    return (await this.store.toolCallApproval?.(toolCallId)) ?? null;
  }

  /**
   * May `actor` settle a call whose recorded approver is `approver` (never the requester — that is
   * the ownership check)? The configured policy's `canDecide`, else "holds that role".
   */
  mayDecide(actor: Actor, decision: ApprovalDecisionRef): Promise<boolean> {
    return mayDecideApproval(this.deps.forAgent().approvalPolicy, actor, decision);
  }

  /**
   * Deliver a human's answers to a parked question set. An id the reply omits takes that question's
   * own pre-picked default, resolved by the loop against the request it already holds — so "just
   * pressed enter" and "picked exactly the defaults" persist identically, and a client that never
   * rendered the defaults cannot submit a blank.
   *
   * Addressed at a tool call that is in fact waiting for an approve/reject, this is refused: see
   * {@link import('./elicitation.js').HumanReplyMismatchError}. Answers say nothing about whether
   * proposed work should go ahead, and the alternative is a rejection nobody made.
   */
  /**
   * Check a reply against the questions it answers before it is signalled: every submitted value a
   * question's own rules accept (a typed input's type, bounds and pattern; a pick from the offered
   * options), and every `required` question answered — by the reply, or by the defaults an omitted
   * question falls back to. Returns the first problem as `answers["<id>"] <reason>`, or `null`.
   * Needs the store's `toolCallInput`; without it the loop's own filtering is the only check.
   */
  async answerProblem(
    toolCallId: string,
    answers: Record<string, string[]>,
  ): Promise<string | null> {
    if (this.store.toolCallInput === undefined) {
      return null;
    }
    const questions = readElicitationQuestions(await this.store.toolCallInput(toolCallId));
    for (const question of questions) {
      const submitted = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
      const problem = validateElicitationAnswer(question, submitted ?? question.defaults ?? []);
      if (problem !== null) {
        return `answers["${question.id}"] ${problem}`;
      }
    }
    return null;
  }

  answer(args: {
    runId: string;
    toolCallId: string;
    answers: Record<string, string[]>;
    answeredByRef?: string;
  }): Promise<void> {
    return this.runner.signal(args.runId, args.toolCallId, {
      answers: args.answers,
      ...(args.answeredByRef !== undefined ? { answeredByRef: args.answeredByRef } : {}),
    });
  }

  /**
   * The user declined to answer and told the agent to proceed on its own assumptions. It lands on
   * the same values a confirmation would and persists as `rejected` rather than `executed`, because
   * proceeding on an assumption someone declined to confirm is a different fact from proceeding on
   * one they chose.
   */
  skip(args: { runId: string; toolCallId: string; answeredByRef?: string }): Promise<void> {
    return this.runner.signal(args.runId, args.toolCallId, {
      answers: {},
      skipped: true,
      ...(args.answeredByRef !== undefined ? { answeredByRef: args.answeredByRef } : {}),
    });
  }

  cancel(runId: string): Promise<void> {
    return this.runner.cancel(runId);
  }

  /**
   * The tools THIS actor can reach through an agent, with how a chat surface talks about each —
   * the same list the model is offered (`ToolRegistry.visibleSpecs` behind `definitionsFor`, against
   * the agent's allow-list and the roles policy). Built-in tools the loop serves itself (`ask`,
   * `skill`, `remember`) are not registry tools and are not listed.
   */
  async toolCatalog(actor: Actor, agentName?: string): Promise<ToolCatalogEntry[]> {
    const deps = this.deps.forAgent(agentName);
    const specs = await deps.registry.visibleSpecs(actor, deps.rolesPolicy, deps.toolAllowList);
    return specs.map((spec) => ({
      name: spec.name,
      kind: spec.kind,
      ...(spec.presentation !== undefined ? { presentation: spec.presentation } : {}),
    }));
  }

  resolvePersona(agentName?: string, id?: string): Persona | undefined {
    const deps = this.deps.forAgent(agentName);
    return deps.personas.get(id ?? deps.defaultPersona);
  }

  personaCatalog(agentName?: string): { id: string; label: string }[] {
    return [...this.deps.forAgent(agentName).personas.values()].map((persona) => ({
      id: persona.id,
      label: persona.label,
    }));
  }

  listThreads(actorRef: string): Promise<ThreadSummary[]> {
    return this.store.listThreads(actorRef);
  }

  /**
   * A thread as `actor` reads it back. Each attachment's url is re-minted by `mediaId` through the
   * attachment store: the one persisted with the message was minted for THAT turn (a signed url that
   * expires), so an old turn would otherwise show a dead link. One the store will not resolve for
   * this actor keeps the url it was stored with.
   */
  async getThread(threadId: string, actor?: Actor): Promise<ThreadDetail | null> {
    const thread = await this.store.getThread(threadId);
    const staging = this.options.attachments;
    if (thread === null || actor === undefined || staging === undefined) return thread;
    if (!thread.messages.some((message) => (message.attachments?.length ?? 0) > 0)) return thread;
    const messages = await Promise.all(
      thread.messages.map(async (message) => {
        if (message.attachments === undefined || message.attachments.length === 0) return message;
        const attachments = await Promise.all(
          message.attachments.map(async (attachment) => {
            try {
              return (await staging.resolve({ mediaId: attachment.mediaId, actor })) ?? attachment;
            } catch {
              return attachment;
            }
          }),
        );
        return { ...message, attachments };
      }),
    );
    return { ...thread, messages };
  }

  /**
   * Turn a send's `{ mediaId }` refs into attachments through the store, for this actor. Refused
   * ({@link AttachmentRefusedError}) when no store is configured or one ref is not the actor's to use.
   */
  private async resolveAttachments(
    actor: Actor,
    refs: readonly AttachmentRef[],
  ): Promise<MessageAttachment[]> {
    if (refs.length === 0) return [];
    const staging = this.options.attachments;
    if (staging === undefined) {
      throw new AttachmentRefusedError(
        501,
        'Attachments are off: set `attachments` in config/agent.ts (e.g. attachmentStores.media()).',
      );
    }
    const resolved: MessageAttachment[] = [];
    for (const ref of refs) {
      const attachment = await staging.resolve({ mediaId: ref.mediaId, actor });
      if (attachment === null) {
        throw new AttachmentRefusedError(
          403,
          `attachment ${ref.mediaId} is not available to this actor`,
        );
      }
      resolved.push(attachment);
    }
    return resolved;
  }

  renameThread(threadId: string, title: string): Promise<void> {
    return this.store.setTitle(threadId, title);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.store.softDeleteThread(threadId);
  }

  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    return this.store.forkThread(threadId, fromMessageId);
  }

  async quotaToday(actorRef: string): Promise<{ usedTokens: number }> {
    return this.store.quotaToday(actorRef, utcDay());
  }
}
