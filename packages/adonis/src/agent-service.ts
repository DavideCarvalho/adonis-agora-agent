import type { ActionApprovalMode } from './action-proposal-receipt.js';
import { assertIndependentActionRuntime } from './action-proposal-runtime.js';
import { ActionProposalService, ActionProposalServiceError } from './action-proposal-service.js';
import {
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  type TextActionProposalVocabulary,
  textActionProposalReply,
} from './action-proposal-text.js';
import { utcDay } from './agent-deps.js';
import type { AgentDepsFactory } from './agent-deps-factory.js';
import {
  type AttachmentLimits,
  DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from './attachment-limits.js';
import type { ChatQueueService } from './chat-queue-service.js';
import { RunNotActiveError, settleDeadRun } from './dead-run.js';
import { readElicitationQuestions, validateElicitationAnswer } from './elicitation-input.js';
import { personaCatalogEntry } from './personas.js';
import type { ActionProposalMutationResult } from './spi/action-proposal-store.js';
import type { AgentRunner } from './spi/agent-runner.js';
import type { AgentStore } from './spi/agent-store.js';
import {
  type ApprovalDecisionRef,
  mayDecideApproval,
  type ToolCallApprovalState,
} from './spi/approval-policy.js';
import type {
  AttachmentRef,
  AttachmentStagingStore,
  ListStagedAttachmentsInput,
  StagedAttachment,
} from './spi/attachment-staging.js';
import type { BackgroundActorResolver } from './spi/background-actor-resolver.js';
import type { ChatQueueState } from './spi/chat-queue.js';
import {
  findCatalogModel,
  type ModelCatalog,
  type ModelCatalogView,
  ModelNotAllowedError,
} from './spi/model-catalog.js';
import { QuotaBlockedError, type QuotaProvider, type QuotaReport } from './spi/quota-provider.js';
import type { StreamFrame } from './spi/token-stream-sink.js';
import { LucidAgentStore, type LucidDatabaseLike } from './stores/lucid.js';
import { threadPersona } from './thread-persona.js';
import type { ToolCatalogEntry } from './tool-presentation.js';
import type {
  Actor,
  AgentCatalogEntry,
  AgentHostContext,
  AgentRunInput,
  MessageAttachment,
  MessageFeedback,
  PageContext,
  Persona,
  PersonaCatalogEntry,
  ThreadDetail,
  ThreadSummary,
} from './types.js';
import type { UiCapabilities } from './ui-capabilities.js';
import { validateUiCapabilities } from './ui-capabilities.js';

/** A feedback comment is stored with the message — bounded like any other stored text. */
const MAX_FEEDBACK_COMMENT_LENGTH = 2000;

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  /**
   * Run this turn under one of the agent's personas, and pin it on the thread so later sends that
   * name none keep it. Refused ({@link PersonaNotFoundError}, `400 persona_not_found`) unless the
   * agent declares it. Omitted → the thread's pinned persona, else the agent's `defaultPersona`, else
   * none.
   */
  personaId?: string;
  pageContext?: PageContext;
  uiCapabilities?: UiCapabilities;
  /**
   * Uploads to attach to this message, named by id (`POST <path>/attachments` answered it). The
   * configured attachment store resolves each — the url the model fetches is never taken from here.
   */
  attachments?: AttachmentRef[];
  /**
   * Run THIS turn on a catalog model instead of the thread's pinned one (or the provider default).
   * Never stored on the thread — only `setThreadModel` (`PATCH <path>/threads/:id { model }`) pins.
   * Refused ({@link ModelNotAllowedError}) unless the catalog lists it as available to this actor.
   */
  model?: string;
  /**
   * Answer the thread's last user message again (the retry under the last answer): requires
   * `threadId` ({@link RegenerateNeedsThreadError}), ignores `message`, stores no user message, drops
   * the answer(s) after that user message and starts a new run.
   */
  regenerate?: boolean;
  /**
   * When creating a thread (no `threadId`), start it transient — a scratch conversation left out of
   * the thread list until {@link AgentService.promoteThread} keeps it. Ignored with a `threadId`.
   */
  transient?: boolean;
  /** What to do when the thread already has a turn running — see {@link ChatSendMode}. */
  mode?: ChatSendMode;
  /**
   * When creating a thread (no `threadId`), ask the store to create it under this id — the id an
   * AG-UI consumer named the conversation with. A store may ignore it (`CreateThreadInput.id`); the
   * thread's real id is always the one on the result.
   */
  newThreadId?: string;
  /**
   * The host's own facts about this send — where it came from, where its answer goes (see
   * `AgentRunInput.hostContext`). Carried to the turn as sent, through the queue when it waits there;
   * never shown to the model or to clients. Set by in-process callers, never from a request body.
   */
  hostContext?: AgentHostContext;
}

/**
 * What a send does when its thread already has a turn running:
 *  - `'auto'` (default) — run now when the thread is idle, else wait in the thread's queue.
 *  - `'queue'` — always wait in the queue, behind whatever is already waiting (it still starts at
 *    once when nothing is running and nothing is ahead of it).
 *  - `'interrupt'` — cancel the running turn and run this one next, ahead of the queue.
 */
export type ChatSendMode = 'auto' | 'queue' | 'interrupt';

/** A send that is waiting in its thread's queue instead of running. */
export interface QueuedSend {
  threadId: string;
  queued: true;
  /** The queued message's id — also the run id it will start under. */
  messageId: string;
  /** 0-based place in the queue at the time it was queued (`0` → next). */
  position: number;
  queue: ChatQueueState;
  /** The turn it started under, when it started straight away (an idle thread). */
  runId?: string;
  /** The run an interrupt cancelled to make room for it. */
  interrupting?: string;
}

/** What {@link AgentService.send} did: started a turn, or queued the message. */
export interface ProposalDecisionSend {
  threadId: string;
  proposalDecision: ActionProposalMutationResult | { status: 'ambiguous'; proposalIds: string[] };
  text: string;
  queued?: undefined;
  runId?: never;
}
export type ChatSendResult =
  | ProposalDecisionSend
  | { runId: string; threadId: string; queued?: undefined }
  | QueuedSend;

/**
 * A queue request the service refuses — `status` and `code` are what the routes answer:
 * `409 run_active` (a start-or-refuse {@link AgentService.chat}, or a regenerate, on a busy thread),
 * `410` (a queued message that already started or was removed), `404` (no such queued message),
 * `400` (a bad patch), `501` (the store cannot hold a queue).
 */
export class ChatQueueError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 501,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ChatQueueError';
  }
}

/** `regenerate: true` on a send without a `threadId` — there is no answer to regenerate. */
export class RegenerateNeedsThreadError extends Error {
  constructor() {
    super('regenerate requires an existing threadId');
    this.name = 'RegenerateNeedsThreadError';
  }
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
  /**
   * The thread message queue — the same instance the runner drains with. Absent (or over a store
   * that is not a `ChatQueueStore`) → a send on a busy thread starts a second, concurrent turn, as
   * before the queue existed.
   */
  queue?: ChatQueueService;
  actionProposals?: ActionProposalService;
  backgroundActorResolver?: BackgroundActorResolver;
}

/** A send's attachments were refused — `status` is what the chat route answers (`403`, `501`). */
/** A thread's `defaultAgent` named an agent this app does not register. */
export class UnknownAgentError extends Error {
  constructor(readonly agentName: string) {
    super(`unknown agent "${agentName}"`);
    this.name = 'UnknownAgentError';
  }
}

export class AttachmentRefusedError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415 | 501,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentRefusedError';
  }
}

/**
 * The staged-attachment inventory cannot be answered here — no attachment store, a store without
 * `list`, or an agent store without `referencedMediaIds`. `status` is what `GET <path>/attachments`
 * answers. Never answered with an empty list instead: "no inventory" and "no files" are opposite
 * facts, and a sweep that read the first as the second would delete files that are in use.
 */
export class AttachmentInventoryError extends Error {
  readonly status = 501 as const;
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInventoryError';
  }
}

export class AgentService {
  constructor(
    private readonly runner: AgentRunner,
    private readonly store: AgentStore,
    private readonly deps: AgentDepsFactory,
    private readonly options: AgentServiceOptions = {},
  ) {
    const mode =
      typeof deps.actionApprovalMode === 'function' ? deps.actionApprovalMode() : 'blocking';
    assertIndependentActionRuntime(
      mode,
      store,
      options.backgroundActorResolver,
      options.queue?.supported === true,
    );
    if (mode === 'independent' && !options.actionProposals)
      throw new Error('Independent action decision service is required');
  }

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

  /**
   * The model a turn runs on: the send's own (that turn only — never stored on the thread), else the
   * thread's pinned one, else none. An agent the catalog locks to one model runs on it whatever was
   * sent or pinned, and a send naming another model is refused.
   */
  private async resolveModel(
    actor: Actor,
    agent: string,
    requested: string | undefined,
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const locked =
      this.options.models !== undefined
        ? (await this.options.models.list({ actor, agent })).locked
        : undefined;
    if (locked !== undefined) {
      if (requested !== undefined && requested !== locked.model) {
        throw new ModelNotAllowedError(
          `model "${requested}" cannot be selected: ${locked.reason ?? `this agent always uses "${locked.model}"`}`,
        );
      }
      return locked.model;
    }
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
    return this.updateThreadSettings(actor, threadId, { model });
  }

  /**
   * Set a thread's default agent and/or pin its model (`PATCH <path>/threads/:id`). `null` clears
   * either. The model is checked against the catalog for the agent the thread's next turn runs as —
   * the one this patch sets, else the thread's own default, else the configured one. A
   * `defaultAgent` that names no registered agent is refused ({@link UnknownAgentError}). `false`
   * when the store cannot persist it (no `updateThread`). Ownership is the caller's to check.
   */
  async updateThreadSettings(
    actor: Actor,
    threadId: string,
    patch: { defaultAgent?: string | null; model?: string | null; persona?: string | null },
  ): Promise<boolean> {
    if (
      patch.defaultAgent === undefined &&
      patch.model === undefined &&
      patch.persona === undefined
    ) {
      return true;
    }
    if (this.store.updateThread === undefined) {
      return false;
    }
    if (typeof patch.defaultAgent === 'string' && !this.isKnownAgent(patch.defaultAgent)) {
      throw new UnknownAgentError(patch.defaultAgent);
    }
    // The agent the thread's next turn runs as — the one this patch sets, else the thread's own,
    // else the configured one; a name a persona took over counts as the agent that owns it.
    const nextAgent = async () =>
      this.deps.resolveAgent(
        patch.defaultAgent ?? (await this.resolveAgentName(undefined, threadId)),
      ).agentName;
    const model =
      patch.model === undefined || patch.model === null
        ? patch.model
        : await this.assertModelAllowed(actor, await nextAgent(), patch.model);
    // Validated against that same agent, like the model.
    if (typeof patch.persona === 'string') {
      this.deps.resolvePersona({ agentName: await nextAgent(), requested: patch.persona });
    }
    await this.store.updateThread(threadId, {
      ...(patch.defaultAgent !== undefined ? { defaultAgent: patch.defaultAgent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
    });
    return true;
  }

  /** A registered agent, or a name one of their personas took over (`Persona.aliases`). */
  private isKnownAgent(name: string): boolean {
    return this.deps.isAgent(name) || this.deps.resolveAgent(name).agentName !== name;
  }

  /**
   * The persona this send runs under — see {@link AgentDepsFactory.resolvePersona}. The thread's
   * pinned persona is read only when the send names none AND the agent has personas to pick from.
   */
  private async resolveSendPersona(
    agentName: string,
    requested: string | undefined,
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const needsThread =
      requested === undefined &&
      threadId !== undefined &&
      this.deps.personaCatalog(agentName).length > 0;
    return this.deps.resolvePersona({
      agentName,
      ...(requested !== undefined ? { requested } : {}),
      ...(needsThread ? { threadPersona: await threadPersona(this.store, threadId) } : {}),
    });
  }

  /** Pin `persona` on the thread when it is not already — a no-op on a store that cannot. */
  private async pinThreadPersona(threadId: string, persona: string): Promise<void> {
    if (this.store.updateThread === undefined) {
      return;
    }
    if ((await threadPersona(this.store, threadId)) !== persona) {
      await this.store.updateThread(threadId, { persona });
    }
  }

  /**
   * The agent a send runs as: the one it names, else the thread's own default agent (when the
   * thread exists and has one), else the configured default.
   */
  private async resolveAgentName(
    agentName: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    if (agentName !== undefined) {
      return agentName;
    }
    if (threadId !== undefined) {
      const reader = this.store.defaultAgentForThread?.bind(this.store);
      const threadDefault =
        reader !== undefined
          ? await reader(threadId)
          : ((await this.store.getThread(threadId))?.defaultAgent ?? null);
      if (threadDefault !== null && threadDefault !== undefined) {
        return threadDefault;
      }
    }
    return this.deps.defaultAgentName();
  }

  /**
   * The registered agents, for a picker (`GET <path>/agents`). With a model catalog, an agent it
   * locks to one model for this actor carries `lockedModel` — the same lock `GET <path>/models`
   * reports as `locked`.
   */
  async listAgents(actor: Actor): Promise<AgentCatalogEntry[]> {
    const defaultName = this.deps.defaultAgentName();
    const listed = this.deps.agentDefinitions();
    const entries: AgentCatalogEntry[] = listed.map((definition) => {
      const personas = this.deps.personaCatalog(definition.name);
      const defaultPersona = this.deps.defaultPersona(definition.name);
      return {
        name: definition.name,
        description: definition.description ?? '',
        ...(definition.name === defaultName ? { isDefault: true as const } : {}),
        ...(personas.length > 0 ? { personas } : {}),
        ...(defaultPersona !== undefined ? { defaultPersona } : {}),
      };
    });
    const all = entries.some((entry) => entry.name === defaultName)
      ? entries
      : [{ name: defaultName, description: '', isDefault: true as const }, ...entries];
    const models = this.options.models;
    if (models === undefined) {
      return all;
    }
    return Promise.all(
      all.map(async (entry) => {
        const locked = (await models.list({ actor, agent: entry.name })).locked;
        return locked !== undefined ? { ...entry, lockedModel: locked.model } : entry;
      }),
    );
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

  /** The queue service when the bound store can hold a queue, else `undefined`. */
  private queueing(): ChatQueueService | undefined {
    return this.options.queue?.supported === true ? this.options.queue : undefined;
  }

  /** The queue service, or a `501` naming what is missing. */
  private requireQueue(): ChatQueueService {
    const queue = this.queueing();
    if (queue === undefined) {
      throw new ChatQueueError(
        501,
        'Queueing messages requires an AgentStore that implements ChatQueueStore; the bound store does not.',
      );
    }
    return queue;
  }

  /**
   * Start a turn — for in-process callers that need a run id back. A send that would have to wait
   * (its thread already has a turn running) is refused with a `409 run_active`
   * {@link ChatQueueError} instead; {@link send} is the form that queues it.
   */
  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    const result = await this.sendTurn(withValidCapabilities({ ...params, mode: 'auto' }));
    if (result.queued !== true) {
      return result;
    }
    if (result.runId !== undefined) {
      // The thread freed up while it was being queued, and it started straight away.
      return { runId: result.runId, threadId: result.threadId };
    }
    // Take it back out, so this call has no effect — unless it started in the meantime.
    const queue = this.requireQueue();
    if (!(await queue.queueStore().removeQueuedMessage(result.messageId))) {
      return { runId: result.messageId, threadId: result.threadId };
    }
    await queue.publish(result.threadId);
    throw new ChatQueueError(
      409,
      `thread ${result.threadId} already has a turn running`,
      'run_active',
    );
  }

  /**
   * Send a message: start a turn, or — when its thread already has one running — queue the message
   * to run after it (see {@link ChatSendMode}). What `POST <path>/chat` calls.
   */
  async send(params: ChatParams): Promise<ChatSendResult> {
    params = withValidCapabilities(params);
    if (
      params.threadId !== undefined &&
      params.regenerate !== true &&
      this.options.actionProposals
    ) {
      const decision = await this.options.actionProposals.handleTextDecision(
        params.actor,
        params.threadId,
        params.message,
      );
      if ('proposalDecision' in decision) return decision;
    }
    return this.sendTurn(params);
  }

  /** Start or queue the turn itself — what a send is once it is not a text decision. */
  private async sendTurn(
    params: ChatParams,
  ): Promise<Exclude<ChatSendResult, ProposalDecisionSend>> {
    if (params.regenerate === true && params.threadId === undefined) {
      throw new RegenerateNeedsThreadError();
    }
    await this.assertWithinQuota(params.actor);
    // The send's own agent, else the thread's default agent, else the configured default — and a name
    // a persona took over (`Persona.aliases`) runs as the agent that owns it, under it.
    const target = this.deps.resolveAgent(
      await this.resolveAgentName(params.agentName, params.threadId),
    );
    const agentName = target.agentName;
    // Before the thread exists, so a refused persona, model or attachment leaves nothing behind.
    // Resolved to an id HERE, so the run's own input names it: a durable replay, or a queued message
    // started later, runs under the one this send resolved.
    const persona = await this.resolveSendPersona(
      agentName,
      params.personaId ?? target.persona,
      params.threadId,
    );
    const model = await this.resolveModel(params.actor, agentName, params.model, params.threadId);
    const attachments = await this.resolveAttachments(params.actor, params.attachments ?? []);
    let threadId = params.threadId;
    if (threadId === undefined) {
      const created = await this.store.createThread({
        actor: params.actor,
        // A persona the send NAMES is the person's pick for this conversation: pinned. One it fell
        // back to (the agent's default) is not, so a later change of default reaches the thread.
        ...(params.personaId !== undefined ? { persona: params.personaId } : {}),
        ...(params.transient === true ? { transient: true } : {}),
        ...(params.newThreadId !== undefined ? { id: params.newThreadId } : {}),
      });
      threadId = created.id;
    } else if (params.personaId !== undefined) {
      await this.pinThreadPersona(threadId, params.personaId);
    }

    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
      ...(persona !== undefined ? { persona } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
      ...(params.uiCapabilities !== undefined ? { uiCapabilities: params.uiCapabilities } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(params.regenerate === true ? { regenerate: true } : {}),
      ...(params.hostContext !== undefined ? { hostContext: params.hostContext } : {}),
    };

    const queue = this.queueing();
    if (queue === undefined) {
      // No admission to take: a store that predates the queue starts every send at once. The
      // runner marks the thread's active run itself, before the turn can end.
      const { runId } = await this.runner.start(input);
      return { runId, threadId };
    }

    const mode = params.mode ?? 'auto';
    const { live, stale } = await queue.holder(threadId, this.runner);
    if (stale !== null) {
      // The thread is still pointed at a run that is gone: settle what it left — its row, and any
      // call still showing an approval card — before another turn reads the thread.
      await settleDeadRun(this.store, { runId: stale, error: 'the run is no longer running' });
    }
    // `queue` always answers as a queued send (202), so a client that asked for it handles one
    // shape; an idle thread starts it straight away all the same (`enqueue` kicks the queue).
    if (live === null && mode !== 'queue') {
      const runId = this.runner.runIdFor?.(input) ?? crypto.randomUUID();
      if (
        await queue
          .queueStore()
          .claimActiveStream(threadId, runId, stale !== null ? { replacing: stale } : {})
      ) {
        return { runId: await this.startClaimed(queue, input, runId), threadId };
      }
      // Lost the race for the thread to another send: fall through and queue behind it.
    }
    if (params.regenerate === true) {
      throw new ChatQueueError(
        409,
        'cannot regenerate while a turn is running on this thread',
        'run_active',
      );
    }
    return this.enqueue(queue, input, mode, live);
  }

  /**
   * Start a turn the thread is already claimed for, under the claimed id. A runner that minted an
   * id of its own anyway gets the thread re-pointed at it; one that fails to start frees the thread.
   */
  private async startClaimed(
    queue: ChatQueueService,
    input: AgentRunInput,
    runId: string,
  ): Promise<string> {
    const store = queue.queueStore();
    let started: string;
    try {
      started = (await this.runner.start(input, { runId })).runId;
    } catch (error) {
      await store.releaseActiveStream(input.threadId, runId);
      throw error;
    }
    if (started !== runId) {
      await store.claimActiveStream(input.threadId, started, { replacing: runId });
    }
    return started;
  }

  /** Put a send in its thread's queue, then drain it if the thread turned out to be free. */
  private async enqueue(
    queue: ChatQueueService,
    input: AgentRunInput,
    mode: ChatSendMode,
    live: string | null,
  ): Promise<QueuedSend> {
    const store = queue.queueStore();
    const threadId = input.threadId;
    const interrupting = mode === 'interrupt' && live !== null ? live : undefined;
    const queued = await store.enqueueMessage({
      threadId,
      actor: input.actor,
      content: input.userText,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(typeof input.persona === 'string' ? { persona: input.persona } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
      ...(input.hostContext !== undefined ? { hostContext: input.hostContext } : {}),
      ...(interrupting !== undefined ? { interrupt: true, at: 'head' as const } : {}),
    });
    let runId: string | undefined;
    if (interrupting !== undefined) {
      // An interrupt is a person choosing to run this now: whatever paused the queue, they are
      // overriding it. The cancel settles into the queue, which starts this message.
      await store.setQueuePause(threadId, null);
      await queue.publish(threadId);
      await this.runner.cancel(interrupting);
    } else {
      // The run holding the thread may have settled between our look and our enqueue — its drain
      // then found nothing. Starting the head here covers that; with a live holder it does nothing.
      runId = await queue.kick(threadId, this.runner);
      if (runId === undefined) {
        await queue.publish(threadId);
      }
    }
    const state = await queue.state(threadId);
    const position = state.items.findIndex((item) => item.id === queued.id);
    return {
      threadId,
      queued: true,
      messageId: queued.id,
      position: position === -1 ? 0 : position,
      queue: state,
      ...(runId !== undefined && runId === queued.id ? { runId } : {}),
      ...(interrupting !== undefined ? { interrupting } : {}),
    };
  }

  /** Can this deployment queue messages (the store is a `ChatQueueStore` and a queue is wired)? */
  queueSupported(): boolean {
    return this.queueing() !== undefined;
  }

  /** `GET <path>/threads/:id/queue` — the thread's waiting messages and whether it drains. */
  getQueue(threadId: string): Promise<ChatQueueState> {
    return this.requireQueue().state(threadId);
  }

  /** The thread a queued message waits on — `null` when there is no such message. */
  async queuedMessageThread(messageId: string): Promise<string | null> {
    const message = await this.requireQueue().queueStore().getQueuedMessage(messageId);
    return message?.threadId ?? null;
  }

  /**
   * `PATCH <path>/queue/:messageId` — change a waiting message's text and/or attachments, and/or
   * move it to `position` in the queue. Answers the thread's queue.
   */
  async updateQueuedMessage(
    actor: Actor,
    messageId: string,
    patch: { message?: string; attachments?: AttachmentRef[] | null; position?: number },
  ): Promise<ChatQueueState> {
    const queue = this.requireQueue();
    const store = queue.queueStore();
    const current = await store.getQueuedMessage(messageId);
    if (current === null) {
      throw new ChatQueueError(404, `queued message ${messageId} not found`);
    }
    if (patch.message !== undefined && patch.message.trim().length === 0) {
      throw new ChatQueueError(400, 'message must not be empty');
    }
    if (patch.position !== undefined && (!Number.isInteger(patch.position) || patch.position < 0)) {
      throw new ChatQueueError(400, 'position must be a non-negative integer');
    }
    const attachments =
      patch.attachments === undefined || patch.attachments === null
        ? patch.attachments
        : await this.resolveAttachments(actor, patch.attachments);
    const gone = new ChatQueueError(
      410,
      `queued message ${messageId} already started or was removed`,
    );
    if (patch.message !== undefined || attachments !== undefined) {
      const updated = await store.updateQueuedMessage(messageId, {
        ...(patch.message !== undefined ? { content: patch.message } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      });
      if (updated === null) {
        throw gone;
      }
    }
    if (
      patch.position !== undefined &&
      !(await store.moveQueuedMessage(messageId, patch.position))
    ) {
      throw gone;
    }
    return queue.publish(current.threadId);
  }

  /**
   * `POST <path>/queue/:messageId/interrupt` — run a waiting message NOW: it moves to the head of
   * its queue as an interrupt, any pause is lifted, and the turn holding the thread is cancelled for
   * it (the cancel settles into the queue, which starts it). With nothing running it starts at once.
   *
   * One request rather than "remove it, then send it again with `mode: 'interrupt'`", because a
   * client cannot compose that safely: the message is lost if the second request fails, and runs
   * twice if another tab's drain starts it in between. Here it never leaves the queue. Answers the
   * queue, plus `interrupting` (the run that was cancelled) or `runId` (the run the message started
   * under — its own id).
   */
  async interruptQueuedMessage(
    messageId: string,
  ): Promise<ChatQueueState & { runId?: string; interrupting?: string }> {
    const queue = this.requireQueue();
    const store = queue.queueStore();
    const current = await store.getQueuedMessage(messageId);
    if (current === null) {
      throw new ChatQueueError(404, `queued message ${messageId} not found`);
    }
    const threadId = current.threadId;
    const gone = () =>
      new ChatQueueError(410, `queued message ${messageId} already started or was removed`);
    const marked = await store.updateQueuedMessage(messageId, { interrupt: true });
    if (marked === null) {
      throw gone();
    }
    if (marked.interrupt !== true) {
      // Cancelling for a message the store did not mark would pause the queue behind the cancel
      // instead of starting it — refuse before anything is cancelled.
      throw new ChatQueueError(
        501,
        'Interrupting a queued message requires a ChatQueueStore whose updateQueuedMessage stores `interrupt`; the bound store ignored it.',
      );
    }
    if (!(await store.moveQueuedMessage(messageId, 0))) {
      throw gone();
    }
    // A person choosing to run this now overrides whatever paused the queue.
    await store.setQueuePause(threadId, null);
    const { live } = await queue.holder(threadId, this.runner);
    if (live !== null && live !== messageId && (await store.getQueuedMessage(messageId)) !== null) {
      const state = await queue.publish(threadId);
      await this.runner.cancel(live);
      return { ...state, interrupting: live };
    }
    if (live !== null) {
      // The drain started it while this request was on its way: it is the running turn already.
      return { ...(await queue.state(threadId)), runId: messageId };
    }
    const runId = await queue.kick(threadId, this.runner);
    const state = runId === undefined ? await queue.publish(threadId) : await queue.state(threadId);
    return { ...state, ...(runId !== undefined ? { runId } : {}) };
  }

  /** `DELETE <path>/queue/:messageId` — drop a waiting message. Answers the thread's queue. */
  async removeQueuedMessage(messageId: string): Promise<ChatQueueState> {
    const queue = this.requireQueue();
    const store = queue.queueStore();
    const current = await store.getQueuedMessage(messageId);
    if (current === null) {
      throw new ChatQueueError(404, `queued message ${messageId} not found`);
    }
    if (!(await store.removeQueuedMessage(messageId))) {
      throw new ChatQueueError(410, `queued message ${messageId} already started or was removed`);
    }
    return queue.publish(current.threadId);
  }

  /** `DELETE <path>/threads/:id/queue` — drop every waiting message (and any pause). */
  async clearQueue(threadId: string): Promise<ChatQueueState> {
    const queue = this.requireQueue();
    await queue.queueStore().clearQueue(threadId);
    await queue.queueStore().setQueuePause(threadId, null);
    return queue.publish(threadId);
  }

  /**
   * `POST <path>/threads/:id/queue/resume` — lift a pause and start the head when nothing is
   * running. Answers the queue, and the run the head started under, if it did.
   */
  async resumeQueue(threadId: string): Promise<ChatQueueState & { runId?: string }> {
    const queue = this.requireQueue();
    await queue.queueStore().setQueuePause(threadId, null);
    const runId = await queue.kick(threadId, this.runner);
    const state = runId === undefined ? await queue.publish(threadId) : await queue.state(threadId);
    return { ...state, ...(runId !== undefined ? { runId } : {}) };
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

  /**
   * Is anything streaming (or buffered) under this run — or about to? `true` when the sink cannot
   * say.
   *
   * "About to": a run that holds its thread and has written nothing yet. It was admitted (a send, or
   * a queue drain handing the thread to the next message) and its body has not reached the sink — on
   * a durable runner, because no worker has picked it up. A client told that run started attaches
   * right then; answering "nothing to resume" would make it give up on a turn that is a moment from
   * streaming. The runner decides whether the holder is alive, as it does for admission: a claim
   * left by a process that died is not a stream.
   */
  async hasStream(runId: string): Promise<boolean> {
    const buffered = await this.deps.forAgent().sink.has?.(runId);
    if (buffered !== false) {
      return true;
    }
    const queue = this.queueing();
    const threadId = await this.store.threadHeldByRun?.(runId);
    if (queue === undefined || threadId === undefined || threadId === null) {
      return false;
    }
    return (await queue.holder(threadId, this.runner)).live === runId;
  }

  /**
   * The owning actor ref of a run (turn), or `null` if unknown — for per-actor route ownership
   * checks. A run that holds a thread but has not started executing has no row of its own yet (see
   * `AgentStore.threadHeldByRun`): its owner is the thread's.
   */
  async runOwner(runId: string): Promise<string | null> {
    const recorded = await this.store.getRunActorRef(runId);
    if (recorded !== null) {
      return recorded;
    }
    const threadId = await this.store.threadHeldByRun?.(runId);
    return threadId === undefined || threadId === null
      ? null
      : this.store.getThreadActorRef(threadId);
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
   * Refuse a decision addressed at a run that is over. The runtime would take the signal and buffer
   * it for a run that never comes back — the person's "yes" is accepted, the card says so, and
   * nothing runs. Settles what the dead run left behind on the way out. A runner that cannot say
   * whether a run is alive is taken at its word that it is.
   */
  private async assertRunWaiting(runId: string): Promise<void> {
    if (typeof this.runner.isRunActive !== 'function') {
      return;
    }
    const active = await this.runner.isRunActive(runId).catch(() => true);
    if (active) {
      return;
    }
    await settleDeadRun(this.store, { runId, error: 'the run is no longer running' });
    throw new RunNotActiveError(runId);
  }

  listActionProposals(actor: Actor, threadId: string) {
    if (!this.options.actionProposals)
      throw new ActionProposalServiceError(501, 'Independent proposals are unavailable');
    return this.options.actionProposals.list(actor, threadId);
  }
  listActionProposalsPage(
    actor: Actor,
    threadId: string,
    after?: import('./spi/action-proposal-store.js').ListActionProposals['after'],
  ) {
    if (!this.options.actionProposals)
      throw new ActionProposalServiceError(501, 'Independent proposals are unavailable');
    return this.options.actionProposals.listPage(actor, threadId, after);
  }
  decideActionProposal(
    actor: Actor,
    threadId: string,
    proposalId: string,
    decision: 'approved' | 'rejected',
    body: unknown,
    via = 'web',
  ) {
    if (!this.options.actionProposals)
      throw new ActionProposalServiceError(501, 'Independent proposals are unavailable');
    return this.options.actionProposals.decide(actor, threadId, proposalId, decision, body, via);
  }
  /** `actionApprovalMode` in `config/agent.ts` — `'blocking'` unless it says `'independent'`. */
  actionApprovalMode(): ActionApprovalMode {
    return typeof this.deps.actionApprovalMode === 'function'
      ? this.deps.actionApprovalMode()
      : 'blocking';
  }
  /**
   * The words a text decision is made of (`actionProposalText.vocabulary` over the English
   * defaults) — what a surface tells a person to reply, or what it maps a button to.
   */
  actionProposalVocabulary(): TextActionProposalVocabulary {
    return this.options.actionProposals?.vocabulary ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
  }
  /** The configured chat reply to a proposal decision (see `actionProposalText.replies`). */
  actionProposalReply(
    result: import('./spi/action-proposal-store.js').ActionProposalMutationResult,
    decision: 'approved' | 'rejected',
  ): string {
    return this.options.actionProposals
      ? this.options.actionProposals.reply(result, decision)
      : textActionProposalReply(result, decision);
  }
  handleTextDecision(actor: Actor, threadId: string, text: string) {
    if (!this.options.actionProposals) return Promise.resolve({ status: 'unmatched' as const });
    return this.options.actionProposals.handleTextDecision(actor, threadId, text);
  }

  /**
   * Approve a parked action call. `executedByRef` is who decided (the routes stamp the caller);
   * `remember` approves later calls of the same tool in the same thread; `via` names the surface the
   * decision came through (`'web'`, `'slack'`, …) — all persisted with the call.
   */
  async approve(
    runId: string,
    toolCallId: string,
    opts: { executedByRef?: string; remember?: boolean; via?: string } = {},
  ): Promise<void> {
    if ((await this.toolCallApproval(toolCallId))?.status === 'proposed')
      throw new ActionProposalServiceError(
        400,
        'Action proposals require a scoped proposal decision',
      );
    await this.assertRunWaiting(runId);
    return this.runner.signal(runId, toolCallId, {
      approved: true,
      ...(opts.executedByRef !== undefined ? { executedByRef: opts.executedByRef } : {}),
      ...(opts.remember === true ? { remember: true } : {}),
      ...(opts.via !== undefined ? { decidedVia: opts.via } : {}),
    });
  }

  async reject(
    runId: string,
    toolCallId: string,
    reason?: string,
    opts: { executedByRef?: string; via?: string } = {},
  ): Promise<void> {
    if ((await this.toolCallApproval(toolCallId))?.status === 'proposed')
      throw new ActionProposalServiceError(
        400,
        'Action proposals require a scoped proposal decision',
      );
    await this.assertRunWaiting(runId);
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

  async answer(args: {
    runId: string;
    toolCallId: string;
    answers: Record<string, string[]>;
    answeredByRef?: string;
    /** The surface the answer came through (`'web'`, `'slack'`, …) — an approval's `via`. */
    answeredVia?: string;
  }): Promise<void> {
    await this.assertRunWaiting(args.runId);
    return this.runner.signal(args.runId, args.toolCallId, {
      answers: args.answers,
      ...(args.answeredByRef !== undefined ? { answeredByRef: args.answeredByRef } : {}),
      ...(args.answeredVia !== undefined ? { answeredVia: args.answeredVia } : {}),
    });
  }

  /**
   * The user declined to answer and told the agent to proceed on its own assumptions. It lands on
   * the same values a confirmation would and persists as `rejected` rather than `executed`, because
   * proceeding on an assumption someone declined to confirm is a different fact from proceeding on
   * one they chose.
   */
  async skip(args: {
    runId: string;
    toolCallId: string;
    answeredByRef?: string;
    answeredVia?: string;
  }): Promise<void> {
    await this.assertRunWaiting(args.runId);
    return this.runner.signal(args.runId, args.toolCallId, {
      answers: {},
      skipped: true,
      ...(args.answeredByRef !== undefined ? { answeredByRef: args.answeredByRef } : {}),
      ...(args.answeredVia !== undefined ? { answeredVia: args.answeredVia } : {}),
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

  /**
   * `GET <path>/tools?agent=*`: the union of {@link toolCatalog} across the default agent and every
   * registered one — each tool this actor reaches through ANY of them, once (first agent wins its
   * entry), under the same gates.
   */
  async toolCatalogForAllAgents(actor: Actor): Promise<ToolCatalogEntry[]> {
    const names = [undefined, ...this.deps.agentDefinitions().map((definition) => definition.name)];
    const entries = new Map<string, ToolCatalogEntry>();
    for (const name of names) {
      for (const entry of await this.toolCatalog(actor, name)) {
        if (!entries.has(entry.name)) entries.set(entry.name, entry);
      }
    }
    return [...entries.values()];
  }

  /**
   * The persona `id` of `agentName` (default: the default agent), else its default persona — the
   * definition, for a caller that wants to read it. Unlike a send, an unknown `id` is not refused.
   */
  resolvePersona(agentName?: string, id?: string): Persona | undefined {
    const deps = this.deps.forAgent(agentName);
    return deps.personas.get(
      id ?? this.deps.defaultPersona(agentName ?? this.deps.defaultAgentName()) ?? '',
    );
  }

  /**
   * The agent and persona a queued message that carries no persona starts as: an agent name a
   * persona took over, then the thread's pin, then the agent's default — never refused. What the
   * provider hands the queue as `resolveTarget`.
   */
  async queuedTarget(message: {
    threadId: string;
    agentName?: string;
  }): Promise<{ agentName?: string; persona?: string }> {
    const target = this.deps.resolveAgent(message.agentName ?? this.deps.defaultAgentName());
    const persona =
      target.persona ??
      (this.deps.personaCatalog(target.agentName).length > 0
        ? this.deps.resolvePersona({
            agentName: target.agentName,
            threadPersona: await threadPersona(this.store, message.threadId),
          })
        : undefined);
    return {
      ...(message.agentName !== undefined ? { agentName: target.agentName } : {}),
      ...(persona !== undefined ? { persona } : {}),
    };
  }

  /** `agentName`'s personas (default: the default agent's) as a picker reads them. */
  personaCatalog(agentName?: string): PersonaCatalogEntry[] {
    return [...this.deps.forAgent(agentName).personas.values()].map(personaCatalogEntry);
  }

  async listThreads(actorRef: string): Promise<ThreadSummary[]> {
    return (await this.store.listThreads(actorRef)).map((thread) => this.withPinnedPersona(thread));
  }

  /**
   * A thread as the routes report it: a persona pin that no registered agent declares — a thread
   * created before pins existed holds whatever it was created with (`'default'`, most often), or the
   * persona was removed since — reads as `null`, which is what it resolves to.
   */
  private withPinnedPersona<T extends ThreadSummary>(thread: T): T {
    const pinned = thread.persona ?? null;
    if (pinned === null) {
      return thread.persona === null ? thread : { ...thread, persona: null };
    }
    const declared = this.deps
      .agentDefinitions()
      .some((definition) => this.deps.hasPersona(definition.name, pinned));
    return declared ? thread : { ...thread, persona: null };
  }

  /**
   * A thread as `actor` reads it back. Each attachment's url is re-minted by `mediaId` through the
   * attachment store: the one persisted with the message was minted for THAT turn (a signed url that
   * expires), so an old turn would otherwise show a dead link. One the store will not resolve for
   * this actor keeps the url it was stored with.
   */
  async getThread(threadId: string, actor?: Actor): Promise<ThreadDetail | null> {
    const read = await this.store.getThread(threadId);
    const stored = read === null ? null : this.withPinnedPersona(read);
    const queue = this.queueing();
    // The waiting messages ride along, so a reload shows them without a second request.
    const thread =
      stored !== null && queue !== undefined
        ? { ...stored, queue: await queue.state(threadId) }
        : stored;
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
   * The size cap and content types an attachment is held to — what the attachment store declares,
   * else the defaults (20 MiB; images, PDF, plain text, CSV). `null` when no attachment store is
   * configured, so nothing can be attached.
   */
  attachmentLimits(): AttachmentLimits | null {
    const staging = this.options.attachments;
    if (staging === undefined) return null;
    const declared = staging.describe?.() ?? {};
    return {
      maxBytes: declared.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
      allowedContentTypes: declared.allowedContentTypes ?? DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
    };
  }

  /**
   * Stage a file the server received itself (a channel's media message) for `actor`, held to the same
   * limits as `POST <path>/attachments` — then name it in a send as `{ mediaId }`. Refused
   * ({@link AttachmentRefusedError}) with `501` when no attachment store is configured, `415` for a
   * content type outside the allowlist, `413` past the size cap.
   */
  async stageAttachment(
    actor: Actor,
    file: { data: Buffer; filename: string; contentType: string },
  ): Promise<MessageAttachment> {
    const limits = this.attachmentLimits();
    const staging = this.options.attachments;
    if (limits === null || staging === undefined) {
      throw new AttachmentRefusedError(
        501,
        'Attachments are off: set `attachments` in config/agent.ts (e.g. attachmentStores.media()).',
      );
    }
    const contentType = file.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!limits.allowedContentTypes.includes(contentType)) {
      throw new AttachmentRefusedError(415, `content type "${contentType}" is not allowed`);
    }
    if (file.data.byteLength > limits.maxBytes) {
      throw new AttachmentRefusedError(413, `file exceeds the ${limits.maxBytes}-byte limit`);
    }
    return staging.stage({
      data: file.data,
      filename: file.filename,
      contentType,
      sizeBytes: file.data.byteLength,
      actor,
    });
  }

  /**
   * The Lucid database the agent's store writes to, or `null` when the store is not Lucid — what
   * shared state that should live next to the threads (a text channel's store) is built on.
   */
  lucidDatabase(): LucidDatabaseLike | null {
    return this.store instanceof LucidAgentStore ? this.store.database : null;
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

  /**
   * Every file this actor has staged, newest first — across threads, including uploads that were
   * never sent, which nothing else on this surface can see (`GET <path>/attachments`). Metadata only:
   * a url is minted per request by `resolve`, so it can stay short-lived.
   *
   * Refused ({@link AttachmentInventoryError}) when the configured attachment store keeps no
   * inventory (`AttachmentStagingStore.list`).
   */
  async listAttachments(
    actor: Actor,
    options: { limit?: number } = {},
  ): Promise<StagedAttachment[]> {
    const list = this.attachmentInventory();
    return list({ actor, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  }

  /**
   * This actor's staged media that no live message — and no message waiting in a thread's queue —
   * references, and that is old enough not to be an upload in flight: the candidate set for a sweep.
   * Returns them; never deletes them. The bytes are the host's, and so is the decision:
   *
   * ```ts
   * const service = await app.container.make(AgentService)
   * for (const file of await service.collectableAttachments(actor, { olderThan: subDays(new Date(), 7) })) {
   *   await media.delete(file.mediaId)
   * }
   * ```
   *
   * `olderThan` is required and has no default: how long a composer may sit open with a file attached
   * is the host's knowledge. The staging store is asked to apply it, and the result is filtered again
   * here — a store that ignored the hint would otherwise hand back an upload someone is about to send.
   *
   * Both halves must be answerable or this refuses ({@link AttachmentInventoryError}): an
   * unanswerable reference query means "cannot tell", and treating it as "nothing is referenced"
   * would mark every attachment the actor ever sent as safe to delete.
   */
  async collectableAttachments(
    actor: Actor,
    options: { olderThan: Date; limit?: number },
  ): Promise<StagedAttachment[]> {
    const list = this.attachmentInventory();
    const referencedMediaIds = this.store.referencedMediaIds?.bind(this.store);
    if (referencedMediaIds === undefined) {
      throw new AttachmentInventoryError(
        'Collecting attachments needs an AgentStore that implements referencedMediaIds(): the ' +
          'bound store cannot say which media a message still references, and guessing would ' +
          'delete files that are in use.',
      );
    }
    const stagedBefore = options.olderThan.toISOString();
    const inventory = await list({
      actor,
      stagedBefore,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    const aged = inventory.filter((entry) => entry.createdAt < stagedBefore);
    if (aged.length === 0) {
      return [];
    }
    const referenced = new Set(
      await referencedMediaIds(
        actor.id,
        aged.map((entry) => entry.mediaId),
      ),
    );
    return aged.filter((entry) => !referenced.has(entry.mediaId));
  }

  /** The configured store's `list`, or a refusal — never an empty inventory in its place. */
  private attachmentInventory(): (
    input: ListStagedAttachmentsInput,
  ) => Promise<StagedAttachment[]> {
    const staging = this.options.attachments;
    const list = staging?.list?.bind(staging);
    if (list === undefined) {
      throw new AttachmentInventoryError(
        staging === undefined
          ? 'Attachments are off: set `attachments` in config/agent.ts (e.g. attachmentStores.media()).'
          : 'Listing attachments needs an attachment store that implements list(); the host owns ' +
              'the staged bytes, so only its store can enumerate them.',
      );
    }
    return list;
  }

  renameThread(threadId: string, title: string): Promise<void> {
    return this.store.setTitle(threadId, title);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.store.softDeleteThread(threadId);
  }

  /**
   * Make a transient thread a regular one (listed by {@link listThreads}). `false` when the store
   * cannot — it has no `promoteThread`.
   */
  async promoteThread(threadId: string): Promise<boolean> {
    if (this.store.promoteThread === undefined) {
      return false;
    }
    await this.store.promoteThread(threadId);
    return true;
  }

  /**
   * Drop a message and everything after it — the "edit and resend" primitive: the client then sends
   * a fresh turn on the shortened thread.
   */
  truncateThreadFrom(threadId: string, messageId: string): Promise<void> {
    return this.store.truncateFrom(threadId, messageId);
  }

  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    return this.store.forkThread(threadId, fromMessageId);
  }

  async quotaToday(actorRef: string): Promise<{ usedTokens: number }> {
    return this.store.quotaToday(actorRef, utcDay());
  }
}

/** `params` with its `uiCapabilities` validated (a `TypeError` when malformed). */
function withValidCapabilities(params: ChatParams): ChatParams {
  return params.uiCapabilities === undefined
    ? params
    : { ...params, uiCapabilities: validateUiCapabilities(params.uiCapabilities) };
}
