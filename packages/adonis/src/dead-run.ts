import { RUN_ENDED_BEFORE_TOOL_CALL } from './dangling-tool-calls.js';
import type { AgentStore } from './spi/agent-store.js';
import { releaseThreadRun } from './spi/chat-queue.js';

/**
 * Leave nothing waiting on a run that is over and did not say so itself.
 *
 * A run normally settles its own row, its calls and its thread from inside its body. One that is
 * refused a checkpoint position, or whose worker died, never gets there: its row stays `running`,
 * a call it had put to a person stays `pending_approval` — an approval card that takes a "yes" and
 * then does nothing, for ever — and its thread stays pointed at it. Everything here is written
 * straight to the store, outside any checkpoint, because the callers are exactly the paths that
 * have no journal left to write to; each write is idempotent (first-terminal run row, only
 * still-pending calls, a release conditional on the holder), so doing it twice changes nothing.
 *
 * Best-effort on purpose: this runs while something else is already failing, and must not replace
 * that failure with one of its own.
 */
export async function settleDeadRun(
  store: AgentStore,
  args: { runId: string; threadId?: string; error: string; errorCode?: string },
): Promise<void> {
  await store
    .recordRunEnd({
      runId: args.runId,
      status: 'failed',
      error: args.error,
      // A run found dead has no error of its own to code: the generic crash, like its stream's.
      errorCode: args.errorCode ?? 'run_failed',
    })
    .catch(() => undefined);
  await store.failUnsettledToolCalls?.(args.runId, RUN_ENDED_BEFORE_TOOL_CALL).catch(() => 0);
  if (args.threadId !== undefined) {
    await releaseThreadRun(store, args.threadId, args.runId).catch(() => undefined);
  }
}

/** `approve` / `reject` / `answer` addressed at a run that is no longer running. */
export class RunNotActiveError extends Error {
  readonly status = 409;
  readonly code = 'run_not_active';
  constructor(readonly runId: string) {
    super(
      'This request is no longer waiting for an answer: the turn it belonged to has ended. Send the message again.',
    );
    this.name = 'RunNotActiveError';
  }
}
