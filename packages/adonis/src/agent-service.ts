import { utcDay } from './agent-deps.js';
import type { AgentDepsFactory } from './agent-deps-factory.js';
import type { AgentRunner } from './spi/agent-runner.js';
import type { AgentStore } from './spi/agent-store.js';
import {
  type ApprovalDecisionRef,
  mayDecideApproval,
  type ToolCallApprovalState,
} from './spi/approval-policy.js';
import type { StreamFrame } from './spi/token-stream-sink.js';
import type { ToolCatalogEntry } from './tool-presentation.js';
import type {
  Actor,
  AgentRunInput,
  MessageAttachment,
  PageContext,
  Persona,
  ThreadDetail,
  ThreadSummary,
} from './types.js';

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  personaId?: string;
  pageContext?: PageContext;
  /**
   * Already-staged attachments (image/PDF) for this message — each an `{ mediaId, url, contentType,
   * name }` produced by the `POST /agent/attachments` upload route (or the host's own staging). The
   * lib never fetches bytes; the model adapter renders them as native content parts from `url`.
   */
  attachments?: MessageAttachment[];
}

/**
 * The framework-agnostic orchestration facade the `/agent` routes call: start a run, subscribe to
 * its live token stream, deliver HITL decisions, and read/mutate threads. It owns no HTTP — the
 * provider's route handlers resolve the actor and pipe the SSE, then delegate here.
 */
export class AgentService {
  constructor(
    private readonly runner: AgentRunner,
    private readonly store: AgentStore,
    private readonly deps: AgentDepsFactory,
  ) {}

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    const agentName = params.agentName ?? this.deps.defaultAgentName();
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
      ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
    };

    const { runId } = await this.runner.start(input);
    await this.store.setActiveStream(threadId, runId);
    return { runId, threadId };
  }

  subscribe(runId: string): AsyncIterable<StreamFrame> {
    return this.deps.forAgent().sink.subscribe(runId);
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

  getThread(threadId: string): Promise<ThreadDetail | null> {
    return this.store.getThread(threadId);
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
