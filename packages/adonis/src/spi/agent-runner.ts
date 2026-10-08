import type { HumanReply } from '../elicitation.js';
import type { AgentRunInput } from '../types.js';

/**
 * Runs an agent turn. Two impls exist:
 *  - InlineAgentRunner (default): the loop runs in-process — no extra dependencies. This is what
 *    the provider builds unless `durable: true` is set.
 *  - DurableAgentRunner (opt-in via `durable: true`): the turn is an `@adonis-agora/durable`
 *    {@link import('../durable/agent-run-workflow.js').AgentRunWorkflow}, so each model/tool call is
 *    a checkpointed step and HITL is `ctx.waitForSignal`.
 *
 * `start` ENQUEUES and returns immediately with the runId — the live tokens flow on the
 * TokenStreamSink, not through this call.
 */
/** How {@link AgentRunner.start} starts a run. */
export interface AgentRunStartOptions {
  /**
   * Use this id for the run instead of minting one. The chat queue claims the thread for a run
   * BEFORE starting it (so no second turn can slip in between), which needs the id up front; a
   * queued message's run id is the message's own id, which also makes a retried start idempotent.
   * A runner that ignores it still works — the service then re-points the thread at the id it
   * returned.
   */
  runId?: string;
}

export interface AgentRunner {
  start(input: AgentRunInput, options?: AgentRunStartOptions): Promise<{ runId: string }>;
  /**
   * OPTIONAL: the id a run of `input` should have, when the caller mints one before starting it (a
   * send claims its thread under the id first). A runner whose ids carry meaning — a tenant prefix
   * its durable store partitions by — answers here. Absent → a random UUID.
   */
  runIdFor?(input: AgentRunInput): string;
  /**
   * OPTIONAL: whether `runId` is still running (or parked, or about to start) as far as this runner
   * can tell. Asked when a thread's admission is held by a run, to tell a live holder from a stale
   * one a crashed process left behind — a stale holder is replaced instead of queueing behind it
   * for ever. Answer `true` when unsure: a wrong `false` starts a second turn on the thread. Absent
   * → every holder is treated as live.
   */
  isRunActive?(runId: string): Promise<boolean>;
  /**
   * Deliver a human's reply to a parked tool call — an approve/reject {@link import('../types.js').Decision}
   * for an `action`, or an {@link import('../elicitation.js').ElicitationReply} for a question set.
   * One channel for both, because a question set parks as a `pending_approval` action and therefore
   * reaches a run through the inbox a deployment already has.
   *
   * A `Decision` reaching a question set is the documented reduction ("confirmed the pre-picked
   * answers"). The reverse is not: answers carry no `approved`, so an implementation that can tell
   * which wait it is settling MUST refuse them with
   * {@link import('../elicitation.js').HumanReplyMismatchError} rather than deliver them. An
   * implementation that cannot tell delivers, and the loop discards the reply and stays parked —
   * either way, no rejection is recorded against a human who only submitted a form.
   */
  signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void>;
  cancel(runId: string): Promise<void>;
  /**
   * OPTIONAL: execute in this process what of `runId` waits for a worker to pick it up — the run
   * while it is not started yet, and the delegates it waits on — unless another process already
   * holds it. Returns once that is set going, not once it ends. For a caller that waits on the run
   * while being, itself, the work a worker is busy with (a channel job reading the turn it started):
   * the run would otherwise wait for that worker. Absent → runs only where the runner sends them.
   */
  drive?(runId: string): Promise<void>;
}
