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
