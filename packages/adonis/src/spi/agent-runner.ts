import type { HumanReply } from '../elicitation.js';
import type { AgentRunInput } from '../types.js';

/**
 * Runs an agent turn. Two impls exist:
 *  - InlineAgentRunner (default): the loop runs in-process — no extra dependencies. This is what
 *    `AGENT_RUNNER` binds to unless `durable: true` is set.
 *  - DurableAgentRunner (opt-in via `durable: true`): the turn is a `@dudousxd/nestjs-durable`
 *    `@Workflow`, so each model/tool call is a checkpointed step and HITL is `ctx.waitForSignal`.
 *
 * `start` ENQUEUES and returns immediately with the runId — the live tokens flow on the
 * TokenStreamSink, not through this call.
 */
export interface AgentRunner {
  start(input: AgentRunInput): Promise<{ runId: string }>;
  /**
   * Deliver a human's reply to a parked tool call — an approve/reject {@link import('../types.js').Decision}
   * for an `action`, or an {@link import('../elicitation.js').ElicitationReply} for a question set.
   * One channel for both, because a question set parks as a `pending_approval` action and therefore
   * reaches a run through the inbox a deployment already has.
   */
  signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void>;
  cancel(runId: string): Promise<void>;
}
