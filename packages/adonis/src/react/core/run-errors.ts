import type { AgentRequestError } from './http-error.js';

/**
 * The `code`s this library's own loop closes a failed run's stream with (`event: error`). A client
 * branches on the code and words the failure itself — the frame's `message` is a sentence in
 * English, and for a crash deliberately a generic one.
 *
 *  - `quota_exceeded` — the actor's budget is spent; `message` says which.
 *  - `output_rejected` — an output processor refused the answer.
 *  - `structured_output_invalid` — the answer never satisfied the agent's output schema.
 *  - `replay_diverged` — the durable runtime refused to resume the run (its journal and the
 *    deployed code disagree). The turn is over; sending again starts a new one.
 *  - `model_no_output` — a model call ended without producing anything.
 *  - `run_failed` — anything else.
 *
 * A host's own runner may send codes of its own, which is why {@link AgentRunFailure.code} is a
 * plain string.
 */
export const AGENT_RUN_ERROR_CODES = [
  'quota_exceeded',
  'output_rejected',
  'structured_output_invalid',
  'replay_diverged',
  'model_no_output',
  'run_failed',
] as const;

export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODES)[number];

/** How a run's stream said it failed: the `event: error` frame, read. */
export interface AgentRunFailure {
  /** The frame's machine-readable `code`; `undefined` when the server sent none. */
  code: AgentRunErrorCode | (string & {}) | undefined;
  /** The frame's `message` — the server's words, safe to show but not translated. */
  message: string;
  /** The run that failed, when the stream had named it. */
  runId?: string;
}

/** The `code` a decision is refused with when the run it was for has ended (`409`). */
export const RUN_NOT_ACTIVE_CODE = 'run_not_active';

/**
 * Whether `error` is the server refusing an approve / reject / answer / skip because the turn that
 * asked is over (`409 { code: 'run_not_active' }`): nothing is waiting for the decision, and nothing
 * will run. The card it was made on is stale — say so, and let the person send the message again.
 */
export function isRunNotActiveError(error: unknown): error is AgentRequestError {
  return (
    error instanceof Error &&
    (error as Partial<AgentRequestError>).status === 409 &&
    (error as Partial<AgentRequestError>).code === RUN_NOT_ACTIVE_CODE
  );
}
