import { utcDay } from './agent-deps.js';
import type { AgentDepsFactory } from './agent-deps-factory.js';
import type { AgentRunner } from './spi/agent-runner.js';
import type { AgentStore } from './spi/agent-store.js';
import type { StreamFrame } from './spi/token-stream-sink.js';
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
  threadOwner(threadId: string): Promise<string | null> {
    return this.store.getThreadActorRef(threadId);
  }

  approve(runId: string, toolCallId: string): Promise<void> {
    return this.runner.signal(runId, toolCallId, { approved: true });
  }

  reject(runId: string, toolCallId: string, reason?: string): Promise<void> {
    return this.runner.signal(runId, toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  cancel(runId: string): Promise<void> {
    return this.runner.cancel(runId);
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
