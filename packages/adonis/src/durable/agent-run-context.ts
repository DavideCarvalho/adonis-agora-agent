import type { WorkflowEngine } from '@adonis-agora/durable';
import type { AgentDepsFactory } from '../agent-deps-factory.js';
import type { ChatQueueService } from '../chat-queue-service.js';
import type { AgentStore } from '../spi/agent-store.js';

/**
 * The runtime graph the durable {@link import('./agent-run-workflow.js').AgentRunWorkflow} body needs.
 *
 * A durable workflow class is instantiated by the engine with NO constructor arguments (see the
 * durable lib's `registerWorkflowClass`), so — unlike the NestJS reference, which injected these via
 * DI — the AdonisJS workflow reads them from this module-level holder instead. The provider populates
 * it once at boot (and a test sets it directly), mirroring the durable lib's own
 * `setWorkflowEngineResolver` seam. Re-read on every replay (it's a pure lookup, no side effect), so
 * it stays deterministic.
 */
export interface DurableAgentContext {
  factory: AgentDepsFactory;
  store: AgentStore;
  /**
   * The thread message queue a settling turn hands its thread to. Set on every pod of a deployment
   * or on none: whether a turn writes the queue checkpoints must not depend on which pod replays it.
   */
  queue?: ChatQueueService;
  /**
   * The engine a DETACHED delegation is started on, as a run of its own (not a `spawn:` child, which
   * a Stop on the delegating turn would cascade to). The provider sets it. Absent, the engine
   * `registerAgentWorkflow` was last called with is used — every wiring calls it — and failing that,
   * `AgentRunWorkflow.dispatch` from outside the ambient ctx, which resolves the engine the way any
   * `BaseWorkflow` static does.
   */
  engine?: WorkflowEngine;
}

let current: DurableAgentContext | undefined;

/** Install (or clear, with `undefined`) the durable agent context. Called by the provider at boot. */
export function setDurableAgentContext(context: DurableAgentContext | undefined): void {
  current = context;
}

/**
 * The installed {@link DurableAgentContext}. Throws if the durable runner was reached without the
 * provider having wired it — a misconfiguration, never a normal path.
 */
export function getDurableAgentContext(): DurableAgentContext {
  if (current === undefined) {
    throw new Error(
      '[@adonis-agora/agent] durable agent context is not set — the durable runner was used before ' +
        'the provider wired it (call setDurableAgentContext during boot).',
    );
  }
  return current;
}

let registered: WorkflowEngine | undefined;
const engineListeners = new Set<(engine: WorkflowEngine) => void>();

/** @internal Recorded by `registerAgentWorkflow`: the engine the agent workflow runs on. */
export function rememberAgentEngine(engine: WorkflowEngine | undefined): void {
  registered = engine;
  if (engine === undefined) return;
  for (const listener of engineListeners) listener(engine);
}

/**
 * @internal The engine the agent's durable runner was wired on (`durable: true`), if it was — what
 * the text channels run their inbound messages on.
 */
export function registeredAgentEngine(): WorkflowEngine | undefined {
  return registered;
}

/**
 * @internal Be told when the agent's durable engine is wired (now, when it already is). Returns an
 * unsubscribe function.
 */
export function onAgentEngine(listener: (engine: WorkflowEngine) => void): () => void {
  engineListeners.add(listener);
  if (registered !== undefined) listener(registered);
  return () => engineListeners.delete(listener);
}

/** @internal The engine a detached delegation starts on — see {@link DurableAgentContext.engine}. */
export function agentEngine(context: DurableAgentContext): WorkflowEngine | undefined {
  return context.engine ?? registered;
}
