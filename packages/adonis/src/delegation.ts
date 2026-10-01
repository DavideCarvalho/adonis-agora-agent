import type { AgentStore } from './spi/agent-store.js';
import type { DetachedDelivery } from './types.js';

/*
 * Detached delegation's receipts and outcomes — after `delegation.ts` in
 * `@dudousxd/nestjs-agent-core`, field for field: the shared React client
 * (`backgroundRunsFromThread`) reads these shapes off a thread, so they are wire, not internals.
 */

/**
 * What a detached delegation hands the model in place of an answer. Its `status` is the whole point:
 * a model that is given an object shaped like a result will report one, and this run has none yet.
 */
export interface DetachedDelegationReceipt {
  detached: true;
  status: 'started';
  /** The agent now working on it. */
  agent: string;
  /** The run doing the work — what a client subscribes to, and what stamps the delivered message. */
  runId: string;
  /**
   * The same fact in the only vocabulary the model reliably acts on: prose in a tool result. The
   * structured fields above are for a client; this is for the turn that has to explain itself to a
   * user without claiming a result it does not hold.
   */
  note: string;
}

/** How a detached delegation ended, written back onto its tool-call row once the run settles. */
export interface DetachedDelegationOutcome {
  detached: true;
  status: 'delivered' | 'failed' | 'cancelled';
  agent: string;
  runId: string;
  /** The delivered answer. Present on `delivered` only. */
  text?: string;
  /** Why it did not deliver. Present on `failed` only. */
  error?: string;
}

/** The receipt an `agent`-kind call returns the moment its delegate is under way. */
export function detachedStarted(args: { agent: string; runId: string }): DetachedDelegationReceipt {
  return {
    detached: true,
    status: 'started',
    agent: args.agent,
    runId: args.runId,
    note: `The "${args.agent}" agent is now working on this in the background. Its answer is NOT part of this turn and will arrive in this conversation as a separate message when it is ready. Tell the user the work has started; do not state or guess what it will find.`,
  };
}

/** The outcome written onto the delegating tool call when a detached run finishes its answer. */
export function detachedDelivered(args: {
  agent: string;
  runId: string;
  text: string;
}): DetachedDelegationOutcome {
  return {
    detached: true,
    status: 'delivered',
    agent: args.agent,
    runId: args.runId,
    text: args.text,
  };
}

/**
 * The outcome written onto the delegating tool call when a detached run never produced an answer.
 * Written by the RUNNER, not the loop: a run that crashed or was stopped cannot record its own ending.
 */
export function detachedUnsettled(args: {
  agent: string;
  runId: string;
  status: 'failed' | 'cancelled';
  error?: string;
}): DetachedDelegationOutcome {
  return {
    detached: true,
    status: args.status,
    agent: args.agent,
    runId: args.runId,
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
}

/**
 * Settle the delegation a detached run was started for, when that run ends with no answer.
 *
 * Two writes, because a reader needs both: the tool-call row, so a governance surface stops counting
 * it as in flight, and a MESSAGE in the delegating thread, so the person who asked finds out. A
 * delivered answer already arrives as a message; without this, failure is the one outcome that
 * silently never does, and the conversation shows "started" for ever.
 *
 * Called by the RUNNER, never the loop. Skipped when the thread is gone (as delivery is), and when the
 * thread already holds a message from this run — so a second settle is a no-op.
 */
export async function settleUnsettledDelegation(args: {
  store: AgentStore;
  delivery: DetachedDelivery;
  agent: string;
  runId: string;
  status: 'failed' | 'cancelled';
  error?: string;
}): Promise<void> {
  const { store, delivery, agent, runId, status } = args;
  const thread = await store.getThread(delivery.threadId);
  // Gone, or already told: a run posts into the delegating thread once, whichever path settles it
  // (its own answer, its failure, or a Stop that reached the runner after the body had ended).
  if (thread === null || thread.messages.some((message) => message.runId === runId)) {
    return;
  }
  await store.appendMessage({
    threadId: delivery.threadId,
    role: 'assistant',
    content:
      status === 'cancelled'
        ? `The "${agent}" agent was stopped before it could answer.`
        : `The "${agent}" agent stopped before it could answer: ${args.error ?? 'unknown error'}`,
    agentName: agent,
    runId,
  });
  await store.updateToolCall({
    toolCallId: delivery.toolCallId,
    status: 'executed',
    output: detachedUnsettled({
      agent,
      runId,
      status,
      ...(args.error !== undefined ? { error: args.error } : {}),
    }),
  });
}
